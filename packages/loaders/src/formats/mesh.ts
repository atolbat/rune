/**
 * formats/mesh.ts — нейтральная модель меша (MeshDocument).
 *
 * Единый выход для OBJ/FBX/glTF: plain data, ни одного GPU/DOM-объекта.
 * Так лоадеры одинаково встраиваются и в голое ядро rune (команда/тейп),
 * и в сценовый граф (адаптер строит свои ноды), и в WebGPU/WebGL2-аплоады.
 *
 * SoA-атрибуты (planar), индексы — Uint32Array. Для interleaved-загрузки в
 * GPU есть interleavePrimitive() — она же считает форматы атрибутов.
 */

// ─── примитив ────────────────────────────────────────────────────────────────

export type MeshMode =
  | 'triangles'
  | 'triangle-strip'
  | 'triangle-fan'
  | 'lines'
  | 'line-strip'
  | 'points'

/**
 * Диапазон индексов/вершин с материалом — «submesh»/draw range.
 * НЕ readonly: парсеры FBX/OBJ достраивают сплиты после разбора слоёв;
 * потребитель не мутирует по соглашению.
 */
export interface SubMesh {
  /** Индекс в materials документа; -1 = материал по умолчанию. */
  material: number
  /** Имя группы (obj o/g, имя geometry FBX). null — безымянная. */
  name: string | null
  /** Смещение в indices (или в вершинах, если indices === null). */
  offset: number
  /** Число индексов/вершин. */
  count: number
}

/** Один drawable: набор вершинных атрибутов + индексы + материал-сплиты. */
export interface MeshPrimitive {
  /** xyz, length = 3 * vertexCount. */
  readonly positions: Float32Array
  /** xyz, length = 3 * vertexCount; null = посчитает рендер-слой. */
  readonly normals: Float32Array | null
  /** uv0, length = 2 * vertexCount. */
  readonly uvs: Float32Array | null
  /** uv1 (COLOR_ не путать: glTF TEXCOORD_1, FBX UV set 1). */
  readonly uvs2: Float32Array | null
  /** xyzw (w = handedness), length = 4 * vertexCount. */
  readonly tangents: Float32Array | null
  /** rgba ПО БАЙТАМ (0..255), length = 4 * vertexCount; normalized на GPU. */
  readonly colors: Uint8Array | null
  /** Скин: 4 joint-индекса на вершину. */
  readonly joints: Uint16Array | null
  /** Скин: 4 веса на вершину (сумма = 1). */
  readonly weights: Float32Array | null
  /** null = non-indexed. Всегда u32 наружу (лень даунгрейдить до u16). */
  readonly indices: Uint32Array | null
  readonly mode: MeshMode
  /** Сплиты по материалам; пусто = один draw всем буфером. */
  submeshes: SubMesh[]
  /** Морф-таргеты не входят в v1 (см. ограничения в gltf.ts). */
}

// ─── материалы ───────────────────────────────────────────────────────────────

export interface TextureInfo {
  /** Индекс в images документа. */
  readonly image: number
  /** Номер uv-сета (TEXCOORD_n / UV set n). */
  readonly texCoord: number
  /** Индекс в samplers документа; null = дефолт. */
  readonly sampler: number | null
}

export type AlphaMode = 'opaque' | 'mask' | 'blend'

/** PBR-ish материал; OBJ/FBX конвертируются в него с потерями (source). */
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
  /** Откуда материал: у OBJ/FBX — эвристическое отображение. */
  readonly source: 'gltf' | 'obj' | 'fbx'
}

// ─── картинки/сэмплеры ───────────────────────────────────────────────────────

/** Картинка: байты ИЛИ отложенный uri (грузить лениво image-лоадером). */
export interface ImageAsset {
  readonly name: string | null
  readonly mimeType: string | null
  /** Байты для декодера (view в исходном буфере или срез). null = uri. */
  readonly bytes: Uint8Array | null
  /** Внешний uri (не materialized). */
  readonly uri: string | null
}

export interface SamplerData {
  readonly magFilter: number | null
  readonly minFilter: number | null
  readonly wrapS: number
  readonly wrapT: number
}

// ─── сцена/ноды ──────────────────────────────────────────────────────────────

/** Трансформация ноды: TRS ИЛИ matrix (что задал формат). */
export interface NodeData {
  readonly name: string | null
  readonly translation: readonly [number, number, number]
  /** Кватернион xyzw. */
  readonly rotation: readonly [number, number, number, number]
  readonly scale: readonly [number, number, number]
  /** Column-major 4x4, если формат дал матрицу (glTF node.matrix, FBX Lcl+Pre). */
  readonly matrix: Float32Array | null
  /** Индексы примитивов в meshes документа (парсеры дописывают). */
  primitives: number[]
  /** Индекс в skins; -1 = не скиннут. */
  skin: number
  /** Индексы дочерних нод в nodes (парсеры дописывают). */
  children: number[]
}

export interface SkinData {
  readonly name: string | null
  /** Индексы нод-костей (в nodes). */
  readonly joints: readonly number[]
  /** 16 floats на кость, column-major. */
  readonly inverseBindMatrices: Float32Array | null
}

// ─── анимации ────────────────────────────────────────────────────────────────

export type AnimationPath = 'translation' | 'rotation' | 'scale' | 'weights'

export interface AnimationChannel {
  /** Индекс ноды в nodes. */
  readonly node: number
  readonly path: AnimationPath
  /** Времена, сек. */
  readonly times: Float32Array
  /**
   * Значения; layout: translation/scale = 3f, rotation = 4f (xyzw),
   * weights = weightCount floats (число морфов примитива ноды).
   */
  readonly values: Float32Array
  /** Специфичное для FBX: интерполяция сырым P70-массивом не хранится. */
  readonly interpolation: 'linear' | 'step' | 'cubicspline'
}

export interface AnimationData {
  readonly name: string | null
  /** Длительность, сек (max по каналам). */
  readonly duration: number
  readonly channels: readonly AnimationChannel[]
}

// ─── документ ────────────────────────────────────────────────────────────────

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
  /** Имена исходных мешей (glTF mesh.name / FBX Geometry name / obj o). */
  readonly meshNames: readonly (string | null)[]
  readonly meshes: readonly MeshPrimitive[]
  readonly materials: readonly MaterialData[]
  readonly images: readonly ImageAsset[]
  readonly samplers: readonly SamplerData[]
  readonly nodes: readonly NodeData[]
  /** Индексы корневых нод. */
  readonly scenes: readonly number[][]
  readonly skins: readonly SkinData[]
  readonly animations: readonly AnimationData[]
  readonly stats: MeshStats
  /** OBJ: список mtllib, которые были найдены/загружены. */
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
  /** Смещение внутри вершины, байты. */
  readonly offset: number
  /** Число компонентов (vec2/3/4). */
  readonly components: number
  /** 'f32' | 'u8norm' | 'u16'. */
  readonly format: 'f32' | 'u8norm' | 'u16'
}

export interface InterleaveResult {
  /** Interleaved-данные; length = stride * vertexCount. */
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
 * Interleave выбранных атрибутов примитива в один буфер.
 * position/normal/uv/tangent/weights → f32; color → unorm8x4; joints → u16x4.
 * Отсутствующий атрибут в примитиве — ошибка (выбирайте по наличию сами,
 * например только position+normal+uv для простых материалов).
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
    if (!present) throw new Error(`interleavePrimitive: атрибут ${attr} отсутствует в примитиве`)
    const format: InterleavedAttribute['format'] =
      attr === 'color' ? 'u8norm' : attr === 'joints' ? 'u16' : 'f32'
    const byteSize = format === 'f32' ? 4 : format === 'u16' ? 2 : 1
    // выравнивание: f32/u16 на кратное их размеру
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

/** Материал по индексу с фолбэком на дефолт (index -1/вне диапазона). */
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

/** Собрать MeshStats по массивам (хелпер для парсеров). */
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
