import { test, expect } from 'bun:test'
import { Assembler } from '../src/assembler.ts'
import { parseObj, type ObjModel } from '../src/obj.ts'
import { parseMtl, parseMtlText, type MtlModel } from '../src/mtl.ts'

function assemblerOf(text: string, total?: number): Assembler {
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Assembler(stream, { total })
}

const CUBE = `
# вершины куба
v -1 -1 -1
v  1 -1 -1
v  1  1 -1
v -1  1 -1
v -1 -1  1
v  1 -1  1
v  1  1  1
v -1  1  1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 -1
vn 0 0 1
vn 0 -1 0
vn 0 1 0
vn -1 0 0
vn 1 0 0
o cube
usemtl crate
f 1/1/1 2/2/1 3/3/1 4/4/1
f 5/1/2 8/2/2 7/3/2 6/4/2
f 1/1/3 5/2/3 6/3/3 2/4/3
f 2/1/4 6/2/4 7/3/4 3/4/4
f 3/1/5 7/2/5 8/3/5 4/4/5
f 4/1/6 8/2/6 5/3/6 1/4/6
mtllib crate.mtl
`

test('parseObj: куб — вершины, UV, нормали, группы, mtllib', async () => {
  const model: ObjModel = await parseObj(assemblerOf(CUBE, CUBE.length))
  expect(model.kind).toBe('obj')
  // 6 граней-квадратов веером → 12 треугольников → 36 expanded-вершин
  expect(model.vertexCount).toBe(36)
  expect(model.positions.length).toBe(108)
  expect(model.stats.vertices).toBe(8)
  expect(model.stats.triangles).toBe(12)
  expect(model.groups).toHaveLength(1)
  expect(model.groups[0].name).toBe('cube')
  expect(model.groups[0].material).toBe('crate')
  expect(model.groups[0].vertexStart).toBe(0)
  expect(model.groups[0].vertexCount).toBe(36)
  expect(model.mtllib).toBe('crate.mtl')
  expect(model.uvs).not.toBeNull()
  expect(model.uvs!.length).toBe(72)
  // нормали заданы (vn) — не плоские; строк распарсено ровно 28
  expect(model.stats.lines).toBe(28)
})

test('parseObj: стриминг кусками и CRLF — результат идентичен', async () => {
  const bytes = new TextEncoder().encode(CUBE.replace(/\n/g, '\r\n'))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 11)
        controller.enqueue(bytes.subarray(at, at + 11))
      controller.close()
    },
  })
  const model = await parseObj(new Assembler(stream, { total: bytes.length }))
  expect(model.vertexCount).toBe(36)
  expect(model.groups).toHaveLength(1)
  // последняя строка без терминатора тоже разбирается
  expect(model.mtllib).toBe('crate.mtl')
})

test('parseObj: без vn — плоские нормали; без vt — uvs null', async () => {
  const model = await parseObj(assemblerOf('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'))
  expect(model.uvs).toBeNull()
  expect(model.vertexCount).toBe(3)
  // плоская нормаль треугольника в плоскости XY → (0,0,1)
  expect(Array.from(model.normals.slice(0, 3))).toEqual([0, 0, 1])
})

test('parseObj: отрицательные (относительные) индексы', async () => {
  const model = await parseObj(assemblerOf('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n'))
  expect(model.vertexCount).toBe(3)
  expect(Array.from(model.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
})

test('parseObj: несколько групп и смена usemtl', async () => {
  const model = await parseObj(
    assemblerOf(
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 2 0 0\ng a\nf 1 2 3\nusemtl red\ng b\nf 1 3 4\n',
    ),
  )
  expect(model.groups).toHaveLength(2)
  expect(model.groups[0]).toMatchObject({ name: 'a', material: null, vertexStart: 0, vertexCount: 3 })
  expect(model.groups[1]).toMatchObject({ name: 'b', material: 'red', vertexStart: 3, vertexCount: 3 })
})

// ─── MTL ──────────────────────────────────────────────────────────────────────

const MTL = `
# комментарий
newmtl crate
Kd 0.8 0.6 0.4
Ka 0.1 0.1 0.1
Ks 0.2 0.2 0.2
Ns 96.0
d 0.75
illum 2
map_Kd -s 1 1 1 -o 0 0 0 crate_diffuse.png
bump crate_normal.png

newmtl ghost
Tr 0.6
map_d alpha.png
`

test('parseMtl: материалы, прозрачность, пути текстур', () => {
  const model: MtlModel = parseMtlText(MTL)
  expect(model.kind).toBe('mtl')
  expect(model.materials).toHaveLength(2)
  const crate = model.get('crate')
  expect(crate).toBeDefined()
  expect(crate!.diffuse).toEqual([0.8, 0.6, 0.4])
  expect(crate!.ambient).toEqual([0.1, 0.1, 0.1])
  expect(crate!.specular).toEqual([0.2, 0.2, 0.2])
  expect(crate!.shininess).toBe(96)
  expect(crate!.opacity).toBeCloseTo(0.75)
  expect(crate!.illum).toBe(2)
  // опции map_Kd отрезаются — остаётся чистый путь
  expect(crate!.mapKd).toBe('crate_diffuse.png')
  expect(crate!.mapBump).toBe('crate_normal.png')

  const ghost = model.get('ghost')
  expect(ghost).toBeDefined()
  // Tr = 0.6 → opacity 0.4
  expect(ghost!.opacity).toBeCloseTo(0.4)
  expect(ghost!.mapD).toBe('alpha.png')
  expect(model.stats.materials).toBe(2)
  expect(model.stats.withMapKd).toBe(1)
})

test('parseMtl: байты → та же модель', () => {
  const bytes = new TextEncoder().encode(MTL)
  const model = parseMtl(bytes)
  expect(model.materials).toHaveLength(2)
  expect(model.get('crate')!.mapKd).toBe('crate_diffuse.png')
})
