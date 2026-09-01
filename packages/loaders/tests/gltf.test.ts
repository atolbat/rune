import { test, expect } from 'bun:test'
import { Assembler } from '../src/assembler.ts'
import { isGltfJson, parseGlb, parseGltfJson, type GltfModel } from '../src/gltf.ts'

import { buildGlb, triBin, triDocument } from './glb-fixtures.ts'

function assemblerOf(bytes: Uint8Array, total?: number): Assembler {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Assembler(stream, { total })
}

// ─── GLB: счастливый путь (content-length известен → zero-copy) ─────────────

test('parseGlb: треугольник + материал MASK + статистика', async () => {
  const glb = buildGlb(triDocument(), triBin())
  const model: GltfModel = await parseGlb(assemblerOf(glb, glb.length))
  expect(model.kind).toBe('glb')
  expect(model.meshes).toHaveLength(1)
  const primitive = model.meshes[0].primitives[0]
  expect(Array.from(primitive.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
  expect(primitive.indices).toBeInstanceOf(Uint16Array)
  expect(Array.from(primitive.indices as Uint16Array)).toEqual([0, 1, 2])
  expect(primitive.vertexCount).toBe(3)
  expect(primitive.material).toBe(0)
  // bounds из метаданных аксессора
  expect(primitive.bounds.min).toEqual([-1, -1, 0])
  expect(primitive.bounds.max).toEqual([1, 1, 0])

  const material = model.materials[0]
  expect(material.alphaMode).toBe('MASK')
  expect(material.alphaCutoff).toBeCloseTo(0.42)
  expect(material.doubleSided).toBe(true)
  expect(material.baseColorFactor).toEqual([1, 0, 0, 0.5])
  expect(material.metallicFactor).toBeCloseTo(0.1)
  expect(material.roughnessFactor).toBeCloseTo(0.9)
  expect(material.unlit).toBe(false)

  expect(model.sceneRoots).toEqual([0])
  expect(model.nodes[0].mesh).toBe(0)
  expect(model.nodes[0].name).toBe('root')

  expect(model.stats.vertices).toBe(3)
  expect(model.stats.triangles).toBe(1)
  expect(model.stats.primitives).toBe(1)
  expect(model.stats.binBytes).toBe(42)
  // zero-copy: плотный FLOAT-аксессор и ushort-индексы — виды над телом
  expect(model.stats.zeroCopyViews).toBeGreaterThanOrEqual(2)
})

test('parseGlb: без content-length — тот же результат через копии', async () => {
  const glb = buildGlb(triDocument(), triBin())
  const model = await parseGlb(assemblerOf(glb))
  const primitive = model.meshes[0].primitives[0]
  expect(Array.from(primitive.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
  expect(Array.from(primitive.indices as Uint16Array)).toEqual([0, 1, 2])
})

test('parseGlb: чанки по кусочкам — стриминг не ломается', async () => {
  const glb = buildGlb(triDocument(), triBin())
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // режем на мелкие куски: заголовок/JSON/BIN вперемешку
      for (let at = 0; at < glb.length; at += 7) controller.enqueue(glb.subarray(at, at + 7))
      controller.close()
    },
  })
  const assembler = new Assembler(stream, { total: glb.length })
  const model = await parseGlb(assembler)
  expect(model.meshes[0].primitives[0].vertexCount).toBe(3)
})

// ─── GLB: ошибки ──────────────────────────────────────────────────────────────

test('parseGlb: не-GLB магик — понятная ошибка', async () => {
  const garbage = new Uint8Array(64)
  expect(parseGlb(assemblerOf(garbage, garbage.length))).rejects.toThrow('не GLB')
})

test('parseGlb: версия 3 не поддерживается', async () => {
  const glb = buildGlb(triDocument(), triBin())
  new DataView(glb.buffer).setUint32(4, 3, true)
  expect(parseGlb(assemblerOf(glb, glb.length))).rejects.toThrow('GLB версии 3')
})

test('parseGlb: extensionsRequired с meshopt — честный отказ', async () => {
  const doc = triDocument()
  doc['extensionsRequired'] = ['EXT_meshopt_compression']
  const glb = buildGlb(doc, triBin())
  expect(parseGlb(assemblerOf(glb, glb.length))).rejects.toThrow('glTF требует EXT_meshopt_compression')
})

test('parseGlb: Draco без декодера — подсказка в ошибке', async () => {
  const doc = triDocument()
  doc['extensionsRequired'] = ['KHR_draco_mesh_compression']
  const glb = buildGlb(doc, triBin())
  expect(parseGlb(assemblerOf(glb, glb.length))).rejects.toThrow('dracoDecoder')
})

// ─── Изображения: ленивый декод ──────────────────────────────────────────────

test('parseGlb: изображение в BIN декодится createBitmap-ом', async () => {
  const pngMagic = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const bin = new Uint8Array(42 + pngMagic.length)
  bin.set(triBin())
  bin.set(pngMagic, 42)
  const doc = triDocument()
  doc['bufferViews'] = [
    ...doc['bufferViews'] as unknown[],
    { buffer: 0, byteOffset: 42, byteLength: pngMagic.length },
  ]
  doc['images'] = [{ name: 'tex', mimeType: 'image/png', bufferView: 2 }]
  doc['buffers'] = [{ byteLength: bin.length }]
  const glb = buildGlb(doc, bin)

  let captured: { bytes: Uint8Array; mime: string } | undefined
  const fakeBitmap = { width: 4, height: 2, close: () => {} } as unknown as ImageBitmap
  const model = await parseGlb(assemblerOf(glb, glb.length), {
    createBitmap: async (bytes, mime) => {
      captured = { bytes, mime }
      return fakeBitmap
    },
  })
  expect(model.images).toHaveLength(1)
  await model.whenImagesDecoded()
  const bitmap = await model.images[0].bitmap
  expect(bitmap).toBe(fakeBitmap)
  expect(captured?.mime).toBe('image/png')
  expect(Array.from(captured?.bytes ?? [])).toEqual(Array.from(pngMagic))
  expect(model.images[0].name).toBe('tex')
})

// ─── .gltf (JSON + внешние буферы) ───────────────────────────────────────────

test('parseGltfJson: внешний буфер + внешняя текстура', async () => {
  const doc = JSON.parse(JSON.stringify(triDocument())) as Record<string, unknown>
  ;(doc['buffers'] as Array<Record<string, unknown>>)[0] = { uri: 'tri.bin' }
  doc['images'] = [{ name: 'ext', mimeType: 'image/png', uri: 'tex.png' }]

  const pngMagic = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const externalFiles: Record<string, Uint8Array> = {
    'https://example.com/tri.bin': triBin(),
    'https://example.com/tex.png': pngMagic,
  }
  const fakeBitmap = { width: 8, height: 8, close: () => {} } as unknown as ImageBitmap
  let decoded = 0
  const model = await parseGltfJson(JSON.stringify(doc), {
    loadExternal: async (uri) => {
      const resolved = new URL(uri, 'https://example.com/x.gltf').toString()
      return externalFiles[resolved] ?? new Uint8Array(0)
    },
  }, {
    createBitmap: async () => {
      decoded++
      return fakeBitmap
    },
  })
  expect(model.kind).toBe('gltf')
  const primitive = model.meshes[0].primitives[0]
  expect(Array.from(primitive.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
  expect(model.stats.binBytes).toBe(42)
  await model.whenImagesDecoded()
  expect(decoded).toBe(1)
  expect(await model.images[0].bitmap).toBe(fakeBitmap)
})

test('isGltfJson: магика JSON-чанка GLB', () => {
  expect(isGltfJson(new TextEncoder().encode('glTF 2.0...'))).toBe(true)
  expect(isGltfJson(new TextEncoder().encode('{"a":1}'))).toBe(false)
  expect(isGltfJson(new Uint8Array(2))).toBe(false)
})
