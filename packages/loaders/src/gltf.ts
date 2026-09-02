/**
 * glTF/GLB loader — full decoding with streaming access.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRACT:
 *
 *   parseGlb(assembler, options)      — GLB 2.0 (JSON+BIN chunks)
 *   parseGltfJson(text, external, options) — .gltf + external buffers
 *
 *   OUTPUT: GltfModel — { json, meshes, materials, images, nodes,
 *     sceneRoots, whenImagesDecoded, kind, stats }.
 *     Materials: PBR factors + alphaMode/alphaCutoff/doubleSided/unlit.
 *     Images: lazy — bytes become available when a range arrives,
 *     bitmap (ImageBitmap) is a Promise, decoding starts when bytes are ready.
 *     Geometry: positions/normals/uvs/indices as TypedArrays.
 *
 * OPTIMIZATIONS (why it's fast):
 *   1. The GLB header is read after 20 bytes — parsing starts before
 *      the download finishes (Assembler waitFor/onRange).
 *   2. Zero-copy: with a known Content-Length, BIN slices point
 *      directly into the Assembler buffer (no copies), float accessors without
 *      byteStride are returned as a Float32Array view over the body.
 *   3. Primitives are sorted by offset in the file — "early" data
 *      is parsed earlier, progress is honest.
 *   4. Draco (KHR_draco_mesh_compression) — via decoder injection.
 *
 * ERRORS: "not GLB: magic is not glTF" / "GLB version N is not supported" /
 *   "GLB without BIN chunk..." / "glTF requires KHR_..." — all actionable.
 *
 * The loader does NOT know about the GPU: ImageBitmap → @rune/gl/kit, data → the engine.
 */

import { asciiDecode, align4, nowMs } from './bytes.ts'
import type { Assembler } from './assembler.ts'

// ─── Magic constants of the format ────────────────────────────────────────────

const GLB_MAGIC = 1179937895 // 'glTF' LE
const GLB_CHUNK_JSON = 1313821514 // 'JSON' LE
const GLB_CHUNK_BIN = 5130562 // 'BIN\0' LE
const COMPONENT_FLOAT = 5126
const COMPONENT_UNSIGNED_INT = 5125
const COMPONENT_UNSIGNED_SHORT = 5123

/** Extensions the parser does not support natively. */
const UNSUPPORTED_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression', // ok with dracoDecoder injection
  'EXT_meshopt_compression',
  'KHR_texture_basisu',
])

/** Component size by componentType. */
const COMPONENT_SIZE: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
}

/** Number of components by accessor type. */
const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
}

// ─── Public types ──────────────────────────────────────────────────────────

/** Parsing progress phase (stage: json/bin/geometry/...). */
export interface GltfPhase {
  readonly stage: string
  readonly ratio: number
  readonly detail: string
}

export type OnGltfPhase = (phase: GltfPhase) => void

/** Custom image decoder (tests/environments without createImageBitmap). */
export type CreateBitmap = (
  bytes: Uint8Array,
  mimeType: string,
  options?: ImageBitmapOptions,
) => Promise<ImageBitmap>

/** Custom Draco decoder: bytes + attributes → unpacked geometry. */
export type DracoDecoder = (
  bytes: Uint8Array,
  attributes: Record<string, number>,
) => Promise<{
  positions: Float32Array
  normals: Float32Array | null
  uvs: Float32Array | null
  indices: Uint16Array | Uint32Array | null
}>

/** glTF parsing options. */
export interface GltfParseOptions {
  readonly signal?: AbortSignal
  readonly onPhase?: OnGltfPhase
  readonly createBitmap?: CreateBitmap
  readonly dracoDecoder?: DracoDecoder
}

/** Texture sampler (WebGL/WebGPU constant values). */
export interface GltfSampler {
  readonly magFilter: number
  readonly minFilter: number
  readonly wrapS: number
  readonly wrapT: number
}

/** Image: bytes arrive as a stream, the bitmap is decoded lazily. */
export interface GltfImage {
  readonly name: string
  readonly mimeType: string
  /** Image bytes (an empty array until the range is received). */
  readonly bytes: Uint8Array
  /** Decoded raster; rejects when createImageBitmap is absent. */
  readonly bitmap: Promise<ImageBitmap>
  readonly sampler: GltfSampler | null
}

/** PBR material (values are image indices or null). */
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

/** Primitive bounds. */
export interface GltfBounds {
  readonly min: readonly number[]
  readonly max: readonly number[]
}

/** Decoded primitive (a mesh = a list of primitives). */
export interface GltfPrimitive {
  readonly positions: Float32Array
  readonly normals: Float32Array | null
  readonly uvs: Float32Array | null
  /** Uint16/Uint32: zero-copy densely packed indices stay as is. */
  readonly indices: Uint16Array | Uint32Array | null
  readonly material: number | null
  readonly vertexCount: number
  readonly bounds: GltfBounds
}

export interface GltfMesh {
  readonly name: string
  readonly primitives: readonly GltfPrimitive[]
}

/** Scene node (TRS or matrix). */
export interface GltfNode {
  readonly name: string
  readonly children: readonly number[]
  readonly mesh: number | null
  readonly matrix: readonly number[] | null
  readonly translation: readonly number[] | null
  readonly rotation: readonly number[] | null
  readonly scale: readonly number[] | null
}

/** Load/parse statistics. */
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

/** Fully decoded glTF (GLB or .gltf). */
export interface GltfModel {
  readonly kind: 'glb' | 'gltf'
  /** Original document JSON (for client extensions). */
  readonly json: unknown
  readonly meshes: readonly GltfMesh[]
  readonly materials: readonly GltfMaterial[]
  readonly images: readonly GltfImage[]
  readonly nodes: readonly GltfNode[]
  readonly sceneRoots: readonly number[]
  /** All bitmap decodes are finished (success or failure). */
  readonly whenImagesDecoded: () => Promise<void>
  readonly stats: GltfStats
}

/** Binary data source: the GLB BIN chunk or an external file. */
interface BufferSource {
  ready(offset: number, length: number): boolean
  wait(offset: number, length: number): Promise<void>
  view(offset: number, length: number): Uint8Array
  onRange(listener: (available: number) => void): () => void
  zeroCopy(): void
}

/** External resource loader for .gltf (bytes by uri). */
export interface GltfExternalSource {
  loadExternal(uri: string): Promise<Uint8Array>
}

// ─── Magic checks ─────────────────────────────────────────────────────────

/** First 4 bytes — 'glTF' (the JSON part of GLB). */
export function isGltfJson(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && asciiDecode(bytes, 0, 4) === 'glTF'
}

// ─── GLB ─────────────────────────────────────────────────────────────────────

/**
 * GLB 2.0 parsing on top of STREAMING: the header — after 20 bytes,
 * JSON — after 20+jsonLength, BIN — determined by the aligned
 * offset; geometry is parsed in the stream without waiting for the file tail.
 */
export async function parseGlb(assembler: Assembler, options: GltfParseOptions = {}): Promise<GltfModel> {
  const startedAt = nowMs()
  const onPhase = options.onPhase ?? (() => {})
  let zeroCopyCount = 0

  await assembler.waitFor(20)
  const header = new DataView(assembler.slice(0, 20).buffer)
  if (header.getUint32(0, true) !== GLB_MAGIC) throw new Error('not GLB: magic is not glTF')
  const version = header.getUint32(4, true)
  if (version !== 2) throw new Error(`GLB version ${version} is not supported (only 2)`)
  const declaredTotal = header.getUint32(8, true)
  const jsonLength = header.getUint32(12, true)
  if (header.getUint32(16, true) !== GLB_CHUNK_JSON)
    throw new Error('GLB: first chunk is not JSON')

  onPhase({ stage: 'json', ratio: 0.05, detail: `${formatBytesRounded(jsonLength)} JSON` })
  await assembler.waitFor(20 + jsonLength)
  const jsonText = new TextDecoder('utf-8').decode(assembler.slice(20, jsonLength))
  const json = JSON.parse(jsonText) as GltfDocument
  assertRequiredExtensions(json, options.dracoDecoder)

  // BIN chunk position: right after the JSON chunk (4-byte alignment)
  const binHeaderOffset = 20 + align4(jsonLength)
  let binLength = 0
  let binStart = -1
  if (assembler.total === undefined) {
    // Size unknown: wait for what is there, read it as it arrives
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
    detail: binStart >= 0 ? `BIN ${formatBytesRounded(binLength)}` : 'without BIN chunk',
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
        throw new Error('GLB without BIN chunk: buffers must be external uri')
      if (!binReady(offset + length))
        throw new Error(`BIN range [${offset}, ${offset + length}) not received`)
      // Zero-copy: the buffer is allocated for Content-Length and does not move
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
    throw new Error(`GLB incomplete: ${assembler.watermark} of ${declaredTotal} bytes`)

  return withStats(model, 'glb', {
    jsonBytes: jsonLength,
    binBytes: binStart >= 0 ? binLength : 0,
    parseMs: nowMs() - startedAt,
    zeroCopyViews: zeroCopyCount,
  })
}

// ─── .gltf (JSON + external buffers) ───────────────────────────────────────────

/** Parse .gltf: JSON text + an external buffer/image loader. */
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
    detail: `${json.buffers?.length ?? 0} external buffers`,
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

// ─── General document traversal ───────────────────────────────────────────────────

/** Minimal typing of glTF-JSON (the rest is raw). */
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

/** Assemble the decoded model from the JSON document. */
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

  // Images: bytes arrive by ranges, the bitmap is decoded lazily
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
    // The whenImagesDecoded progress is not broken by individual failures
    imageBitmaps.push(bitmap.then(() => {}, () => {}))

    const startDecode = (): void => {
      try {
        if (createBitmap === undefined) {
          rejectBitmap(new Error('createImageBitmap is not available in this environment'))
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
        rejectBitmap(new Error(`image ${name}: bufferView ${raw.bufferView} not found`))
        continue
      }
      const byteOffset = view.byteOffset ?? 0
      const byteLength = view.byteLength
      const source = ctx.buffers[view.buffer ?? 0]
      if (source === undefined) {
        rejectBitmap(new Error(`image ${name}: buffer ${view.buffer ?? 0} not found`))
        continue
      }
      if (source.ready(byteOffset, byteLength)) {
        bytes = source.view(byteOffset, byteLength)
        startDecode()
      } else {
        // The range is still downloading: decoding starts when bytes arrive
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
      rejectBitmap(new Error(`image ${name}: neither bufferView nor a uri loader`))
    }
  }

  // Primitive parse order = data order in the file (progressive)
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
          'primitive compressed with KHR_draco_mesh_compression, but no decoder passed ' +
            '(GltfParseOptions.dracoDecoder) — compressed geometry cannot be read',
        )
      const view = bufferViews[draco.bufferView]
      if (view === undefined) throw new Error(`Draco: bufferView ${draco.bufferView} not found`)
      const source = ctx.buffers[view.buffer ?? 0]
      if (source === undefined) throw new Error(`Draco: buffer ${view.buffer ?? 0} not found`)
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
      detail: `${parsedCount}/${plans.length} primitives`,
    })
  }
  ctx.phase({ stage: 'geometry', ratio: 0.95, detail: `${parsedCount} primitives` })

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

// ─── Accessors ───────────────────────────────────────────────────────────────

/** Read a float attribute (POSITION/NORMAL/TEXCOORD_0) from an accessor. */
async function readFloatAttribute(
  accessorIndex: number | undefined,
  semantic: string,
  accessors: RawAccessor[],
  bufferViews: RawBufferView[],
  ctx: ParseContext,
): Promise<Float32Array> {
  if (accessorIndex === undefined) throw new Error(`primitive without attribute ${semantic}`)
  const accessor = accessors[accessorIndex]
  if (accessor === undefined) throw new Error(`accessor ${semantic} #${accessorIndex} not found`)
  const numComponents = TYPE_COMPONENTS[accessor.type] ?? 0
  if (numComponents === 0) throw new Error(`accessor ${semantic}: type ${accessor.type} is not a vector`)
  if (accessor.sparse !== undefined) throw new Error(`accessor ${semantic}: sparse is not supported`)
  const count = accessor.count
  if (accessor.bufferView === undefined) return new Float32Array(count * numComponents)
  const view = bufferViews[accessor.bufferView]
  if (view === undefined) throw new Error(`bufferView ${accessor.bufferView} not found (${semantic})`)
  const source = ctx.buffers[view.buffer ?? 0]
  if (source === undefined) throw new Error(`buffer ${view.buffer ?? 0} not found (${semantic})`)

  const componentType = accessor.componentType
  const componentSize = COMPONENT_SIZE[componentType] ?? 0
  if (componentSize === 0) throw new Error(`componentType ${componentType} is not supported (${semantic})`)
  const byteStride = view.byteStride ?? 0
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const tightBytes = count * numComponents * componentSize
  const spanBytes = byteStride > 0 ? (count - 1) * byteStride + numComponents * componentSize : tightBytes
  await source.wait(byteOffset, spanBytes)
  const view8 = source.view(byteOffset, spanBytes)

  // Fast-path 1: densely packed FLOAT — return a view over the body (zero-copy)
  if (byteStride === 0 && componentType === COMPONENT_FLOAT && view8.byteOffset % 4 === 0)
    return (source.zeroCopy(), new Float32Array(view8.buffer, view8.byteOffset, count * numComponents))
  // Fast-path 2: FLOAT with stride divisible by 4 — densify in one pass
  if (componentType === COMPONENT_FLOAT && byteStride > 0 && byteStride % 4 === 0 && view8.byteOffset % 4 === 0) {
    const strided = new Float32Array(view8.buffer, view8.byteOffset, view8.byteLength / 4)
    const packed = new Float32Array(count * numComponents)
    const strideComponents = byteStride / 4
    for (let vertex = 0; vertex < count; vertex++)
      packed.set(strided.subarray(vertex * strideComponents, vertex * strideComponents + numComponents), vertex * numComponents)
    return packed
  }

  // General path: component-wise reading (+ normalized conversion)
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
          throw new Error(`componentType ${componentType} is not supported`)
      }
      out[outAt++] = value
    }
  }
  return out
}

/** Read indices (SCALAR; UShort/UInt are supported). */
async function readIndices(
  accessorIndex: number,
  accessors: RawAccessor[],
  bufferViews: RawBufferView[],
  ctx: ParseContext,
): Promise<Uint16Array | Uint32Array> {
  const accessor = accessors[accessorIndex]
  if (accessor === undefined) throw new Error(`accessor indices #${accessorIndex} not found`)
  if (accessor.type !== 'SCALAR') throw new Error('indices: type is not SCALAR')
  const count = accessor.count
  if (accessor.bufferView === undefined) return new Uint16Array(0)
  const view = bufferViews[accessor.bufferView]
  if (view === undefined) throw new Error(`bufferView ${accessor.bufferView} not found (indices)`)
  const source = ctx.buffers[view.buffer ?? 0]
  if (source === undefined) throw new Error(`buffer ${view.buffer ?? 0} not found (indices)`)

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
  throw new Error(`indices componentType ${accessor.componentType} is not supported`)
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** min/max from accessor metadata, otherwise a pass over positions. */
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

/** Sampler of the first texture using the image. */
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

/** extensionsRequired: Draco is ok with a decoder; meshopt/basisu — an honest error. */
function assertRequiredExtensions(json: GltfDocument, dracoDecoder: DracoDecoder | undefined): void {
  for (const extension of json.extensionsRequired ?? []) {
    if (extension === 'KHR_draco_mesh_compression' && dracoDecoder !== undefined) continue
    if (UNSUPPORTED_EXTENSIONS.has(extension))
      throw new Error(
        `glTF requires ${extension} — ${extension === 'KHR_draco_mesh_compression' ? 'decoder not passed (GltfParseOptions.dracoDecoder)' : 'geometry/texture compression is not supported by the parser (EXT_texture_webp is supported — natively by the browser)'}`,
      )
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new DOMException('parsing cancelled', 'AbortError')
}

interface StatsInput {
  jsonBytes: number
  binBytes: number
  parseMs: number
  zeroCopyViews: number
}

/** Enriches the model with statistics (kind + stats). */
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

/** "12.3 MB" / "456 KB" (minimum 1 KB) — for progress details. */
function formatBytesRounded(bytes: number): string {
  return bytes >= 1048576
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

// ─── Task 88 bridge (AssetLibrary expects these names) ─────────────────────────────

/** GLB magic "glTF" in the first 4 bytes (a sniff for AssetLibrary). */
export function looksLikeGlb(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46
  )
}

/** Draco decoder as a type alias (AssetLibrary layer name). */
export type DracoGeometryDecoder = DracoDecoder
