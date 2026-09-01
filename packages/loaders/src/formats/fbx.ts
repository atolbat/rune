/**
 * formats/fbx.ts — Autodesk FBX binary 7.x → MeshDocument.
 *
 * Разбор контейнера: заголовок «Kaydara FBX Binary» + u32 версия; далее
 * вложенные записи: [endOffset, numProps, propListLen, nameLen, name,
 * props..., children..., NULL-запись]. Версии ≥ 7500 хранят три первых
 * поля как u64 (NULL-запись 25 байт вместо 13). Всё по DataView,
 * little-endian, без строк до имён.
 *
 * Свойства: 'Y' i16, 'C' bool, 'I' i32, 'F' f32, 'D' f64, 'L' i64,
 * 'S' строка, 'R' raw, массивы 'f' 'd' 'l' 'i' 'b' (count, encoding
 * 0=raw / 1=zlib, byteLen). zlib-массивы распаковываются через
 * ctx.inflate (DecompressionStream) — поэтому parse асинхронный.
 *
 * Геометрия: Vertices (контроль-точки), PolygonVertexIndex (конец полигона
 * кодируется как ~i), LayerElementNormal (ByVertice/ByPolygonVertex/
 * ByPolygon/AllSame × Direct/IndexToDirect), LayerElementUV (UV+UVIndex),
 * LayerElementMaterial (ByPolygon → сплиты сабмешей). Стратегия вывода:
 * ByVertice+Direct-нормали и по-вершинные UV → индексированный примитив;
 * любое face-varying → развёрнутый (non-indexed) с угловыми атрибутами.
 *
 * Модели: Properties70 → Lcl Translation/Rotation(deg)/Scaling +
 * RotationOrder (default 0 = 'ZYX' по конвенции FBX). PreRotation и
 * Geometric-смещения v1 НЕ применяются (документированное ограничение —
 * файлы с не-нулевыми pivot'ами дадут сдвиг). Иерархия — из Connections
 * «OO» Model→Model; Geometry→Model; Material→Geometry (по слою или один
 * на геометрию); Texture→Material через «OP» c propName (DiffuseColor →
 * baseColor, NormalMap → normal).
 *
 * НЕ поддержано в v1: ASCII-FBX (чёткая ошибка), FBX 6.x (u32-структура
 * Kaydara v6), skins/Deformer, анимационные стеки, blendshapes,
 * NURBS/камеры/свет. Пивоты PreRotation/GeometricTranslation не
 * применяются.
 */

import type { ParseContext, ParseInput, Parser } from '../core/types.ts'
import { ParseError, UnsupportedError, throwIfAborted } from '../core/errors.ts'
import type {
  ImageAsset,
  MaterialData,
  MeshDocument,
  MeshPrimitive,
  NodeData,
  SubMesh,
  TextureInfo,
} from './mesh.ts'
import { meshStatsOf } from './mesh.ts'

// ─── дерево нод ──────────────────────────────────────────────────────────────

export type FbxValue =
  | number
  | boolean
  | string
  | Uint8Array
  | Int8Array
  | Int16Array
  | Int32Array
  | BigInt64Array
  | Float32Array
  | Float64Array

export interface FbxProp {
  readonly type: string
  readonly value: FbxValue
}

export interface FbxNode {
  readonly name: string
  readonly props: readonly FbxProp[]
  readonly children: readonly FbxNode[]
}

// ─── контейнер ───────────────────────────────────────────────────────────────

const FBX_MAGIC = 'Kaydara FBX Binary  \x00\x1a\x00' // 23 байта
const FBX_MIN_VERSION = 7000

export interface FbxDocument {
  readonly version: number
  readonly root: FbxNode
}

/** Разбор FBX-дерева из байтов (async из-за zlib-массивов). */
export async function parseFbxTree(bytes: Uint8Array, ctx: ParseContext): Promise<FbxDocument> {
  const url = ctx.sourceUrl
  if (bytes.length < 27) throw new ParseError('FBX: файл короче заголовка', 0, url)
  for (let i = 0; i < FBX_MAGIC.length; i++) {
    if (bytes[i] !== FBX_MAGIC.charCodeAt(i)) {
      // ASCII-вариант начинается с ';' или текста
      const head = String.fromCharCode(...bytes.subarray(0, Math.min(64, bytes.length)))
      if (head.includes('FBXHeaderExtension') || head.startsWith(';')) {
        throw new UnsupportedError('FBX: ASCII-формат не поддерживается — конвертируйте в Binary (FBX SDK/Blender: «FBX binary»)', url)
      }
      throw new ParseError('FBX: неверная магика (не бинарный FBX)', 0, url)
    }
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = dv.getUint32(23, true)
  if (version < FBX_MIN_VERSION) {
    throw new UnsupportedError(`FBX: версия ${version} (6.x и старше) не поддерживается`, url)
  }
  const u64 = version >= 7500
  const pos = 27
  const children: FbxNode[] = []
  let cursor = pos
  while (cursor + (u64 ? 25 : 13) <= bytes.length) {
    const node = await parseNode(dv, cursor, bytes.length, u64, ctx, url)
    if (node === null) break
    children.push(node.node)
    cursor = node.end
  }
  return { version, root: { name: '__root__', props: [], children } }
}

interface ParsedNode {
  readonly node: FbxNode
  readonly end: number
}

async function parseNode(
  dv: DataView,
  start: number,
  fileEnd: number,
  u64: boolean,
  ctx: ParseContext,
  url: string | null,
): Promise<ParsedNode | null> {
  if (start >= fileEnd) return null
  // NULL-запись: нулевые поля
  const isNull =
    isZeroField(dv, start, u64) &&
    isZeroField(dv, start + (u64 ? 8 : 4), u64) &&
    isZeroField(dv, start + (u64 ? 16 : 8), u64)
  if (isNull) {
    // + nameLen (0) — просто выходим (children закончились на уровне выше)
    return null
  }
  const endOffset = u64 ? Number(dv.getBigUint64(start, true)) : dv.getUint32(start, true)
  const numProps = u64 ? Number(dv.getBigUint64(start + 8, true)) : dv.getUint32(start + 4, true)
  const nameLen = dv.getUint8(start + (u64 ? 24 : 12))
  const nameStart = start + (u64 ? 25 : 13)
  if (endOffset > fileEnd || endOffset <= nameStart) {
    throw new ParseError(`FBX: кривой endOffset у ноды на ${start}`, start, url)
  }
  const name = String.fromCharCode(...new Uint8Array(dv.buffer, dv.byteOffset + nameStart, nameLen))
  let cursor = nameStart + nameLen
  const props: FbxProp[] = []
  for (let i = 0; i < numProps; i++) {
    const parsed = await parseProp(dv, cursor, u64, ctx, url)
    props.push(parsed.prop)
    cursor = parsed.end
  }
  // дети до endOffset (с учётом NULL-записей)
  const children: FbxNode[] = []
  while (cursor + (u64 ? 25 : 13) <= endOffset) {
    const child = await parseNode(dv, cursor, endOffset, u64, ctx, url)
    if (child === null) {
      break // NULL-запись (25/13 байт) — дальше детей нет
    }
    children.push(child.node)
    cursor = child.end
  }
  return { node: { name, props, children }, end: endOffset }
}

function isZeroField(dv: DataView, at: number, u64: boolean): boolean {
  if (u64) return dv.getBigUint64(at, true) === 0n
  return dv.getUint32(at, true) === 0
}

interface ParsedProp {
  readonly prop: FbxProp
  readonly end: number
}

async function parseProp(
  dv: DataView,
  at: number,
  u64: boolean,
  ctx: ParseContext,
  url: string | null,
): Promise<ParsedProp> {
  void u64
  const t = String.fromCharCode(dv.getUint8(at))
  const p = at + 1
  switch (t) {
    case 'Y': return { prop: { type: t, value: dv.getInt16(p, true) }, end: p + 2 }
    case 'C': return { prop: { type: t, value: dv.getUint8(p) !== 0 }, end: p + 1 }
    case 'I': return { prop: { type: t, value: dv.getInt32(p, true) }, end: p + 4 }
    case 'F': return { prop: { type: t, value: dv.getFloat32(p, true) }, end: p + 4 }
    case 'D': return { prop: { type: t, value: dv.getFloat64(p, true) }, end: p + 8 }
    case 'L': return { prop: { type: t, value: Number(dv.getBigInt64(p, true)) }, end: p + 8 }
    case 'S': case 'R': {
      const len = dv.getUint32(p, true)
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset + p + 4, len)
      const value = t === 'S' ? fbxString(bytes) : bytes
      return { prop: { type: t, value }, end: p + 4 + len }
    }
    case 'f': case 'd': case 'l': case 'i': case 'b': {
      const arrayLen = dv.getUint32(p, true)
      const encoding = dv.getUint32(p + 4, true)
      const byteLen = dv.getUint32(p + 8, true)
      const dataStart = p + 12
      let bytes = new Uint8Array(dv.buffer, dv.byteOffset + dataStart, byteLen)
      if (encoding === 1) {
        if (ctx.inflate === null) {
          throw new UnsupportedError('FBX: zlib-массивы требуют inflate (DecompressionStream) — недоступен', url)
        }
        bytes = await ctx.inflate(bytes)
      }
      const value = decodeFbxArray(t, bytes, arrayLen)
      return { prop: { type: t, value }, end: dataStart + byteLen }
    }
    default:
      throw new ParseError(`FBX: неизвестный тип свойства "${t}" на ${at}`, at, url)
  }
}

/** FBX-строки содержат \x00\x01-разделители имён («Model::Cube»). */
function fbxString(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]
    if (c === 0x00 && i === bytes.length - 1) continue // терминатор
    out += c === 0x00 || c === 0x01 ? ':' : String.fromCharCode(c)
  }
  return out
}

function decodeFbxArray(t: string, bytes: Uint8Array, count: number): FbxValue {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (t) {
    case 'd': {
      if (bytes.byteOffset % 8 === 0) return new Float64Array(bytes.buffer, bytes.byteOffset, count)
      const out = new Float64Array(count)
      for (let i = 0; i < count; i++) out[i] = dv.getFloat64(i * 8, true)
      return out
    }
    case 'f': {
      if (bytes.byteOffset % 4 === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, count)
      const out = new Float32Array(count)
      for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, true)
      return out
    }
    case 'i': {
      const out = new Int32Array(count)
      for (let i = 0; i < count; i++) {
        out[i] =
          dv.getUint8(i * 4) |
          (dv.getUint8(i * 4 + 1) << 8) |
          (dv.getUint8(i * 4 + 2) << 16) |
          (dv.getUint8(i * 4 + 3) << 24)
      }
      return out
    }
    case 'l': {
      const out = new BigInt64Array(count)
      for (let i = 0; i < count; i++) out[i] = dv.getBigInt64(i * 8, true)
      return out
    }
    case 'b': {
      return bytes.subarray(0, count)
    }
    default:
      throw new ParseError(`FBX: массив типа ${t}?`)
  }
}

// ─── документ из дерева ──────────────────────────────────────────────────────

interface FbxGeometry {
  id: number
  name: string
  primitive: MeshPrimitive
  materialIds: number[] // connection-attached materials (может быть пуст)
}

interface FbxObject {
  id: number
  name: string
  kind: string
  node: FbxNode
}

interface FbxConnection {
  type: 'OO' | 'OP'
  childId: number
  parentId: number
  propName: string | null
}

/** Собрать MeshDocument из FBX-дерева. */
export function fbxTreeToMeshDocument(doc: FbxDocument, ctx: ParseContext): MeshDocument {
  const root = doc.root

  // индексирование объектов и связей
  const objects = new Map<number, FbxObject>()
  const connections: FbxConnection[] = []
  for (const top of root.children) {
    if (top.name === 'Objects') {
      for (const obj of top.children) {
        if (obj.props.length < 2) continue
        const id = propNumber(obj.props[0])
        const rawName = propString(obj.props[1])
        objects.set(id, { id, name: stripFbxName(rawName), kind: obj.name, node: obj })
      }
    } else if (top.name === 'Connections') {
      for (const c of top.children) {
        if (c.name !== 'C' || c.props.length < 3) continue
        const type = propString(c.props[0])
        connections.push({
          type: type === 'OP' ? 'OP' : 'OO',
          childId: propNumber(c.props[1]),
          parentId: propNumber(c.props[2]),
          propName: c.props.length >= 4 ? propString(c.props[3]) : null,
        })
      }
    }
  }

  // материалы: сначала объекты, текстуры — вторым проходом
  interface MatBuilder {
    id: number
    data: Omit<MaterialData, 'baseColorTexture' | 'normalTexture'>
    baseTex: TextureInfo | null
    normalTex: TextureInfo | null
  }
  const matBuilders: MatBuilder[] = []
  const materialIndex = new Map<number, number>()
  for (const obj of objects.values()) {
    if (obj.kind !== 'Material') continue
    const props70 = findChild(obj.node, 'Properties70')
    const p = props70 !== null ? readP70(props70) : new Map<string, number[]>()
    const diffuse = p.get('DiffuseColor') ?? [0.8, 0.8, 0.8]
    const emissive = p.get('EmissiveColor') ?? [0, 0, 0]
    const transparency = p.get('TransparencyFactor') ?? [0]
    const shininess = p.get('ShininessExponent') ?? p.get('Shininess') ?? [20]
    const alpha = 1 - clamp01(transparency[0] ?? 0)
    const roughness = shininess[0] > 0 ? clamp01(1 - Math.log10(shininess[0] + 1) / 3) : 1
    materialIndex.set(obj.id, matBuilders.length)
    matBuilders.push({
      id: obj.id,
      baseTex: null,
      normalTex: null,
      data: {
        name: obj.name,
        baseColor: [diffuse[0], diffuse[1], diffuse[2], alpha],
        metallic: 0,
        roughness,
        emissive: [emissive[0], emissive[1], emissive[2]],
        emissiveStrength: 1,
        normalScale: 1,
        occlusionStrength: 1,
        alphaMode: alpha < 1 ? 'blend' : 'opaque',
        alphaCutoff: 0.5,
        doubleSided: false,
        metallicRoughnessTexture: null,
        emissiveTexture: null,
        occlusionTexture: null,
        source: 'fbx',
      },
    })
  }

  // текстуры: Texture-объекты + OP-коннекты к материалам
  const images: ImageAsset[] = []
  const imageIndexCache = new Map<string, number>()
  for (const conn of connections) {
    if (conn.type !== 'OP') continue
    const matIdx = materialIndex.get(conn.parentId)
    if (matIdx === undefined) continue
    const texObj = objects.get(conn.childId)
    if (texObj === undefined || texObj.kind !== 'Texture') continue
    // путь к файлу: RelativeFilename/FileName (значение — последний проп)
    const rel = findChild(texObj.node, 'RelativeFilename') ?? findChild(texObj.node, 'FileName')
    let file: string | null = null
    if (rel !== null && rel.props.length > 0) {
      file = propString(rel.props[rel.props.length - 1])
    }
    if (file === null || file.length === 0) {
      file = texObj.name
    }
    if (file.length === 0) continue
    let imageIdx = imageIndexCache.get(file)
    if (imageIdx === undefined) {
      imageIdx = images.length
      imageIndexCache.set(file, imageIdx)
      images.push({ name: file, mimeType: null, bytes: null, uri: ctx.resolveUrl(ctx.sourceUrl, file) })
    }
    const tex: TextureInfo = { image: imageIdx, texCoord: 0, sampler: null }
    const builder = matBuilders[matIdx]
    if (builder !== undefined) {
      if (conn.propName === 'NormalMap' || conn.propName === 'Bump') builder.normalTex = tex
      else builder.baseTex = tex
    }
  }
  const materials: MaterialData[] = matBuilders.map(b => ({
    ...b.data,
    baseColorTexture: b.baseTex,
    normalTexture: b.normalTex,
  }))

  // геометрии
  const geometries: FbxGeometry[] = []
  const geometryIndexById = new Map<number, number>()
  for (const obj of objects.values()) {
    if (obj.kind !== 'Geometry') continue
    const index = geometries.length
    geometryIndexById.set(obj.id, index)
    geometries.push({
      id: obj.id,
      name: obj.name,
      primitive: parseFbxGeometry(obj.node, ctx),
      materialIds: [],
    })
  }
  // материалы → геометрии (OO-коннекты)
  for (const conn of connections) {
    if (conn.type !== 'OO') continue
    const gIdx = geometryIndexById.get(conn.parentId)
    const mIdx = materialIndex.get(conn.childId)
    if (gIdx !== undefined && mIdx !== undefined) {
      geometries[gIdx].materialIds.push(mIdx)
    }
  }

  // модели → NodeData
  const modelIds: number[] = []
  const nodes: NodeData[] = []
  const nodeIndexByModel = new Map<number, number>()
  for (const obj of objects.values()) {
    if (obj.kind !== 'Model') continue
    const index = nodes.length
    nodeIndexByModel.set(obj.id, index)
    modelIds.push(obj.id)
    const p70 = findChild(obj.node, 'Properties70')
    const p = p70 !== null ? readP70(p70) : new Map()
    const translation = p.get('Lcl Translation') ?? [0, 0, 0]
    const rotation = p.get('Lcl Rotation') ?? [0, 0, 0]
    const scale = p.get('Lcl Scaling') ?? [1, 1, 1]
    const rotationOrderNum = p.get('RotationOrder')?.[0] ?? 0
    const quat = eulerDegToQuat(
      rotation[0], rotation[1], rotation[2],
      fbxEulerOrder(rotationOrderNum),
    )
    nodes.push({
      name: obj.name,
      translation: [translation[0], translation[1], translation[2]],
      rotation: [quat[0], quat[1], quat[2], quat[3]],
      scale: [scale[0], scale[1], scale[2]],
      matrix: null,
      primitives: [],
      skin: -1,
      children: [],
    })
  }

  // иерархия + привязка геометрий
  const roots: number[] = []
  for (const modelId of modelIds) {
    const nodeIdx = nodeIndexByModel.get(modelId) as number
    let hasParent = false
    for (const conn of connections) {
      if (conn.type !== 'OO' || conn.childId !== modelId) continue
      if (conn.parentId === 0) continue
      // родитель — модель?
      const parentIdx = nodeIndexByModel.get(conn.parentId)
      if (parentIdx !== undefined) {
        nodes[parentIdx].children.push(nodeIdx)
        hasParent = true
        continue
      }
      // родитель — геометрия? (коннект Geometry→Model — ребёнок геометрия)
      const gIdx = geometryIndexById.get(conn.childId)
      if (gIdx !== undefined && conn.parentId === modelId) {
        nodes[nodeIdx].primitives.push(gIdx)
        hasParent = true
      }
    }
    // геометрии, привязанные как «ребёнок = geometry, родитель = модель»
    for (const conn of connections) {
      if (conn.type !== 'OO') continue
      const gIdx = geometryIndexById.get(conn.childId)
      if (gIdx === undefined) continue
      if (conn.parentId === modelId) {
        const already = nodes[nodeIdx].primitives.includes(gIdx)
        if (!already) nodes[nodeIdx].primitives.push(gIdx)
      }
    }
    if (!hasParent) roots.push(nodeIdx)
  }
  // если корней нет (нет коннектов) — все модели корневые
  if (roots.length === 0 && nodes.length > 0) {
    for (let i = 0; i < nodes.length; i++) roots.push(i)
  }

  // материалы геометрий без слоёв → единственный submesh c этим материалом
  for (const geometry of geometries) {
    const prim = geometry.primitive
    if (prim.submeshes.length === 0 && geometry.materialIds.length > 0) {
      const count = prim.indices !== null ? prim.indices.length : prim.positions.length / 3
      const sub: SubMesh = {
        material: geometry.materialIds[0],
        name: geometry.name,
        offset: 0,
        count,
      }
      prim.submeshes.push(sub)
    } else if (prim.submeshes.length > 1 && geometry.materialIds.length > 0) {
      // слоёв может не быть с корректными материалами — заменить -1 на первый
      for (const sub of prim.submeshes) {
        if (sub.material < 0) sub.material = geometry.materialIds[0]
      }
    }
  }

  return {
    source: 'fbx',
    meshNames: geometries.map(g => g.name),
    meshes: geometries.map(g => g.primitive),
    materials,
    images,
    samplers: [],
    nodes,
    scenes: [roots],
    skins: [],
    animations: [],
    stats: meshStatsOf(
      geometries.map(g => g.primitive),
      materials, images, nodes, [],
    ),
  }
}

// ─── геометрия ───────────────────────────────────────────────────────────────

function parseFbxGeometry(node: FbxNode, ctx: ParseContext): MeshPrimitive {
  const url = ctx.sourceUrl
  const verticesNode = findChild(node, 'Vertices')
  const pviNode = findChild(node, 'PolygonVertexIndex')
  if (verticesNode === null || pviNode === null) {
    throw new ParseError(`FBX Geometry "${node.name}": нет Vertices/PolygonVertexIndex`, -1, url)
  }
  // массивы лежат в первом пропе ноды (Vertices: 'd' [...])
  const controlPoints = propNumbers(verticesNode.props[0])
  const polyIndex = propInts(pviNode.props[0])

  // полигоны: [start, len] по маркерам ~i
  const polygons: Array<[number, number]> = []
  let polyStart = 0
  for (let i = 0; i < polyIndex.length; i++) {
    if (polyIndex[i] < 0) {
      polygons.push([polyStart, i - polyStart + 1])
      polyStart = i + 1
    }
  }

  // слои
  const layerNormal = findDescendant(node, 'LayerElementNormal')
  const layerUv = findDescendant(node, 'LayerElementUV')
  const layerMaterial = findDescendant(node, 'LayerElementMaterial')

  const normalData = layerNormal !== null ? parseLayerElement(layerNormal, 3) : null
  const uvData = layerUv !== null ? parseLayerElement(layerUv, 2) : null
  const materialData = layerMaterial !== null ? parseLayerElement(layerMaterial, 1) : null

  // per-polygon материал
  let polyMaterials: Int32Array | null = null
  if (materialData !== null) {
    if (
      (materialData.mapping === 'ByPolygon' || materialData.mapping === 'ByPolygonVertex') &&
      materialData.values instanceof Int32Array
    ) {
      polyMaterials = materialData.values
    } else if (materialData.mapping === 'AllSame' && materialData.values.length > 0) {
      polyMaterials = new Int32Array(polygons.length).fill(materialData.values[0])
    }
  }

  // индексированный путь возможен, если нормали/UV по вершинам
  const normalsPerVertex =
    normalData !== null && (normalData.mapping === 'ByVertice' || normalData.mapping === 'ByVertex') && normalData.indexed === null
  const uvPerVertex =
    uvData === null || ((uvData.mapping === 'ByVertice' || uvData.mapping === 'ByVertex') && uvData.indexed === null)

  if (normalsPerVertex && uvPerVertex) {
    // ── индексированный примитив ──
    // точное число треугольников после веерной триангуляции
    const triCount = polygons.reduce((acc, [, len]) => acc + Math.max(0, len - 2), 0)
    const indices = new Uint32Array(triCount * 3)
    let w = 0
    for (const [start, len] of polygons) {
      for (let k = 1; k + 1 < len; k++) {
        indices[w++] = absIndex(polyIndex[start])
        indices[w++] = absIndex(polyIndex[start + k])
        indices[w++] = absIndex(polyIndex[start + k + 1])
      }
    }
    const normals = normalData !== null ? toF32(normalData.values) : null
    const uvs = uvData !== null ? toF32(uvData.values) : null
    // submesh по материалам полигонов
    const submeshes: SubMesh[] = buildPolygonSubmeshes(polygons, polyMaterials, indices, null)
    return {
      positions: toF32(controlPoints),
      normals,
      uvs,
      uvs2: null,
      tangents: null,
      colors: null,
      joints: null,
      weights: null,
      indices: indices.length > 0 ? indices : null,
      mode: 'triangles',
      submeshes,
    }
  }

  // ── развёрнутый (face-varying) примитив ──
  const triCount = polygons.reduce((acc, [, len]) => acc + Math.max(0, len - 2), 0)
  const positions = new Float32Array(triCount * 9)
  const normals = normalData !== null ? new Float32Array(triCount * 9) : null
  const uvs = uvData !== null ? new Float32Array(triCount * 6) : null
  const triMaterial = new Int32Array(triCount).fill(-1)
  let tri = 0
  for (let pi = 0; pi < polygons.length; pi++) {
    const [start, len] = polygons[pi]
    const mat = polyMaterials !== null ? (polyMaterials[pi] ?? -1) : -1
    for (let k = 1; k + 1 < len; k++, tri++) {
      const corners = [start, start + k, start + k + 1]
      for (let ci = 0; ci < 3; ci++) {
        const corner = corners[ci]        // индекс в polyIndex (по углам)
        const cp = absIndex(polyIndex[corner])
        positions.set(controlPoints.subarray(cp * 3, cp * 3 + 3), tri * 9 + ci * 3)
        if (normals !== null && normalData !== null) {
          const n = sampleLayer(normalData, corner, cp, pi)
          normals.set(n.subarray(0, 3), tri * 9 + ci * 3)
        }
        if (uvs !== null && uvData !== null) {
          const u = sampleLayer(uvData, corner, cp, pi)
          if (u.length >= 2) {
            uvs[tri * 6 + ci * 2] = u[0]
            uvs[tri * 6 + ci * 2 + 1] = u[1]
          }
        }
      }
      triMaterial[tri] = mat
    }
    if ((pi & 2047) === 0 && pi > 0) throwIfAborted(ctx.signal, 'fbx parse')
  }
  const submeshes: SubMesh[] = []
  let runStart = 0
  let runMat = triMaterial.length > 0 ? triMaterial[0] : -1
  for (let t = 1; t <= triMaterial.length; t++) {
    if (t === triMaterial.length || triMaterial[t] !== runMat) {
      submeshes.push({ material: runMat, name: null, offset: runStart * 3, count: (t - runStart) * 3 })
      runStart = t
      runMat = t < triMaterial.length ? triMaterial[t] : -1
    }
  }
  if (submeshes.length === 0 && triCount > 0) {
    submeshes.push({ material: -1, name: null, offset: 0, count: triCount * 3 })
  }
  return {
    positions,
    normals,
    uvs,
    uvs2: null,
    tangents: null,
    colors: null,
    joints: null,
    weights: null,
    indices: null,
    mode: 'triangles',
    submeshes,
  }
}

/** Диапазоны индексов по материалам полигонов (для indexed-пути). */
function buildPolygonSubmeshes(
  polygons: Array<[number, number]>,
  polyMaterials: Int32Array | null,
  indices: Uint32Array,
  _cornerBase: null,
): SubMesh[] {
  if (polyMaterials === null) return []
  // сколько треугольников до каждого полигона
  let triBase = 0
  const ranges: Array<{ material: number; triStart: number; triEnd: number }> = []
  for (let pi = 0; pi < polygons.length; pi++) {
    const [, len] = polygons[pi]
    const tris = Math.max(0, len - 2)
    const mat = polyMaterials[pi] ?? -1
    const last = ranges.length - 1
    if (last >= 0 && ranges[last].material === mat) {
      ranges[last].triEnd += tris
    } else {
      ranges.push({ material: mat, triStart: triBase, triEnd: triBase + tris })
    }
    triBase += tris
  }
  const out: SubMesh[] = []
  for (const r of ranges) {
    if (r.triEnd <= r.triStart) continue
    out.push({
      material: r.material,
      name: null,
      offset: r.triStart * 3,
      count: (r.triEnd - r.triStart) * 3,
    })
  }
  void indices
  return out
}

interface LayerData {
  mapping: string          // ByVertice/ByPolygonVertex/ByPolygon/AllSame
  values: Float64Array | Int32Array
  /** IndexToDirect: индексы (по углам или по полигонам); null = Direct. */
  indexed: Int32Array | null
  valueStride: number
}

function parseLayerElement(node: FbxNode, stride: number): LayerData {
  const mapping = findChildString(node, 'MappingInformationType') ?? 'ByPolygonVertex'
  // values: первый числовой массив-ребёнок с нужным stride (Normals/UV/Materials)
  let values: Float64Array | Int32Array = new Float64Array(0)
  let indexed: Int32Array | null = null
  for (const child of node.children) {
    // значения слоя лежат в первом пропе дочерней ноды (Normals: 'd' [...])
    const arr = propArray(child.props[0])
    if (arr === null) continue
    if (child.name === 'Normals' || child.name === 'UV' || child.name === 'Materials') {
      values = arr
    } else if (child.name === 'NormalsIndex' || child.name === 'UVIndex' || child.name === 'MaterialsIndex' || child.name === 'Index' || child.name === 'Indexes') {
      indexed = arr instanceof Int32Array ? arr : Int32Array.from(arr as Float64Array)
    }
  }
  return { mapping, values, indexed, valueStride: stride }
}

/** Выборка значения слоя для угла corner / контроль-точки cp / полигона pi. */
function sampleLayer(layer: LayerData, corner: number, cp: number, poly: number): Float64Array | Int32Array {
  const stride = layer.valueStride
  if (layer.mapping === 'ByVertice' || layer.mapping === 'ByVertex') {
    return subarraySafe(layer.values, cp * stride, stride)
  }
  if (layer.mapping === 'ByPolygonVertex') {
    if (layer.indexed !== null) {
      const idx = layer.indexed[corner] ?? 0
      return subarraySafe(layer.values, idx * stride, stride)
    }
    return subarraySafe(layer.values, corner * stride, stride)
  }
  if (layer.mapping === 'ByPolygon') {
    if (layer.indexed !== null) {
      const idx = layer.indexed[poly] ?? 0
      return subarraySafe(layer.values, idx * stride, stride)
    }
    return subarraySafe(layer.values, poly * stride, stride)
  }
  // AllSame
  return subarraySafe(layer.values, 0, stride)
}

function subarraySafe(values: Float64Array | Int32Array, start: number, len: number): Float64Array | Int32Array {
  if (start < 0 || start + len > values.length) {
    return values instanceof Float64Array ? new Float64Array(len) : new Int32Array(len)
  }
  return values.subarray(start, start + len)
}

function absIndex(v: number): number {
  return v < 0 ? ~v : v
}

function toF32(values: Float64Array | Int32Array): Float32Array {
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = values[i]
  return out
}

// ─── хелперы свойств/нодов ───────────────────────────────────────────────────

function findChild(node: FbxNode, name: string): FbxNode | null {
  for (const c of node.children) if (c.name === name) return c
  return null
}

function findDescendant(node: FbxNode, name: string): FbxNode | null {
  const direct = findChild(node, name)
  if (direct !== null) return direct
  for (const c of node.children) {
    const found = findDescendant(c, name)
    if (found !== null) return found
  }
  return null
}

function findChildString(node: FbxNode, name: string): string | null {
  const child = findChild(node, name)
  if (child === null || child.props.length === 0) return null
  const v = child.props[0].value
  return typeof v === 'string' ? v : null
}

function propNumber(prop: FbxProp | undefined): number {
  if (prop === undefined) return 0
  const v = prop.value
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  return 0
}

function propString(prop: FbxProp | undefined): string {
  if (prop === undefined) return ''
  return typeof prop.value === 'string' ? prop.value : ''
}

function propNumbers(prop: FbxProp | undefined): Float64Array {
  if (prop === undefined) return new Float64Array(0)
  return prop.value instanceof Float64Array ? prop.value : new Float64Array(0)
}

function propInts(prop: FbxProp | undefined): Int32Array {
  if (prop === undefined) return new Int32Array(0)
  return prop.value instanceof Int32Array ? prop.value : new Int32Array(0)
}

function propArray(prop: FbxProp | undefined): Float64Array | Int32Array | null {
  if (prop === undefined) return null
  const v = prop.value
  if (v instanceof Float64Array || v instanceof Int32Array) return v
  if (v instanceof Float32Array) return Float64Array.from(v)
  return null
}

function stripFbxName(raw: string): string {
  const sep = raw.indexOf('::')
  return sep >= 0 ? raw.slice(sep + 2) : raw
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** Properties70 → Map имя → значения (числа). */
function readP70(props70: FbxNode): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const p of props70.children) {
    if (p.name !== 'P' || p.props.length < 4) continue
    const name = propString(p.props[0])
    const values: number[] = []
    for (let i = 4; i < p.props.length; i++) {
      const v = p.props[i].value
      if (typeof v === 'number') values.push(v)
    }
    out.set(name, values)
  }
  return out
}

/** FBX RotationOrder-enum → порядок Эйлера (конвенция three.js FBXLoader). */
export function fbxEulerOrder(order: number): 'XYZ' | 'YZX' | 'XZY' | 'ZXY' | 'YXZ' | 'ZYX' {
  switch (order) {
    case 1: return 'YZX'
    case 2: return 'XZY'
    case 3: return 'ZXY'
    case 4: return 'YXZ'
    case 5: return 'ZYX'
    default: return 'ZYX' // 0 — FBX-дефолт
  }
}

/** Градусы FBX → кватернион xyzw в заданном порядке (R = R1*R2*R3). */
export function eulerDegToQuat(
  degX: number, degY: number, degZ: number,
  order: 'XYZ' | 'YZX' | 'XZY' | 'ZXY' | 'YXZ' | 'ZYX',
): [number, number, number, number] {
  const x = (degX * Math.PI) / 180
  const y = (degY * Math.PI) / 180
  const z = (degZ * Math.PI) / 180
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2)
  const cy = Math.cos(y / 2), sy = Math.sin(y / 2)
  const cz = Math.cos(z / 2), sz = Math.sin(z / 2)
  // кваты осей
  const qx: [number, number, number, number] = [sx, 0, 0, cx]
  const qy: [number, number, number, number] = [0, sy, 0, cy]
  const qz: [number, number, number, number] = [0, 0, sz, cz]
  const mul = (a: readonly number[], b: readonly number[]): [number, number, number, number] => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
  // R = R_first * R_second * R_third (как матричная композиция порядка)
  const parts = order.split('') as Array<'X' | 'Y' | 'Z'>
  const byAxis = { X: qx, Y: qy, Z: qz }
  let q = byAxis[parts[0]]
  q = mul(q, byAxis[parts[1]])
  q = mul(q, byAxis[parts[2]])
  return q
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export const fbxParser: Parser<MeshDocument> = {
  kind: 'fbx',
  extensions: ['.fbx'],
  async parse(input: ParseInput): Promise<MeshDocument> {
    const tree = await parseFbxTree(input.bytes, input.ctx)
    return fbxTreeToMeshDocument(tree, input.ctx)
  },
}

/** Разбор FBX из готовых байтов (вне менеджера). */
export async function parseFbx(bytes: Uint8Array, ctx: ParseContext): Promise<MeshDocument> {
  return fbxParser.parse({ bytes, ctx }, undefined)
}
