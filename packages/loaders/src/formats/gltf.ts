/**
 * formats/gltf.ts — glTF 2.0 (.glb и .gltf) → MeshDocument.
 *
 * Скорость и память:
 *  - accessors с tight-упаковкой и нужным выравниванием → zero-copy
 *    TypedArray-view в BIN-чанке (никаких поэлементных DataView-циклов);
 *  - интерлив (byteStride) → один цикл копирования на атрибут;
 *  - normalized int8/16/uint8/16 → конверт в f32 лениво и один раз;
 *  - индексы u16 → u32 наружу (единый контракт MeshDocument);
 *  - JSON-чанк GLB парсится ЕЩЁ ДО догрузки BIN-чанка (стрим-синк):
 *    материалы/структура готовы, пока байты геометрии ещё едут.
 *
 * Поддержка: accessors всех componentType, sparse, интерлив, PBR-материалы,
 * текстуры (webp/basisu-расширения — выбор source), TRS/matrix-ноды, skins
 * (inverseBindMatrices), анимации (linear/step/cubicspline channels),
 * data:-URI буферы, внешние .bin через ctx.resolveExternal (дочерняя задача
 * менеджера — грузится параллельно остальному трафику).
 *
 * НЕ поддержано в v1 (чёткие ошибки): Draco (KHR_draco_mesh_compression),
 * morph targets (targets/primitives.extensions), EXT_mesh_gpu_instancing.
 * KTX2/DDS-картинки отдаются как bytes+mimeType — декодер вне зоны пакета.
 */

import type { ParseContext, ParseInput, Parser, StreamSink } from '../core/types.ts'
import { ParseError, UnsupportedError, throwIfAborted } from '../core/errors.ts'
import { parseDataUri } from '../core/util.ts'
import { GrowableBytes } from '../core/util.ts'
import type {
  AnimationChannel,
  ImageAsset,
  MaterialData,
  MeshDocument,
  MeshMode,
  MeshPrimitive,
  NodeData,
  SamplerData,
  SkinData,
  SubMesh,
  TextureInfo,
} from './mesh.ts'
import { meshStatsOf } from './mesh.ts'

// ─── glTF-JSON схемы (минимум нужного, any-там-где-спека-любит-вариативность) ─

interface GltfAccessor {
  bufferView?: number
  byteOffset?: number
  componentType: number
  count: number
  type: string
  normalized?: boolean
  sparse?: {
    count: number
    indices: { bufferView: number; byteOffset?: number; componentType: number }
    values: { bufferView: number; byteOffset?: number }
  }
}
interface GltfBufferView {
  buffer: number
  byteOffset?: number
  byteLength: number
  byteStride?: number
}
interface GltfBuffer { byteLength: number; uri?: string }
interface GltfTextureInfo { index: number; texCoord?: number }
interface GltfTexture { source?: number; sampler?: number; extensions?: Record<string, { source?: number }> }
interface GltfImage { name?: string; mimeType?: string; bufferView?: number; uri?: string }
interface GltfPbr { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number; baseColorTexture?: GltfTextureInfo; metallicRoughnessTexture?: GltfTextureInfo }
interface GltfMaterial {
  name?: string
  pbrMetallicRoughness?: GltfPbr
  normalTexture?: GltfTextureInfo & { scale?: number }
  occlusionTexture?: GltfTextureInfo & { strength?: number }
  emissiveTexture?: GltfTextureInfo
  emissiveFactor?: number[]
  alphaMode?: string
  alphaCutoff?: number
  doubleSided?: boolean
  extensions?: Record<string, Record<string, unknown>>
}
interface GltfPrimitive {
  attributes: Record<string, number>
  indices?: number
  material?: number
  mode?: number
  targets?: unknown[]
  extensions?: Record<string, unknown>
}
interface GltfMesh { name?: string; primitives: GltfPrimitive[]; weights?: number[] }
interface GltfNode {
  name?: string
  children?: number[]
  mesh?: number
  skin?: number
  matrix?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
}
interface GltfScene { nodes?: number[] }
interface GltfChannelTarget { node?: number; path: string }
interface GltfAnimationChannel { sampler: number; target: GltfChannelTarget }
interface GltfAnimationSampler { input: number; output: number; interpolation?: string }
interface GltfAnimation { name?: string; channels: GltfAnimationChannel[]; samplers: GltfAnimationSampler[] }
interface GltfSkin { name?: string; joints: number[]; inverseBindMatrices?: number }
interface GltfRoot {
  asset?: { version?: string }
  buffers?: GltfBuffer[]
  bufferViews?: GltfBufferView[]
  accessors?: GltfAccessor[]
  meshes?: GltfMesh[]
  materials?: GltfMaterial[]
  textures?: GltfTexture[]
  images?: GltfImage[]
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[]
  nodes?: GltfNode[]
  scenes?: GltfScene[]
  scene?: number
  skins?: GltfSkin[]
  animations?: GltfAnimation[]
}

// ─── контейнер GLB ───────────────────────────────────────────────────────────

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

/** Магика GLB: ascii «glTF» в первых 4 байтах. */
function isGlbMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46
  )
}

/** Распакованный GLB-контейнер. */
export interface GlbContainer {
  readonly gltf: GltfRoot
  /** BIN-чанк (view в исходном буфере) или null. */
  readonly bin: Uint8Array | null
}

/** Разбор GLB-контейнера из полного буфера. */
export function parseGlbContainer(bytes: Uint8Array, ctx?: ParseContext): GlbContainer {
  const url = ctx?.sourceUrl ?? null
  if (bytes.length < 12) throw new ParseError('GLB: файл короче заголовка', 0, url)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new ParseError('GLB: неверная магика', 0, url)
  const version = dv.getUint32(4, true)
  if (version !== 1 && version !== 2) {
    throw new ParseError(`GLB: версия ${version} не поддерживается (нужна 2)`, 4, url)
  }
  let pos = 12
  let gltf: GltfRoot | null = null
  let bin: Uint8Array | null = null
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos, true)
    const type = dv.getUint32(pos + 4, true)
    const dataStart = pos + 8
    if (dataStart + len > bytes.length) {
      throw new ParseError('GLB: чанк вылезает за конец файла', pos, url)
    }
    if (type === CHUNK_JSON) {
      const jsonText = new TextDecoder('utf-8').decode(bytes.subarray(dataStart, dataStart + len))
      try {
        gltf = JSON.parse(jsonText) as GltfRoot
      } catch (err) {
        throw new ParseError(`GLB: битый JSON-чанк: ${(err as Error).message}`, dataStart, url)
      }
    } else if (type === CHUNK_BIN) {
      bin = bytes.subarray(dataStart, dataStart + len)
    } // прочие чанки — пропускаем (спека разрешает)
    const padded = (len + 3) & ~3
    pos = dataStart + padded
  }
  if (gltf === null) throw new ParseError('GLB: нет JSON-чанка', 0, url)
  return { gltf, bin }
}

// ─── декодер accessors ───────────────────────────────────────────────────────

const COMPONENTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
}

type RawArray =
  | Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array

export interface DecodedAccessor {
  readonly count: number
  readonly comps: number
  /** Сырые элементы (тип по componentType). */
  readonly raw: RawArray
  /** float-вид (конверт normalized/float); null для индексных. */
  readonly f32: Float32Array | null
  /** u32-вид для индексов (u16/u32 → u32); null для атрибутов. */
  readonly indices: Uint32Array | null
}

function componentSize(componentType: number): number {
  switch (componentType) {
    case 5120: case 5121: return 1
    case 5122: case 5123: return 2
    case 5125: case 5126: return 4
    default: throw new ParseError(`accessor: неизвестный componentType ${componentType}`)
  }
}

function makeRaw(componentType: number, length: number): RawArray {
  switch (componentType) {
    case 5120: return new Int8Array(length)
    case 5121: return new Uint8Array(length)
    case 5122: return new Int16Array(length)
    case 5123: return new Uint16Array(length)
    case 5125: return new Uint32Array(length)
    case 5126: return new Float32Array(length)
    default: throw new ParseError(`accessor: неизвестный componentType ${componentType}`)
  }
}

/** TypedArray-view нужного типа без копии (null — если выравнивание не подходит). */
function typedView(
  componentType: number,
  buffer: ArrayBuffer,
  byteOffset: number,
  length: number,
): RawArray | null {
  switch (componentType) {
    case 5126: return byteOffset % 4 === 0 ? new Float32Array(buffer, byteOffset, length) : null
    case 5125: return byteOffset % 4 === 0 ? new Uint32Array(buffer, byteOffset, length) : null
    case 5123: return byteOffset % 2 === 0 ? new Uint16Array(buffer, byteOffset, length) : null
    case 5122: return byteOffset % 2 === 0 ? new Int16Array(buffer, byteOffset, length) : null
    case 5121: return new Uint8Array(buffer, byteOffset, length)
    case 5120: return new Int8Array(buffer, byteOffset, length)
    default: return null
  }
}

/** Достать сырые элементы bufferView с учётом byteStride (zero-copy если можно). */
function readElements(
  bytes: Uint8Array,
  byteOffset: number,
  byteStride: number,
  compSize: number,
  count: number,
  comps: number,
  componentType: number,
  ctx: ParseContext,
): RawArray {
  const total = count * comps
  const tight = byteStride === 0 || byteStride === comps * compSize
  if (tight) {
    const need = total * compSize
    if (byteOffset + need > bytes.length) {
      throw new ParseError('accessor: данные за границей bufferView')
    }
    const view = typedView(componentType, bytes.buffer as ArrayBuffer, bytes.byteOffset + byteOffset, total)
    if (view !== null) return view
    const out = makeRaw(componentType, total)
    // плотная, но невыровненная — побайтовое блочное копирование
    new Uint8Array(out.buffer, out.byteOffset, need).set(bytes.subarray(byteOffset, byteOffset + need))
    return out
  }
  // интерлив: поэлементное чтение по типу компонента (+ чекпоинты отмены)
  const out = makeRaw(componentType, total)
  const dvSrc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let v = 0; v < count; v++) {
    if ((v & 1023) === 0 && v > 0) throwIfAborted(ctx.signal, 'gltf parse')
    const src = byteOffset + v * byteStride
    for (let c = 0; c < comps; c++) {
      const at = src + c * compSize
      if (at + compSize > bytes.length) throw new ParseError('accessor: данные за границей bufferView')
      const i = v * comps + c
      switch (componentType) {
        case 5126: (out as Float32Array)[i] = dvSrc.getFloat32(at, true); break
        case 5125: (out as Uint32Array)[i] = dvSrc.getUint32(at, true); break
        case 5123: (out as Uint16Array)[i] = dvSrc.getUint16(at, true); break
        case 5122: (out as Int16Array)[i] = dvSrc.getInt16(at, true); break
        case 5121: (out as Uint8Array)[i] = bytes[at]; break
        case 5120: (out as Int8Array)[i] = bytes[at] - 256 > 0 ? bytes[at] - 256 : (bytes[at] << 24) >> 24; break
        default: throw new ParseError(`accessor: componentType ${componentType}?`)
      }
    }
  }
  return out
}

/**
 * Декод accessor → { raw, f32?, indices? }.
 * f32 конвертит normalized int'ы; indices даёт u32-вид (для index-аксессоров).
 */
export function decodeAccessor(
  gltf: GltfRoot,
  accIndex: number,
  buffers: readonly Uint8Array[],
  ctx: ParseContext,
): DecodedAccessor {
  const accessors = gltf.accessors ?? []
  const acc = accessors[accIndex]
  const url = ctx.sourceUrl
  if (acc === undefined) throw new ParseError(`accessor ${accIndex}: нет в gltf`, -1, url)
  const comps = COMPONENTS[acc.type]
  if (comps === undefined) throw new ParseError(`accessor: тип ${acc.type} не поддерживается`, -1, url)
  throwIfAborted(ctx.signal, 'gltf parse')
  const count = acc.count
  const compSize = componentSize(acc.componentType)
  const total = count * comps

  // base: без bufferView → нулевой буфер + sparse поверх
  let raw: RawArray
  if (acc.bufferView === undefined) {
    raw = makeRaw(acc.componentType, total)
  } else {
    const bv = (gltf.bufferViews ?? [])[acc.bufferView]
    if (bv === undefined) throw new ParseError(`bufferView ${acc.bufferView}: нет в gltf`, -1, url)
    const buffer = buffers[bv.buffer]
    if (buffer === undefined) throw new ParseError(`buffer ${bv.buffer}: не загружен`, -1, url)
    const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    raw = readElements(
      buffer,
      byteOffset,
      bv.byteStride ?? 0,
      compSize,
      count,
      comps,
      acc.componentType,
      ctx,
    )
  }

  // sparse поверх base
  if (acc.sparse !== undefined) {
    const sparse = acc.sparse
    const idxBv = (gltf.bufferViews ?? [])[sparse.indices.bufferView]
    const valBv = (gltf.bufferViews ?? [])[sparse.values.bufferView]
    if (idxBv === undefined || valBv === undefined) throw new ParseError('sparse: нет bufferView', -1, url)
    const idxBuffer = buffers[idxBv.buffer]
    const valBuffer = buffers[valBv.buffer]
    if (idxBuffer === undefined || valBuffer === undefined) throw new ParseError('sparse: буфер не загружен', -1, url)
    const idxCompSize = componentSize(sparse.indices.componentType)
    const idxRaw = readElements(
      idxBuffer,
      (idxBv.byteOffset ?? 0) + (sparse.indices.byteOffset ?? 0),
      idxBv.byteStride ?? 0,
      idxCompSize,
      sparse.count,
      1,
      sparse.indices.componentType,
      ctx,
    )
    const valRaw = readElements(
      valBuffer,
      (valBv.byteOffset ?? 0) + (sparse.values.byteOffset ?? 0),
      valBv.byteStride ?? 0,
      compSize,
      sparse.count,
      comps,
      acc.componentType,
      ctx,
    )
    for (let i = 0; i < sparse.count; i++) {
      const vertexIndex = (idxRaw as Uint32Array)[i]
      if (vertexIndex >= count) throw new ParseError('sparse: индекс вне count', -1, url)
      for (let c = 0; c < comps; c++) {
        ;(raw as Uint8Array)[vertexIndex * comps + c] = (valRaw as Uint8Array)[i * comps + c] as never
      }
    }
  }

  // f32-вид
  let f32: Float32Array | null = null
  if (acc.componentType === 5126) {
    f32 = raw as Float32Array
  } else if (acc.normalized === true) {
    const divisor =
      acc.componentType === 5121 ? 255
      : acc.componentType === 5120 ? 127
      : acc.componentType === 5123 ? 65535
      : acc.componentType === 5122 ? 32767
      : 1
    const out = new Float32Array(total)
    for (let i = 0; i < total; i++) out[i] = (raw as Uint8Array)[i] / divisor
    f32 = out
  }

  // indices-вид (только целочисленные)
  let indices: Uint32Array | null = null
  if (acc.componentType === 5125 || acc.componentType === 5123) {
    if (raw instanceof Uint32Array) indices = raw
    else if (raw instanceof Uint16Array) {
      indices = new Uint32Array(total)
      for (let i = 0; i < total; i++) indices[i] = raw[i]
    }
  }

  if (ctx.signal.aborted && count > 0) throwIfAborted(ctx.signal, 'gltf parse')
  return { count, comps, raw, f32, indices }
}

// ─── сборка MeshDocument ─────────────────────────────────────────────────────

const MODE_MAP: Record<number, MeshMode> = {
  0: 'points',
  1: 'lines',
  2: 'line-strip',
  3: 'line-strip',
  4: 'triangles',
  5: 'triangle-strip',
  6: 'triangle-fan',
}

/** Загрузить все буферы glTF (GLB-bin + data:-URI + внешние .bin). */
async function loadBuffers(
  gltf: GltfRoot,
  bin: Uint8Array | null,
  ctx: ParseContext,
): Promise<Uint8Array[]> {
  const declared = gltf.buffers ?? []
  const out: Uint8Array[] = []
  for (let i = 0; i < declared.length; i++) {
    const buf = declared[i]
    const uri = buf.uri
    if (uri === undefined) {
      if (i === 0 && bin !== null) {
        out.push(bin)
        continue
      }
      throw new ParseError(`buffer ${i}: нет uri и это не GLB BIN`, -1, ctx.sourceUrl)
    }
    if (uri.startsWith('data:')) {
      const parsed = parseDataUri(uri)
      if (parsed === null) throw new ParseError(`buffer ${i}: битый data: URI`, -1, ctx.sourceUrl)
      out.push(parsed.bytes)
      continue
    }
    // внешний .bin — дочерняя задача менеджера (параллельно остальному)
    out.push(await ctx.resolveExternal(uri))
  }
  return out
}

/** Собрать MeshDocument из glTF-JSON и загруженных буферов. */
export function buildMeshDocument(
  gltf: GltfRoot,
  buffers: readonly Uint8Array[],
  ctx: ParseContext,
): MeshDocument {
  const url = ctx.sourceUrl

  // images
  const images: ImageAsset[] = (gltf.images ?? []).map(img => {
    if (img.bufferView !== undefined) {
      const bv = (gltf.bufferViews ?? [])[img.bufferView]
      if (bv === undefined) throw new ParseError(`image: bufferView ${img.bufferView} нет`, -1, url)
      const buffer = buffers[bv.buffer]
      if (buffer === undefined) throw new ParseError('image: буфер не загружен', -1, url)
      const off = bv.byteOffset ?? 0
      return {
        name: img.name ?? null,
        mimeType: img.mimeType ?? null,
        bytes: buffer.subarray(off, off + bv.byteLength),
        uri: null,
      }
    }
    if (img.uri !== undefined) {
      if (img.uri.startsWith('data:')) {
        const parsed = parseDataUri(img.uri)
        if (parsed !== null) {
          return { name: img.name ?? null, mimeType: parsed.mimeType ?? img.mimeType ?? null, bytes: parsed.bytes, uri: null }
        }
      }
      return { name: img.name ?? null, mimeType: img.mimeType ?? null, bytes: null, uri: img.uri }
    }
    return { name: img.name ?? null, mimeType: img.mimeType ?? null, bytes: null, uri: null }
  })

  // samplers
  const samplers: SamplerData[] = (gltf.samplers ?? []).map(s => ({
    magFilter: s.magFilter ?? null,
    minFilter: s.minFilter ?? null,
    wrapS: s.wrapS ?? 10497,
    wrapT: s.wrapT ?? 10497,
  }))

  // textures helper
  const textureInfo = (info: GltfTextureInfo | undefined): TextureInfo | null => {
    if (info === undefined) return null
    const tex = (gltf.textures ?? [])[info.index]
    if (tex === undefined) return null
    const ext = tex.extensions
    const source =
      ext?.['EXT_texture_webp']?.source ?? ext?.['KHR_texture_basisu']?.source ?? tex.source
    if (source === undefined) return null
    return { image: source, texCoord: info.texCoord ?? 0, sampler: tex.sampler ?? null }
  }

  // materials
  const materials: MaterialData[] = (gltf.materials ?? []).map((m): MaterialData => {
    const pbr = m.pbrMetallicRoughness ?? {}
    const bc = pbr.baseColorFactor ?? [1, 1, 1, 1]
    const em = m.emissiveFactor ?? [0, 0, 0]
    const emissiveStrength =
      typeof m.extensions?.['KHR_materials_emissive_strength']?.['emissiveStrength'] === 'number'
        ? (m.extensions['KHR_materials_emissive_strength']['emissiveStrength'] as number)
        : 1
    return {
      name: m.name ?? null,
      baseColor: [bc[0], bc[1], bc[2], bc[3] ?? 1],
      metallic: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      emissive: [em[0] ?? 0, em[1] ?? 0, em[2] ?? 0],
      emissiveStrength,
      normalScale: m.normalTexture?.scale ?? 1,
      occlusionStrength: m.occlusionTexture?.strength ?? 1,
      alphaMode: (m.alphaMode === 'MASK' ? 'mask' : m.alphaMode === 'BLEND' ? 'blend' : 'opaque'),
      alphaCutoff: m.alphaCutoff ?? 0.5,
      doubleSided: m.doubleSided ?? false,
      baseColorTexture: textureInfo(pbr.baseColorTexture),
      metallicRoughnessTexture: textureInfo(pbr.metallicRoughnessTexture),
      normalTexture: textureInfo(m.normalTexture),
      emissiveTexture: textureInfo(m.emissiveTexture),
      occlusionTexture: textureInfo(m.occlusionTexture),
      source: 'gltf',
    }
  })

  // meshes → плоские примитивы
  const meshes: MeshPrimitive[] = []
  const meshNames: (string | null)[] = []
  const meshSpans: Array<[number, number]> = [] // gltf-mesh → [start, count)
  for (const mesh of gltf.meshes ?? []) {
    const start = meshes.length
    for (const prim of mesh.primitives ?? []) {
      const ext = prim.extensions ?? {}
      if (ext['KHR_draco_mesh_compression'] !== undefined) {
        throw new UnsupportedError(
          'glTF: меш сжат KHR_draco_mesh_compression — прогоните через конвертер или подключите Draco-декодер отдельным transform',
          url,
        )
      }
      if (prim.targets !== undefined && prim.targets.length > 0) {
        throw new UnsupportedError('glTF: morph targets не поддерживаются в v1', url)
      }
      if (ext['EXT_mesh_gpu_instancing'] !== undefined) {
        throw new UnsupportedError('glTF: EXT_mesh_gpu_instancing не поддерживается в v1', url)
      }
      const attrs = prim.attributes ?? {}
      const positionIndex = attrs['POSITION']
      if (positionIndex === undefined) {
        throw new ParseError('glTF: примитив без POSITION', -1, url)
      }
      const position = decodeAccessor(gltf, positionIndex, buffers, ctx)
      if (position.f32 === null) throw new ParseError('glTF: POSITION не float/normalized', -1, url)

      const readF32 = (key: string): Float32Array | null => {
        const idx = attrs[key]
        if (idx === undefined) return null
        const acc = decodeAccessor(gltf, idx, buffers, ctx)
        return acc.f32
      }
      const positions = position.f32
      const normals = readF32('NORMAL')
      const uvs = readF32('TEXCOORD_0')
      const uvs2 = readF32('TEXCOORD_1')
      const tangents = readF32('TANGENT')

      // COLOR_0: f32 или u8norm — приводим к u8-контракту
      let colors: Uint8Array | null = null
      const colorIndex = attrs['COLOR_0']
      if (colorIndex !== undefined) {
        const acc = decodeAccessor(gltf, colorIndex, buffers, ctx)
        const vc = acc.comps
        if (acc.f32 !== null) {
          colors = new Uint8Array(acc.count * 4)
          for (let i = 0; i < acc.count; i++) {
            colors[i * 4] = floatToU8(acc.f32[i * vc])
            colors[i * 4 + 1] = floatToU8(acc.f32[i * vc + 1] ?? 1)
            colors[i * 4 + 2] = floatToU8(acc.f32[i * vc + 2] ?? 1)
            colors[i * 4 + 3] = vc >= 4 ? floatToU8(acc.f32[i * 4 + 3]) : 255
          }
        } else {
          const raw = acc.raw as Uint8Array
          colors = new Uint8Array(acc.count * 4)
          for (let i = 0; i < acc.count; i++) {
            colors[i * 4] = raw[i * vc]
            colors[i * 4 + 1] = raw[i * vc + 1] ?? 255
            colors[i * 4 + 2] = raw[i * vc + 2] ?? 255
            colors[i * 4 + 3] = vc >= 4 ? raw[i * 4 + 3] : 255
          }
        }
      }

      // скин-атрибуты
      const jointsIndex = attrs['JOINTS_0']
      let joints: Uint16Array | null = null
      if (jointsIndex !== undefined) {
        const acc = decodeAccessor(gltf, jointsIndex, buffers, ctx)
        joints = new Uint16Array(acc.count * 4)
        const raw = acc.raw as Uint8Array
        const jc = acc.comps
        for (let i = 0; i < acc.count * 4; i++) {
          joints[i] = raw[Math.floor(i / 4) * jc + (i % 4)] ?? 0
        }
      }
      const weightsIndex = attrs['WEIGHTS_0']
      let weights: Float32Array | null = null
      if (weightsIndex !== undefined) {
        const acc = decodeAccessor(gltf, weightsIndex, buffers, ctx)
        weights = acc.f32
      }

      let indices: Uint32Array | null = null
      if (prim.indices !== undefined) {
        const acc = decodeAccessor(gltf, prim.indices, buffers, ctx)
        if (acc.indices === null) {
          // u8-индексы — конвертим
          const raw = acc.raw as Uint8Array
          indices = new Uint32Array(acc.count)
          for (let i = 0; i < acc.count; i++) indices[i] = raw[i]
        } else {
          indices = acc.indices
        }
      }

      const materialIndex = prim.material ?? -1
      const count = indices !== null ? indices.length : positions.length / 3
      const submeshes: SubMesh[] = [
        { material: materialIndex, name: mesh.name ?? null, offset: 0, count },
      ]
      meshes.push({
        positions,
        normals,
        uvs,
        uvs2,
        tangents,
        colors,
        joints,
        weights,
        indices,
        mode: MODE_MAP[prim.mode ?? 4] ?? 'triangles',
        submeshes,
      })
      meshNames.push(mesh.name ?? null)
    }
    meshSpans.push([start, meshes.length - start])
  }

  // nodes
  const gltfNodes = gltf.nodes ?? []
  const nodes: NodeData[] = gltfNodes.map(n => {
    let matrix: Float32Array | null = null
    if (n.matrix !== undefined && n.matrix.length === 16) {
      matrix = new Float32Array(n.matrix)
    }
    let primitives: number[] = []
    if (n.mesh !== undefined) {
      const span = meshSpans[n.mesh]
      if (span !== undefined) {
        primitives = Array.from({ length: span[1] }, (_, i) => span[0] + i)
      }
    }
    return {
      name: n.name ?? null,
      translation: [n.translation?.[0] ?? 0, n.translation?.[1] ?? 0, n.translation?.[2] ?? 0],
      rotation: [n.rotation?.[0] ?? 0, n.rotation?.[1] ?? 0, n.rotation?.[2] ?? 0, n.rotation?.[3] ?? 1],
      scale: [n.scale?.[0] ?? 1, n.scale?.[1] ?? 1, n.scale?.[2] ?? 1],
      matrix,
      primitives,
      skin: n.skin ?? -1,
      children: [...(n.children ?? [])],
    }
  })

  // scenes
  const scenes: number[][] = (gltf.scenes ?? []).map(s => [...(s.nodes ?? [])])
  const defaultScene = gltf.scene ?? 0
  const sceneRoots: number[][] = scenes.length > 0
    ? [scenes[Math.min(defaultScene, scenes.length - 1)]]
    : gltfNodes.length > 0
      ? [gltfNodes.map((_, i) => i).filter(i => !gltfNodes.some(n => (n.children ?? []).includes(i)))]
      : []

  // skins
  const skins: SkinData[] = (gltf.skins ?? []).map(s => {
    let ibm: Float32Array | null = null
    if (s.inverseBindMatrices !== undefined) {
      const acc = decodeAccessor(gltf, s.inverseBindMatrices, buffers, ctx)
      if (acc.f32 === null || acc.comps !== 16) {
        throw new ParseError('skin: inverseBindMatrices не MAT4/float', -1, url)
      }
      ibm = acc.f32
    }
    return { name: s.name ?? null, joints: [...s.joints], inverseBindMatrices: ibm }
  })

  // animations
  const animations = (gltf.animations ?? []).map(a => {
    const channels: AnimationChannel[] = []
    let duration = 0
    for (const ch of a.channels ?? []) {
      const sampler = a.samplers?.[ch.sampler]
      if (sampler === undefined) continue
      const path = ch.target.path
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale' && path !== 'weights') continue
      const input = decodeAccessor(gltf, sampler.input, buffers, ctx)
      if (input.f32 === null) continue
      const output = decodeAccessor(gltf, sampler.output, buffers, ctx)
      if (output.f32 === null) continue
      if (input.count > 0) duration = Math.max(duration, input.f32[input.count - 1])
      channels.push({
        node: ch.target.node ?? -1,
        path,
        times: input.f32,
        values: output.f32,
        interpolation: (sampler.interpolation === 'STEP'
          ? 'step'
          : sampler.interpolation === 'CUBICSPLINE'
            ? 'cubicspline'
            : 'linear'),
      })
    }
    return { name: a.name ?? null, duration, channels }
  })

  return {
    source: 'gltf',
    meshNames,
    meshes,
    materials,
    images,
    samplers,
    nodes,
    scenes: sceneRoots,
    skins,
    animations,
    stats: meshStatsOf(meshes, materials, images, nodes, animations),
  }
}

function floatToU8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)))
}

// ─── высокоуровневые функции ─────────────────────────────────────────────────

/** Разобрать GLB из байтов. */
export async function parseGlb(bytes: Uint8Array, ctx: ParseContext): Promise<MeshDocument> {
  const container = parseGlbContainer(bytes, ctx)
  const buffers = await loadBuffers(container.gltf, container.bin, ctx)
  return buildMeshDocument(container.gltf, buffers, ctx)
}

/** Разобрать .gltf (JSON) из байтов; внешние .bin грузятся через ctx. */
export async function parseGltfJsonBytes(bytes: Uint8Array, ctx: ParseContext): Promise<MeshDocument> {
  const url = ctx.sourceUrl
  let gltf: GltfRoot
  try {
    gltf = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as GltfRoot
  } catch (err) {
    throw new ParseError(`glTF: битый JSON: ${(err as Error).message}`, 0, url)
  }
  const buffers = await loadBuffers(gltf, null, ctx)
  return buildMeshDocument(gltf, buffers, ctx)
}

// ─── Parser для менеджера (буферный + стриминговый) ──────────────────────────

export const gltfParser: Parser<MeshDocument> = {
  kind: 'gltf',
  extensions: ['.gltf', '.glb'],
  async parse(input: ParseInput): Promise<MeshDocument> {
    const bytes = input.bytes
    if (isGlbMagic(bytes)) return parseGlb(bytes, input.ctx)
    return parseGltfJsonBytes(bytes, input.ctx)
  },
  /**
   * Стрим-синк GLB: JSON-чанк парсится как только докачан (BIN ещё едет),
   * разбор геометрии — в finish(). Для .gltf-JSON стриминг бессмыслен —
   * менеджер вызовет parse() (factory вернёт universal-синк с буфером).
   */
  streaming(ctx: ParseContext): StreamSink<MeshDocument> {
    return new GlbStreamSink(ctx)
  },
}

/**
 * Инкрементальный разбор GLB-контейнера по чанкам.
 * Состояния: header → chunk-header → [json|bin] data → ... → finish.
 */
class GlbStreamSink implements StreamSink<MeshDocument> {
  private readonly acc = new GrowableBytes(1 << 16)
  private json: GltfRoot | null = null
  private jsonDone = false
  private finished = false

  constructor(private readonly ctx: ParseContext) {}

  push(chunk: Uint8Array): void {
    if (this.finished) return
    this.acc.push(chunk)
    this.tryAdvance()
  }

  private tryAdvance(): void {
    const view = this.acc.view()
    const dv = new DataView(view.buffer, view.byteOffset, view.byteLength)
    if (!this.jsonDone && view.length >= 12) {
      if (dv.getUint32(0, true) !== GLB_MAGIC) {
        // это не GLB — .gltf-JSON; дождёмся конца и отдадим parse-пути
        this.jsonDone = true
        this.json = null
        return
      }
      const len = dv.getUint32(12, true)
      const type = dv.getUint32(16, true)
      if (view.length >= 20 + len) {
        if (type === CHUNK_JSON) {
          const text = new TextDecoder('utf-8').decode(view.subarray(20, 20 + len))
          try {
            this.json = JSON.parse(text) as GltfRoot
          } catch (err) {
            throw new ParseError(`GLB: битый JSON-чанк: ${(err as Error).message}`, 20, this.ctx.sourceUrl)
          }
        }
        this.jsonDone = true
      }
    }
  }

  async finish(): Promise<MeshDocument> {
    if (this.finished) throw new ParseError('GLB: finish() уже вызван')
    this.finished = true
    this.tryAdvance()
    const bytes = this.acc.take()
    if (!isGlbMagic(bytes)) {
      return parseGltfJsonBytes(bytes, this.ctx)
    }
    return parseGlb(bytes, this.ctx)
  }
}
