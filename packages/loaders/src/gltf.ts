/**
 * glTF/GLB loader — полное декодирование с потоковым доступом.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * КОНТРАКТ:
 *
 *   parseGlb(assembler, options)      — GLB 2.0 (JSON+BIN чанки)
 *   parseGltfJson(text, external, options) — .gltf + внешние буферы
 *
 *   ВЫХОД: GltfModel — { json, meshes, materials, images, nodes,
 *     sceneRoots, whenImagesDecoded, kind, stats }.
 *     Материалы: PBR-факторы + alphaMode/alphaCutoff/doubleSided/unlit.
 *     Изображения: ленивые — bytes доступны с приходом диапазона,
 *     bitmap (ImageBitmap) — Promise, декод стартует по готовности байт.
 *     Геометрия: positions/normals/uvs/indices как TypedArray.
 *
 * ОПТИМИЗАЦИИ (why it's fast):
 *   1. GLB-заголовок читается после 20 байт — парсинг стартует до
 *      завершения скачивания (waitFor/onRange Assembler).
 *   2. Zero-copy: при известном Content-Length BIN-срезы указывают
 *      прямо в буфер Assembler (без копий), float-аксессоры без
 *      byteStride отдаются как Float32Array-вид над телом.
 *   3. Примитивы сортируются по смещению в файле — «ранние» данные
 *      парсятся раньше, прогресс честный.
 *   4. Draco (KHR_draco_mesh_compression) — через инъекцию декодера.
 *
 * ОШИБКИ: «не GLB: магик не glTF» / «GLB версии N не поддерживается» /
 *   «GLB без BIN-чанка…» / «glTF требует KHR_…» — все actionable.
 *
 * Лоадер НЕ знает про GPU: ImageBitmap → @rune/gl/kit, данные → движок.
 */

import { asciiDecode, align4, nowMs } from './bytes.ts'
import type { Assembler } from './assembler.ts'

// ─── Магические константы формата ────────────────────────────────────────────

const GLB_MAGIC = 1179937895 // 'glTF' LE
const GLB_CHUNK_JSON = 1313821514 // 'JSON' LE
const GLB_CHUNK_BIN = 5130562 // 'BIN\0' LE
const COMPONENT_FLOAT = 5126
const COMPONENT_UNSIGNED_INT = 5125
const COMPONENT_UNSIGNED_SHORT = 5123

/** Расширения, которые парсер не поддерживает нативно. */
const UNSUPPORTED_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression', // ok при инъекции dracoDecoder
  'EXT_meshopt_compression',
  'KHR_texture_basisu',
])

/** Размер компонента по componentType. */
const COMPONENT_SIZE: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
}

/** Число компонентов по типу аксессора. */
const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
}

// ─── Публичные типы ──────────────────────────────────────────────────────────

/** Фаза прогресса парсинга (stage: json/bin/geometry/…). */
export interface GltfPhase {
  readonly stage: string
  readonly ratio: number
  readonly detail: string
}

export type OnGltfPhase = (phase: GltfPhase) => void

/** Кастомный декодер изображения (тесты/окружения без createImageBitmap). */
export type CreateBitmap = (
  bytes: Uint8Array,
  mimeType: string,
  options?: ImageBitmapOptions,
) => Promise<ImageBitmap>

/** Кастомный Draco-декодер: байты + атрибуты → распакованная геометрия. */
export type DracoDecoder = (
  bytes: Uint8Array,
  attributes: Record<string, number>,
) => Promise<{
  positions: Float32Array
  normals: Float32Array | null
  uvs: Float32Array | null
  indices: Uint16Array | Uint32Array | null
}>

/** Опции парсинга glTF. */
export interface GltfParseOptions {
  readonly signal?: AbortSignal
  readonly onPhase?: OnGltfPhase
  readonly createBitmap?: CreateBitmap
  readonly dracoDecoder?: DracoDecoder
}

/** Сэмплер текстуры (значения WebGL/WebGPU констант). */
export interface GltfSampler {
  readonly magFilter: number
  readonly minFilter: number
  readonly wrapS: number
  readonly wrapT: number
}

/** Изображение: байты приходят потоком, bitmap декодится лениво. */
export interface GltfImage {
  readonly name: string
  readonly mimeType: string
  /** Байты изображения (пустой массив, пока диапазон не получен). */
  readonly bytes: Uint8Array
  /** Декодированный растр; реджект при отсутствии createImageBitmap. */
  readonly bitmap: Promise<ImageBitmap>
  readonly sampler: GltfSampler | null
}

/** PBR-материал (значения — индексы изображений или null). */
export interface GltfMaterial {
  readonly name: string
  readonly baseColorFactor: readonly number[]
  readonly metallicFactor: number
  readonly roughnessFactor: number
  readonly baseColorImage: number | null
  readonly mrImage: number | null
  readonly normalImage: number | null
  readonly occlusionImage: number | null
  readonly emissiveImage: number | null
  readonly emissiveFactor: readonly number[]
  readonly alphaMode: 'OPAQUE' | 'MASK' | 'BLEND'
  readonly alphaCutoff: number
  readonly doubleSided: boolean
  readonly unlit: boolean
}

/** Границы примитива. */
export interface GltfBounds {
  readonly min: readonly number[]
  readonly max: readonly number[]
}

/** Декодированный примитив (меш = список примитивов). */
export interface GltfPrimitive {
  readonly positions: Float32Array
  readonly normals: Float32Array | null
  readonly uvs: Float32Array | null
  /** Uint16/Uint32: zero-copy плотно упакованные индексы остаются как есть. */
  readonly indices: Uint16Array | Uint32Array | null
  readonly material: number | null
  readonly vertexCount: number
  readonly bounds: GltfBounds
}

export interface GltfMesh {
  readonly name: string
  readonly primitives: readonly GltfPrimitive[]
}

/** Узел сцены (TRS или матрица). */
export interface GltfNode {
  readonly name: string
  readonly children: readonly number[]
  readonly mesh: number | null
  readonly matrix: readonly number[] | null
  readonly translation: readonly number[] | null
  readonly rotation: readonly number[] | null
  readonly scale: readonly number[] | null
}

/** Статистика загрузки/парсинга. */
export interface GltfStats {
  readonly jsonBytes: number
  readonly binBytes: number
  readonly vertices: number
  readonly triangles: number
  readonly primitives: number
  readonly images: number
  readonly parseMs: number
  readonly zeroCopyViews: number
}

/** Полностью декодированный glTF (GLB или .gltf). */
export interface GltfModel {
  readonly kind: 'glb' | 'gltf'
  /** Исходный JSON документа (для расширений клиента). */
  readonly json: unknown
  readonly meshes: readonly GltfMesh[]
  readonly materials: readonly GltfMaterial[]
  readonly images: readonly GltfImage[]
  readonly nodes: readonly GltfNode[]
  readonly sceneRoots: readonly number[]
  /** Все bitmap-декоды завершены (успех или провал). */
  readonly whenImagesDecoded: () => Promise<void>
  readonly stats: GltfStats
}

/** Источник бинарных данных: BIN-чанк GLB или внешний файл. */
interface BufferSource {
  ready(offset: number, length: number): boolean
  wait(offset: number, length: number): Promise<void>
  view(offset: number, length: number): Uint8Array
  onRange(listener: (available: number) => void): () => void
  zeroCopy(): void
}

/** Загрузчик внешних ресурсов для .gltf (байты по uri). */
export interface GltfExternalSource {
  loadExternal(uri: string): Promise<Uint8Array>
}

// ─── Проверки магики ─────────────────────────────────────────────────────────

/** Первые 4 байта — 'glTF' (JSON-часть GLB). */
export function isGltfJson(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && asciiDecode(bytes, 0, 4) === 'glTF'
}

// ─── GLB ─────────────────────────────────────────────────────────────────────

/**
 * Парсинг GLB 2.0 поверх СТРИМИНГА: заголовок — после 20 байт,
 * JSON — после 20+jsonLength, BIN — определяется по выровненному
 * смещению; геометрия парсится в потоке, не дожидаясь хвоста файла.
 */
export async function parseGlb(assembler: Assembler, options: GltfParseOptions = {}): Promise<GltfModel> {
  const startedAt = nowMs()
  const onPhase = options.onPhase ?? (() => {})
  let zeroCopyCount = 0

  await assembler.waitFor(20)
  const header = new DataView(assembler.slice(0, 20).buffer)
  if (header.getUint32(0, true) !== GLB_MAGIC) throw new Error('не GLB: магик не glTF')
  const version = header.getUint32(4, true)
  if (version !== 2) throw new Error(`GLB версии ${version} не поддерживается (только 2)`)
  const declaredTotal = header.getUint32(8, true)
  const jsonLength = header.getUint32(12, true)
  if (header.getUint32(16, true) !== GLB_CHUNK_JSON)
    throw new Error('GLB: первый чанк не JSON')

  onPhase({ stage: 'json', ratio: 0.05, detail: `${formatBytesRounded(jsonLength)} JSON` })
  await assembler.waitFor(20 + jsonLength)
  const jsonText = new TextDecoder('utf-8').decode(assembler.slice(20, jsonLength))
  const json = JSON.parse(jsonText) as GltfDocument
  assertRequiredExtensions(json, options.dracoDecoder)

  // Позиция BIN-чанка: сразу за JSON-чанком (выравнивание 4 байта)
  const binHeaderOffset = 20 + align4(jsonLength)
  let binLength = 0
  let binStart = -1
  if (assembler.total === undefined) {
    // Размер неизвестен: ждём что есть, читаем по факту
    await assembler.completion
    if (assembler.watermark > binHeaderOffset + 8) {
      const binHeader = new DataView(assembler.slice(binHeaderOffset, 8).buffer)
      binLength = binHeader.getUint32(0, true)
      binStart = binHeader.getUint32(4, true) === GLB_CHUNK_BIN ? binHeaderOffset + 8 : -1
    }
  } else if (binHeaderOffset + 8 <= assembler.total) {
    await assembler.waitFor(binHeaderOffset + 8)
    const binHeader = new DataView(assembler.slice(binHeaderOffset, 8).buffer)
    binLength = binHeader.getUint32(0, true)
    binStart = binHeader.getUint32(4, true) === GLB_CHUNK_BIN ? binHeaderOffset + 8 : -1
  }
  const totalKnown = assembler.total !== undefined
  onPhase({
    stage: 'bin',
    ratio: 0.15,
    detail: binStart >= 0 ? `BIN ${formatBytesRounded(binLength)}` : 'без BIN-чанка',
  })

  const binReady = (length: number): boolean =>
    binStart < 0 ? assembler.isDone : assembler.watermark - binStart >= length
  const waitBin = async (length: number): Promise<void> => {
    if (binStart < 0 || binReady(length)) return
    await assembler.waitFor(binStart + length)
  }
  const binSource: BufferSource = {
    ready: (offset, length) => binReady(offset + length),
    wait: (offset, length) => waitBin(offset + length),
    view: (offset, length) => {
      if (binStart < 0)
        throw new Error('GLB без BIN-чанка: буферы должны быть внешними uri')
      if (!binReady(offset + length))
        throw new Error(`BIN-диапазон [${offset}, ${offset + length}) не получен`)
      // Zero-copy: буфер аллоцирован под Content-Length и не двигается
      if (totalKnown) {
        zeroCopyCount++
        return new Uint8Array(assembler.prefixView(assembler.watermark).buffer, binStart + offset, length)
      }
      return assembler.slice(binStart + offset, length)
    },
    onRange: (listener) => assembler.onRange((watermark) => listener(Math.max(0, watermark - binStart))),
    zeroCopy: () => {
      zeroCopyCount++
    },
  }

  const model = await parseGltfDocument(json, {
    buffers: [binSource],
    phase: onPhase,
    signal: options.signal,
    createBitmap: options.createBitmap,
    dracoDecoder: options.dracoDecoder,
  })

  await assembler.completion
  if (assembler.total !== undefined && assembler.watermark !== declaredTotal)
    throw new Error(`GLB неполный: ${assembler.watermark} из ${declaredTotal} байт`)

  return withStats(model, 'glb', {
    jsonBytes: jsonLength,
    binBytes: binStart >= 0 ? binLength : 0,
    parseMs: nowMs() - startedAt,
    zeroCopyViews: zeroCopyCount,
  })
}

// ─── .gltf (JSON + внешние буферы) ───────────────────────────────────────────

/** Парсинг .gltf: JSON-текст + загрузчик внешних буферов/изображений. */
export async function parseGltfJson(
  text: string,
  external: GltfExternalSource,
  options: GltfParseOptions = {},
): Promise<GltfModel> {
  const startedAt = nowMs()
  const onPhase = options.onPhase ?? (() => {})
  const json = JSON.parse(text) as GltfDocument
  assertRequiredExtensions(json, options.dracoDecoder)
  onPhase({
    stage: 'buffers',
    ratio: 0.1,
    detail: `${json.buffers?.length ?? 0} внешних буферов`,
  })

  const externals: Uint8Array[] = []
  for (const buffer of json.buffers ?? []) externals.push(await external.loadExternal(buffer.uri ?? ''))
  const sources: BufferSource[] = externals.map((bytes) => ({
    ready: () => true,
    wait: async () => {},
    view: (offset, length) => bytes.subarray(offset, offset + length),
    onRange: () => () => {},
    zeroCopy: () => {},
  }))

  const model = await parseGltfDocument(json, {
    buffers: sources,
    phase: onPhase,
    signal: options.signal,
    createBitmap: options.createBitmap,
    dracoDecoder: options.dracoDecoder,
    loadImageBytes: (uri) => external.loadExternal(uri),
  })

  return withStats(model, 'gltf', {
    jsonBytes: text.length,
    binBytes: externals.reduce((sum, b) => sum + b.byteLength, 0),
    parseMs: nowMs() - startedAt,
    zeroCopyViews: 0,
  })
}

// ─── Общий обход документа ───────────────────────────────────────────────────

/** Минимальная типизация glTF-JSON (остальное — raw). */
interface GltfDocument {
  accessors?: Array<{
    bufferView?: number
    byteOffset?: number
    count: number
    type: string
    componentType: number
    normalized?: boolean
    sparse?: unknown
    min?: number[]
    max?: number[]
  }>
  bufferViews?: Array<{ buffer?: number; byteOffset?: number; byteLength: number; byteStride?: number }>
  textures?: Array<{
    source?: number
    sampler?: number | null
    extensions?: { EXT_texture_webp?: { source: number }; EXT_texture_avif?: { source: number } }
  }>
  samplers?: Array<{
    magFilter?: number
    minFilter?: number
    wrapS?: number
    wrapT?: number
  }>
  images?: Array<{
    name?: string
    mimeType?: string
    bufferView?: number
    uri?: string
  }>
  materials?: Array<{
    name?: string
    pbrMetallicRoughness?: {
      baseColorFactor?: number[]
      metallicFactor?: number
      roughnessFactor?: number
      baseColorTexture?: { index: number }
      metallicRoughnessTexture?: { index: number }
    }
    normalTexture?: { index: number }
    occlusionTexture?: { index: number }
    emissiveTexture?: { index: number }
    emissiveFactor?: number[]
    alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'
    alphaCutoff?: number
    doubleSided?: boolean
    extensions?: { KHR_materials_unlit?: unknown }
  }>
  meshes?: Array<{
    name?: string
    primitives: Array<{
      attributes: Record<string, number | undefined>
      indices?: number
      material?: number
      extensions?: { KHR_draco_mesh_compression?: { bufferView: number; attributes?: Record<string, number> } }
    }>
  }>
  nodes?: Array<{
    name?: string
    children?: number[]
    mesh?: number
    matrix?: number[]
    translation?: number[]
    rotation?: number[]
    scale?: number[]
  }>
  scenes?: Array<{ nodes?: number[] }>
  scene?: number
  buffers?: Array<{ uri?: string }>
  extensionsRequired?: string[]
}

interface ParseContext {
  buffers: BufferSource[]
  phase: OnGltfPhase
  signal?: AbortSignal
  createBitmap?: CreateBitmap
  dracoDecoder?: DracoDecoder
  loadImageBytes?: (uri: string) => Promise<Uint8Array>
}

type RawAccessor = NonNullable<GltfDocument['accessors']>[number]
type RawBufferView = NonNullable<GltfDocument['bufferViews']>[number]
type RawPrimitive = NonNullable<GltfDocument['meshes']>[number]['primitives'][number]

/** Сборка декодированной модели из JSON-документа. */
async function parseGltfDocument(json: GltfDocument, ctx: ParseContext): Promise<Omit<GltfModel, 'kind' | 'stats'>> {
  const accessors = json.accessors ?? []
  const bufferViews = json.bufferViews ?? []

  const textureSource = (index: number | undefined): { image: number | null; sampler: number | null } => {
    if (index === undefined || json.textures === undefined) return { image: null, sampler: null }
    const texture = json.textures[index]
    if (texture === undefined) return { image: null, sampler: null }
    return {
      image:
        texture.source ??
        texture.extensions?.EXT_texture_webp?.source ??
        texture.extensions?.EXT_texture_avif?.source ??
        null,
      sampler: texture.sampler ?? null,
    }
  }

  const materials: GltfMaterial[] = (json.materials ?? []).map((m) => {
    const pbr = m.pbrMetallicRoughness ?? {}
    const factor = pbr.baseColorFactor ?? [1, 1, 1, 1]
    return {
      name: m.name ?? '',
      baseColorFactor: [factor[0] ?? 1, factor[1] ?? 1, factor[2] ?? 1, factor[3] ?? 1],
      metallicFactor: pbr.metallicFactor ?? 1,
      roughnessFactor: pbr.roughnessFactor ?? 1,
      baseColorImage: textureSource(pbr.baseColorTexture?.index).image,
      mrImage: textureSource(pbr.metallicRoughnessTexture?.index).image,
      normalImage: textureSource(m.normalTexture?.index).image,
      occlusionImage: textureSource(m.occlusionTexture?.index).image,
      emissiveImage: textureSource(m.emissiveTexture?.index).image,
      emissiveFactor: [...(m.emissiveFactor ?? [0, 0, 0])],
      alphaMode: m.alphaMode ?? 'OPAQUE',
      alphaCutoff: m.alphaCutoff ?? 0.5,
      doubleSided: m.doubleSided ?? false,
      unlit: m.extensions?.KHR_materials_unlit !== undefined,
    }
  })

  const createBitmap: CreateBitmap | undefined =
    ctx.createBitmap ??
    (typeof createImageBitmap === 'function'
      ? (bytes, mime, opts) =>
          createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), opts ?? { premultiplyAlpha: 'none' })
      : undefined)

  // Изображения: байты приходят по диапазонам, bitmap декодится лениво
  const imageBitmaps: Array<Promise<void>> = []
  const images: GltfImage[] = []
  const rawImages = json.images ?? []
  for (let imageIndex = 0; imageIndex < rawImages.length; imageIndex++) {
    const raw = rawImages[imageIndex]
    const name = raw.name ?? `image-${imageIndex}`
    const mimeType = raw.mimeType ?? 'image/png'
    let bytes: Uint8Array = new Uint8Array(0)
    let resolveBitmap!: (bitmap: ImageBitmap) => void
    let rejectBitmap!: (reason: unknown) => void
    const bitmap = new Promise<ImageBitmap>((resolve, reject) => {
      resolveBitmap = resolve
      rejectBitmap = reject
    })
    const samplerIndex = findSamplerForImage(json, imageIndex)
    const rawSampler = samplerIndex !== null ? json.samplers?.[samplerIndex] : undefined
    const image: GltfImage = {
      name,
      mimeType,
      get bytes() {
        return bytes
      },
      bitmap,
      sampler:
        rawSampler !== undefined
          ? {
              magFilter: rawSampler.magFilter ?? 9729,
              minFilter: rawSampler.minFilter ?? 9987,
              wrapS: rawSampler.wrapS ?? 10497,
              wrapT: rawSampler.wrapT ?? 10497,
            }
          : null,
    }
    images.push(image)
    // Прогресс whenImagesDecoded не ломается от одиночных провалов
    imageBitmaps.push(bitmap.then(() => {}, () => {}))

    const startDecode = (): void => {
      try {
        if (createBitmap === undefined) {
          rejectBitmap(new Error('createImageBitmap недоступен в этой среде'))
          return
        }
        createBitmap(bytes, mimeType).then(resolveBitmap, rejectBitmap)
      } catch (error) {
        rejectBitmap(error)
      }
    }

    if (raw.bufferView !== undefined) {
      const view = bufferViews[raw.bufferView]
      if (view === undefined) {
        rejectBitmap(new Error(`image ${name}: bufferView ${raw.bufferView} не найден`))
        continue
      }
      const byteOffset = view.byteOffset ?? 0
      const byteLength = view.byteLength
      const source = ctx.buffers[view.buffer ?? 0]
      if (source === undefined) {
        rejectBitmap(new Error(`image ${name}: буфер ${view.buffer ?? 0} не найден`))
        continue
      }
      if (source.ready(byteOffset, byteLength)) {
        bytes = source.view(byteOffset, byteLength)
        startDecode()
      } else {
        // Диапазон ещё качается: декод стартует с приходом байтов
        const unsubscribe = source.onRange((available) => {
          if (available >= byteOffset + byteLength) {
            unsubscribe()
            try {
              bytes = source.view(byteOffset, byteLength)
              startDecode()
            } catch (error) {
              rejectBitmap(error)
            }
          }
        })
      }
    } else if (raw.uri !== undefined && ctx.loadImageBytes !== undefined) {
      try {
        bytes = await ctx.loadImageBytes(raw.uri)
        startDecode()
      } catch (error) {
        rejectBitmap(error)
      }
    } else {
      rejectBitmap(new Error(`image ${name}: нет ни bufferView, ни загрузчика uri`))
    }
  }

  // Порядок парсинга примитивов = порядок данных в файле (progressive)
  const plans: Array<{ meshIndex: number; primitive: RawPrimitive; minOffset: number }> = []
  const rawMeshes = json.meshes ?? []
  for (let meshIndex = 0; meshIndex < rawMeshes.length; meshIndex++)
    for (const primitive of rawMeshes[meshIndex].primitives) {
      let minOffset = Number.POSITIVE_INFINITY
      const dracoView = primitive.extensions?.KHR_draco_mesh_compression?.bufferView
      if (dracoView !== undefined) {
        const view = bufferViews[dracoView]
        if (view !== undefined) minOffset = Math.min(minOffset, view.byteOffset ?? 0)
      }
      const consider = (accessorIndex: number | undefined): void => {
        if (accessorIndex === undefined) return
        const accessor = accessors[accessorIndex]
        if (accessor?.bufferView === undefined) return
        const view = bufferViews[accessor.bufferView]
        if (view === undefined) return
        minOffset = Math.min(minOffset, (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0))
      }
      consider(primitive.attributes.POSITION)
      consider(primitive.attributes.NORMAL)
      consider(primitive.attributes.TEXCOORD_0)
      consider(primitive.indices)
      plans.push({ meshIndex, primitive, minOffset: Number.isFinite(minOffset) ? minOffset : 0 })
    }
  plans.sort((a, b) => a.minOffset - b.minOffset)

  const primitivesPerMesh: GltfPrimitive[][] = rawMeshes.map(() => [])
  let parsedCount = 0
  for (const plan of plans) {
    throwIfAborted(ctx.signal)
    const { primitive } = plan
    let positions: Float32Array
    let normals: Float32Array | null
    let uvs: Float32Array | null
    let indices: Uint16Array | Uint32Array | null
    const draco = primitive.extensions?.KHR_draco_mesh_compression
    if (draco !== undefined) {
      if (ctx.dracoDecoder === undefined)
        throw new Error(
          'примитив сжат KHR_draco_mesh_compression, но декодер не передан ' +
            '(GltfParseOptions.dracoDecoder) — сжатая геометрия не читается',
        )
      const view = bufferViews[draco.bufferView]
      if (view === undefined) throw new Error(`Draco: bufferView ${draco.bufferView} не найден`)
      const source = ctx.buffers[view.buffer ?? 0]
      if (source === undefined) throw new Error(`Draco: буфер ${view.buffer ?? 0} не найден`)
      const byteOffset = view.byteOffset ?? 0
      await source.wait(byteOffset, view.byteLength)
      const dracoBytes = source.view(byteOffset, view.byteLength)
      const decoded = await ctx.dracoDecoder(dracoBytes, draco.attributes ?? {})
      positions = decoded.positions
      normals = decoded.normals
      uvs = decoded.uvs
      indices = decoded.indices
    } else {
      positions = await readFloatAttribute(primitive.attributes.POSITION, 'POSITION', accessors, bufferViews, ctx)
      normals =
        primitive.attributes.NORMAL !== undefined
          ? await readFloatAttribute(primitive.attributes.NORMAL, 'NORMAL', accessors, bufferViews, ctx)
          : null
      uvs =
        primitive.attributes.TEXCOORD_0 !== undefined
          ? await readFloatAttribute(primitive.attributes.TEXCOORD_0, 'TEXCOORD_0', accessors, bufferViews, ctx)
          : null
      indices =
        primitive.indices !== undefined
          ? await readIndices(primitive.indices, accessors, bufferViews, ctx)
          : null
    }
    const positionAccessor =
      primitive.attributes.POSITION !== undefined ? accessors[primitive.attributes.POSITION] : undefined
    primitivesPerMesh[plan.meshIndex].push({
      positions,
      normals,
      uvs,
      indices,
      material: primitive.material ?? null,
      vertexCount: positions.length / 3,
      bounds: computeBounds(positionAccessor, positions),
    })
    parsedCount++
    ctx.phase({
      stage: 'geometry',
      ratio: 0.2 + 0.75 * (parsedCount / plans.length),
      detail: `${parsedCount}/${plans.length} примитивов`,
    })
  }
  ctx.phase({ stage: 'geometry', ratio: 0.95, detail: `${parsedCount} примитивов` })

  const meshes: GltfMesh[] = rawMeshes.map((mesh, index) => ({
    name: mesh.name ?? `mesh-${index}`,
    primitives: primitivesPerMesh[index] ?? [],
  }))
  const nodes: GltfNode[] = (json.nodes ?? []).map((node, index) => ({
    name: node.name ?? `node-${index}`,
    children: node.children ?? [],
    mesh: node.mesh ?? null,
    matrix: node.matrix ?? null,
    translation: node.translation ?? null,
    rotation: node.rotation ?? null,
    scale: node.scale ?? null,
  }))
  const sceneIndex = json.scene ?? 0
  const sceneRoots = json.scenes?.[sceneIndex]?.nodes ?? []

  return {
    json,
    meshes,
    materials,
    images,
    nodes,
    sceneRoots,
    whenImagesDecoded: async () => {
      await Promise.all(imageBitmaps)
    },
  }
}

// ─── Аксессоры ───────────────────────────────────────────────────────────────

/** Чтение float-атрибута (POSITION/NORMAL/TEXCOORD_0) из аксессора. */
async function readFloatAttribute(
  accessorIndex: number | undefined,
  semantic: string,
  accessors: RawAccessor[],
  bufferViews: RawBufferView[],
  ctx: ParseContext,
): Promise<Float32Array> {
  if (accessorIndex === undefined) throw new Error(`примитив без атрибута ${semantic}`)
  const accessor = accessors[accessorIndex]
  if (accessor === undefined) throw new Error(`аксессор ${semantic} #${accessorIndex} не найден`)
  const numComponents = TYPE_COMPONENTS[accessor.type] ?? 0
  if (numComponents === 0) throw new Error(`аксессор ${semantic}: тип ${accessor.type} не векторный`)
  if (accessor.sparse !== undefined) throw new Error(`аксессор ${semantic}: sparse не поддерживается`)
  const count = accessor.count
  if (accessor.bufferView === undefined) return new Float32Array(count * numComponents)
  const view = bufferViews[accessor.bufferView]
  if (view === undefined) throw new Error(`bufferView ${accessor.bufferView} не найден (${semantic})`)
  const source = ctx.buffers[view.buffer ?? 0]
  if (source === undefined) throw new Error(`буфер ${view.buffer ?? 0} не найден (${semantic})`)

  const componentType = accessor.componentType
  const componentSize = COMPONENT_SIZE[componentType] ?? 0
  if (componentSize === 0) throw new Error(`componentType ${componentType} не поддержан (${semantic})`)
  const byteStride = view.byteStride ?? 0
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const tightBytes = count * numComponents * componentSize
  const spanBytes = byteStride > 0 ? (count - 1) * byteStride + numComponents * componentSize : tightBytes
  await source.wait(byteOffset, spanBytes)
  const view8 = source.view(byteOffset, spanBytes)

  // Fast-path 1: плотно упакованный FLOAT — отдаём вид над телом (zero-copy)
  if (byteStride === 0 && componentType === COMPONENT_FLOAT && view8.byteOffset % 4 === 0)
    return (source.zeroCopy(), new Float32Array(view8.buffer, view8.byteOffset, count * numComponents))
  // Fast-path 2: FLOAT со stride, кратным 4 — плотним одним проходом
  if (componentType === COMPONENT_FLOAT && byteStride > 0 && byteStride % 4 === 0 && view8.byteOffset % 4 === 0) {
    const strided = new Float32Array(view8.buffer, view8.byteOffset, view8.byteLength / 4)
    const packed = new Float32Array(count * numComponents)
    const strideComponents = byteStride / 4
    for (let vertex = 0; vertex < count; vertex++)
      packed.set(strided.subarray(vertex * strideComponents, vertex * strideComponents + numComponents), vertex * numComponents)
    return packed
  }

  // Общий путь: покомпонентное чтение (+ normalized-конверсия)
  const dataView = new DataView(view8.buffer, view8.byteOffset, view8.byteLength)
  const out = new Float32Array(count * numComponents)
  const normalized = accessor.normalized ?? false
  const rowBytes = byteStride > 0 ? byteStride : numComponents * componentSize
  let outAt = 0
  for (let vertex = 0; vertex < count; vertex++) {
    const rowStart = vertex * rowBytes
    for (let component = 0; component < numComponents; component++) {
      const at = rowStart + component * componentSize
      let value: number
      switch (componentType) {
        case 5126:
          value = dataView.getFloat32(at, true)
          break
        case 5125:
          value = dataView.getUint32(at, true)
          break
        case 5123:
          value = dataView.getUint16(at, true)
          if (normalized) value /= 65535
          break
        case 5122:
          value = dataView.getInt16(at, true)
          if (normalized) value = Math.max(value / 32767, -1)
          break
        case 5121:
          value = view8[at]
          if (normalized) value /= 255
          break
        case 5120:
          value = dataView.getInt8(at)
          if (normalized) value = Math.max(value / 127, -1)
          break
        default:
          throw new Error(`componentType ${componentType} не поддержан`)
      }
      out[outAt++] = value
    }
  }
  return out
}

/** Чтение индексов (SCALAR; поддержаны UShort/UInt). */
async function readIndices(
  accessorIndex: number,
  accessors: RawAccessor[],
  bufferViews: RawBufferView[],
  ctx: ParseContext,
): Promise<Uint16Array | Uint32Array> {
  const accessor = accessors[accessorIndex]
  if (accessor === undefined) throw new Error(`аксессор indices #${accessorIndex} не найден`)
  if (accessor.type !== 'SCALAR') throw new Error('indices: тип не SCALAR')
  const count = accessor.count
  if (accessor.bufferView === undefined) return new Uint16Array(0)
  const view = bufferViews[accessor.bufferView]
  if (view === undefined) throw new Error(`bufferView ${accessor.bufferView} не найден (indices)`)
  const source = ctx.buffers[view.buffer ?? 0]
  if (source === undefined) throw new Error(`буфер ${view.buffer ?? 0} не найден (indices)`)

  const componentSize = COMPONENT_SIZE[accessor.componentType] ?? 0
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const byteLength = count * componentSize
  await source.wait(byteOffset, byteLength)
  const view8 = source.view(byteOffset, byteLength)

  if (accessor.componentType === COMPONENT_UNSIGNED_SHORT && view8.byteOffset % 2 === 0)
    return (source.zeroCopy(), new Uint16Array(view8.buffer, view8.byteOffset, count))
  if (accessor.componentType === COMPONENT_UNSIGNED_INT && view8.byteOffset % 4 === 0)
    return (source.zeroCopy(), new Uint32Array(view8.buffer, view8.byteOffset, count))
  const dataView = new DataView(view8.buffer, view8.byteOffset, view8.byteLength)
  if (accessor.componentType === COMPONENT_UNSIGNED_SHORT) {
    const out = new Uint16Array(count)
    for (let i = 0; i < count; i++) out[i] = dataView.getUint16(i * 2, true)
    return out
  }
  if (accessor.componentType === COMPONENT_UNSIGNED_INT) {
    const out = new Uint32Array(count)
    for (let i = 0; i < count; i++) out[i] = dataView.getUint32(i * 4, true)
    return out
  }
  throw new Error(`indices componentType ${accessor.componentType} не поддержан`)
}

// ─── Вспомогательные ─────────────────────────────────────────────────────────

/** min/max из метаданных аксессора, иначе проход по позициям. */
function computeBounds(
  accessor: { min?: number[]; max?: number[] } | undefined,
  positions: Float32Array,
): GltfBounds {
  if (accessor?.min !== undefined && accessor.min.length >= 3) {
    const max = accessor.max ?? [0, 0, 0]
    return { min: [...accessor.min.slice(0, 3)], max: [...max.slice(0, 3)] }
  }
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3)
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis]
      if (value < min[axis]) min[axis] = value
      if (value > max[axis]) max[axis] = value
    }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] }
  return { min, max }
}

/** Сэмплер первого texture, использующего изображение. */
function findSamplerForImage(json: GltfDocument, imageIndex: number): number | null {
  for (const texture of json.textures ?? [])
    if (
      (texture.source ??
        texture.extensions?.EXT_texture_webp?.source ??
        texture.extensions?.EXT_texture_avif?.source) === imageIndex
    )
      return texture.sampler ?? null
  return null
}

/** extensionsRequired: Draco ок при декодере; meshopt/basisu — честная ошибка. */
function assertRequiredExtensions(json: GltfDocument, dracoDecoder: DracoDecoder | undefined): void {
  for (const extension of json.extensionsRequired ?? []) {
    if (extension === 'KHR_draco_mesh_compression' && dracoDecoder !== undefined) continue
    if (UNSUPPORTED_EXTENSIONS.has(extension))
      throw new Error(
        `glTF требует ${extension} — ${extension === 'KHR_draco_mesh_compression' ? 'декодер не передан (GltfParseOptions.dracoDecoder)' : 'сжатие геометрии/текстур не поддерживается парсером (поддерживается EXT_texture_webp — нативно браузером)'}`,
      )
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new DOMException('парсинг отменён', 'AbortError')
}

interface StatsInput {
  jsonBytes: number
  binBytes: number
  parseMs: number
  zeroCopyViews: number
}

/** Обогащает модель статистикой (kind + stats). */
function withStats(model: Omit<GltfModel, 'kind' | 'stats'>, kind: 'glb' | 'gltf', input: StatsInput): GltfModel {
  let vertices = 0
  let triangles = 0
  let primitives = 0
  for (const mesh of model.meshes)
    for (const primitive of mesh.primitives) {
      vertices += primitive.vertexCount
      triangles += primitive.indices !== null ? primitive.indices.length / 3 : primitive.vertexCount / 3
      primitives++
    }
  return {
    ...model,
    kind,
    stats: {
      jsonBytes: input.jsonBytes,
      binBytes: input.binBytes,
      vertices,
      triangles,
      primitives,
      images: model.images.length,
      parseMs: input.parseMs,
      zeroCopyViews: input.zeroCopyViews,
    },
  }
}

/** «12.3 MB» / «456 KB» (минимум 1 KB) — для деталей прогресса. */
function formatBytesRounded(bytes: number): string {
  return bytes >= 1048576
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

// ─── Мост Task 88 (AssetLibrary ждёт эти имена) ─────────────────────────────

/** GLB-магия «glTF» в первых 4 байтах (снифф для AssetLibrary). */
export function looksLikeGlb(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46
  )
}

/** Draco-декодер как тип-псевдоним (имя слоя AssetLibrary). */
export type DracoGeometryDecoder = DracoDecoder
