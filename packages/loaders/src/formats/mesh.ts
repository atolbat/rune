/**
 * formats/mesh.ts — a neutral mesh model (MeshDocument).
 *
 * A single output for OBJ/FBX/glTF: plain data, not a single GPU/DOM object.
 * This way loaders integrate equally into the bare rune core (command/tape),
 * into the scene graph (an adapter builds its own nodes), and into WebGPU/WebGL2 uploads.
 *
 * SoA attributes (planar), indices — Uint32Array. For interleaved upload into
 * the GPU there is interleavePrimitive() — it also computes attribute formats.
 */

// ─── primitive ────────────────────────────────────────────────────────────────

export type MeshMode =
  | 'triangles'
  | 'triangle-strip'
  | 'triangle-fan'
  | 'lines'
  | 'line-strip'
  | 'points'

/**
 * A range of indices/vertices with a material — a "submesh"/draw range.
 * NOT readonly: FBX/OBJ parsers complete the splits after parsing layers;
 * the consumer does not mutate it by agreement.
 */
export interface SubMesh {
  /** Index into the document materials; -1 = default material. */
  material: number
  /** Group name (obj o/g, FBX geometry name). null — unnamed. */
  name: string | null
  /** Offset in indices (or in vertices, if indices === null). */
  offset: number
  /** Number of indices/vertices. */
  count: number
}

/** One drawable: a set of vertex attributes + indices + material splits. */
export interface MeshPrimitive {
  /** xyz, length = 3 * vertexCount. */
  readonly positions: Float32Array
  /** xyz, length = 3 * vertexCount; null = the render layer computes it. */
  readonly normals: Float32Array | null
  /** uv0, length = 2 * vertexCount. */
  readonly uvs: Float32Array | null
  /** uv1 (not COLOR_: glTF TEXCOORD_1, FBX UV set 1). */
  readonly uvs2: Float32Array | null
  /** xyzw (w = handedness), length = 4 * vertexCount. */
  readonly tangents: Float32Array | null
  /** rgba BY BYTES (0..255), length = 4 * vertexCount; normalized on the GPU. */
  readonly colors: Uint8Array | null
  /** Skin: 4 joint indices per vertex. */
  readonly joints: Uint16Array | null
  /** Skin: 4 weights per vertex (sum = 1). */
  readonly weights: Float32Array | null
  /** null = non-indexed. Always u32 outward (too lazy to downgrade to u16). */
  readonly indices: Uint32Array | null
  readonly mode: MeshMode
  /** Splits by materials; empty = one draw over the whole buffer. */
  submeshes: SubMesh[]
  /** Morph targets are not included in v1 (see the limitations in gltf.ts). */
}

// ─── materials ───────────────────────────────────────────────────────────────

export interface TextureInfo {
  /** Index into the document images. */
  readonly image: number
  /** uv set number (TEXCOORD_n / UV set n). */
  readonly texCoord: number
  /** Index into the document samplers; null = default. */
  readonly sampler: number | null
}

export type AlphaMode = 'opaque' | 'mask' | 'blend'

/** PBR-ish material; OBJ/FBX are converted into it lossily (source). */
export interface MaterialData {
  readonly name: string | null
  readonly baseColor: readonly [number, number, number, number]
  readonly metallic: number
  readonly roughness: number
  readonly emissive: readonly [number, number, number]
  readonly emissiveStrength: number
  readonly normalScale: number
  readonly occlusionStrength: number
  readonly alphaMode: AlphaMode
  readonly alphaCutoff: number
  readonly doubleSided: boolean
  readonly baseColorTexture: TextureInfo | null
  readonly metallicRoughnessTexture: TextureInfo | null
  readonly normalTexture: TextureInfo | null
  readonly emissiveTexture: TextureInfo | null
  readonly occlusionTexture: TextureInfo | null
  /** Where the material came from: for OBJ/FBX — a heuristic mapping. */
  readonly source: 'gltf' | 'obj' | 'fbx'
}

// ─── images/samplers ───────────────────────────────────────────────────────

/** Image: bytes OR a deferred uri (load lazily with the image loader). */
export interface ImageAsset {
  readonly name: string | null
  readonly mimeType: string | null
  /** Bytes for a decoder (a view in the source buffer or a slice). null = uri. */
  readonly bytes: Uint8Array | null
  /** External uri (not materialized). */
  readonly uri: string | null
}

export interface SamplerData {
  readonly magFilter: number | null
  readonly minFilter: number | null
  readonly wrapS: number
  readonly wrapT: number
}

// ─── scene/nodes ──────────────────────────────────────────────────────────────

/** Node transformation: TRS OR matrix (whatever the format gave). */
export interface NodeData {
  readonly name: string | null
  readonly translation: readonly [number, number, number]
  /** Quaternion xyzw. */
  readonly rotation: readonly [number, number, number, number]
  readonly scale: readonly [number, number, number]
  /** Column-major 4x4, if the format gave a matrix (glTF node.matrix, FBX Lcl+Pre). */
  readonly matrix: Float32Array | null
  /** Indices of primitives in the document meshes (parsers append them). */
  primitives: number[]
  /** Index into skins; -1 = not skinned. */
  skin: number
  /** Indices of child nodes in nodes (parsers append them). */
  children: number[]
}

export interface SkinData {
  readonly name: string | null
  /** Indices of bone nodes (in nodes). */
  readonly joints: readonly number[]
  /** 16 floats per bone, column-major. */
  readonly inverseBindMatrices: Float32Array | null
}

// ─── animations ────────────────────────────────────────────────────────────────

export type AnimationPath = 'translation' | 'rotation' | 'scale' | 'weights'

export interface AnimationChannel {
  /** Node index in nodes. */
  readonly node: number
  readonly path: AnimationPath
  /** Times, seconds. */
  readonly times: Float32Array
  /**
   * Values; layout: translation/scale = 3f, rotation = 4f (xyzw),
   * weights = weightCount floats (the number of morphs of the node's primitive).
   */
  readonly values: Float32Array
  /** FBX-specific: interpolation by a raw P70 array is not stored. */
  readonly interpolation: 'linear' | 'step' | 'cubicspline'
}

export interface AnimationData {
  readonly name: string | null
  /** Duration, seconds (max over channels). */
  readonly duration: number
  readonly channels: readonly AnimationChannel[]
}

// ─── document ────────────────────────────────────────────────────────────────

export interface MeshStats {
  readonly meshes: number
  readonly vertices: number
  readonly triangles: number
  readonly materials: number
  readonly images: number
  readonly nodes: number
  readonly animations: number
}

export interface MeshDocument {
  readonly source: 'gltf' | 'obj' | 'fbx'
  /** Names of source meshes (glTF mesh.name / FBX Geometry name / obj o). */
  readonly meshNames: readonly (string | null)[]
  readonly meshes: readonly MeshPrimitive[]
  readonly materials: readonly MaterialData[]
  readonly images: readonly ImageAsset[]
  readonly samplers: readonly SamplerData[]
  readonly nodes: readonly NodeData[]
  /** Indices of root nodes. */
  readonly scenes: readonly number[][]
  readonly skins: readonly SkinData[]
  readonly animations: readonly AnimationData[]
  readonly stats: MeshStats
  /** OBJ: the list of mtllibs that were found/loaded. */
  readonly mtllibs?: readonly string[]
}

// ─── interleave: SoA → interleaved vertex buffer ─────────────────────────────

export type VertexAttribute =
  | 'position'
  | 'normal'
  | 'uv'
  | 'uv2'
  | 'tangent'
  | 'color'
  | 'joints'
  | 'weights'

export interface InterleavedAttribute {
  readonly attribute: VertexAttribute
  /** Offset within a vertex, bytes. */
  readonly offset: number
  /** Number of components (vec2/3/4). */
  readonly components: number
  /** 'f32' | 'u8norm' | 'u16'. */
  readonly format: 'f32' | 'u8norm' | 'u16'
}

export interface InterleaveResult {
  /** Interleaved data; length = stride * vertexCount. */
  readonly buffer: Uint8Array
  readonly stride: number
  readonly vertexCount: number
  readonly attributes: readonly InterleavedAttribute[]
}

const ATTR_SIZE: Record<VertexAttribute, number> = {
  position: 3,
  normal: 3,
  uv: 2,
  uv2: 2,
  tangent: 4,
  color: 4,
  joints: 4,
  weights: 4,
}

/**
 * Interleave the selected attributes of a primitive into one buffer.
 * position/normal/uv/tangent/weights → f32; color → unorm8x4; joints → u16x4.
 * A missing attribute in the primitive is an error (pick by presence yourself,
 * e.g., only position+normal+uv for simple materials).
 */
export function interleavePrimitive(
  primitive: MeshPrimitive,
  attrs: readonly VertexAttribute[] = ['position', 'normal', 'uv'],
): InterleaveResult {
  const vertexCount = primitive.positions.length / 3
  let offset = 0
  const layout: InterleavedAttribute[] = []
  for (const attr of attrs) {
    const present =
      (attr === 'position') ||
      (attr === 'normal' && primitive.normals !== null) ||
      (attr === 'uv' && primitive.uvs !== null) ||
      (attr === 'uv2' && primitive.uvs2 !== null) ||
      (attr === 'tangent' && primitive.tangents !== null) ||
      (attr === 'color' && primitive.colors !== null) ||
      (attr === 'joints' && primitive.joints !== null) ||
      (attr === 'weights' && primitive.weights !== null)
    if (!present) throw new Error(`interleavePrimitive: attribute ${attr} is missing in the primitive`)
    const format: InterleavedAttribute['format'] =
      attr === 'color' ? 'u8norm' : attr === 'joints' ? 'u16' : 'f32'
    const byteSize = format === 'f32' ? 4 : format === 'u16' ? 2 : 1
    // alignment: f32/u16 to a multiple of their size
    const align = format === 'f32' ? 4 : format === 'u16' ? 2 : 1
    offset = Math.ceil(offset / align) * align
    layout.push({ attribute: attr, offset, components: ATTR_SIZE[attr], format })
    offset += ATTR_SIZE[attr] * byteSize
  }
  const stride = offset
  const buffer = new Uint8Array(stride * vertexCount)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const src: Record<VertexAttribute, Float32Array | Uint8Array | Uint16Array | null> = {
    position: primitive.positions,
    normal: primitive.normals,
    uv: primitive.uvs,
    uv2: primitive.uvs2,
    tangent: primitive.tangents,
    color: primitive.colors,
    joints: primitive.joints,
    weights: primitive.weights,
  }
  for (const attr of layout) {
    const data = src[attr.attribute]
    if (data === null || data === undefined) continue
    const comps = attr.components
    const f32 = data instanceof Float32Array ? data : null
    const u8 = data instanceof Uint8Array ? data : null
    const u16 = data instanceof Uint16Array ? data : null
    for (let v = 0; v < vertexCount; v++) {
      const base = v * stride + attr.offset
      for (let c = 0; c < comps; c++) {
        if (attr.format === 'f32') {
          view.setFloat32(base + c * 4, (f32 as Float32Array)[v * comps + c], true)
        } else if (attr.format === 'u16') {
          view.setUint16(base + c * 2, (u16 as Uint16Array)[v * comps + c], true)
        } else {
          buffer[base + c] = (u8 as Uint8Array)[v * comps + c]
        }
      }
    }
  }
  return { buffer, stride, vertexCount, attributes: layout }
}

/** Material by index with a fallback to default (index -1/out of range). */
export function materialAt(doc: MeshDocument, index: number): MaterialData | null {
  if (index < 0 || index >= doc.materials.length) return null
  return doc.materials[index] ?? null
}

export const DEFAULT_MATERIAL: MaterialData = {
  name: null,
  baseColor: [1, 1, 1, 1],
  metallic: 0,
  roughness: 1,
  emissive: [0, 0, 0],
  emissiveStrength: 1,
  normalScale: 1,
  occlusionStrength: 1,
  alphaMode: 'opaque',
  alphaCutoff: 0.5,
  doubleSided: false,
  baseColorTexture: null,
  metallicRoughnessTexture: null,
  normalTexture: null,
  emissiveTexture: null,
  occlusionTexture: null,
  source: 'gltf',
}

/** Assemble MeshStats from arrays (a helper for parsers). */
export function meshStatsOf(
  meshes: readonly MeshPrimitive[],
  materials: readonly unknown[],
  images: readonly unknown[],
  nodes: readonly unknown[],
  animations: readonly unknown[],
): MeshStats {
  let vertices = 0
  let triangles = 0
  for (const m of meshes) {
    vertices += m.positions.length / 3
    const indexCount = m.indices !== null ? m.indices.length : m.positions.length / 3
    triangles += Math.floor(indexCount / 3)
  }
  return {
    meshes: meshes.length,
    vertices,
    triangles,
    materials: materials.length,
    images: images.length,
    nodes: nodes.length,
    animations: animations.length,
  }
}
