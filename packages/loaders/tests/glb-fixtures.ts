/** Фикстуры GLB для тестов gltf и registry. */

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

/** Собирает валидный GLB 2.0 (JSON-чанк с паддингом + BIN-чанк). */
export function buildGlb(json: object, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const pad = (4 - (jsonBytes.length % 4)) % 4
  const jsonChunkLength = jsonBytes.length + pad
  const total = 12 + 8 + jsonChunkLength + 8 + bin.length
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, GLB_MAGIC, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonChunkLength, true)
  dv.setUint32(16, CHUNK_JSON, true)
  out.set(jsonBytes, 20)
  for (let i = 0; i < pad; i++) out[20 + jsonBytes.length + i] = 0x20
  const binHeader = 20 + jsonChunkLength
  dv.setUint32(binHeader, bin.length, true)
  dv.setUint32(binHeader + 4, CHUNK_BIN, true)
  out.set(bin, binHeader + 8)
  return out
}

/** BIN: 3 позиции VEC3 float + 3 индекса ushort. */
export function triBin(): Uint8Array {
  const bin = new Uint8Array(42)
  const dv = new DataView(bin.buffer)
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0]
  positions.forEach((value, i) => dv.setFloat32(i * 4, value, true))
  dv.setUint16(36, 0, true)
  dv.setUint16(38, 1, true)
  dv.setUint16(40, 2, true)
  return bin
}

/** Минимальный glTF-документ: сцена → узел → меш (треугольник) + материал MASK. */
export function triDocument(): Record<string, unknown> {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'root', mesh: 0 }],
    meshes: [
      { name: 'tri', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    ],
    materials: [
      {
        name: 'mask',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 0, 0, 0.5],
          metallicFactor: 0.1,
          roughnessFactor: 0.9,
        },
        alphaMode: 'MASK',
        alphaCutoff: 0.42,
        doubleSided: true,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        count: 3,
        type: 'VEC3',
        componentType: 5126,
        min: [-1, -1, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, count: 3, type: 'SCALAR', componentType: 5123 },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: 42 }],
  }
}
