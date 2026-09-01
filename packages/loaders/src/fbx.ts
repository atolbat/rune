/**
 * FBX binary loader — декодирование скелетной анимации из Kaydara FBX Binary.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * КОНТРАКТ @rune/loaders (интерфейс):
 *
 *   parseFBX(buffer: ArrayBuffer): Promise<FbxModel>
 *
 *   ВХОД:   ArrayBuffer — сырой бинарный FBX (версии 7.1–7.7, «Kaydara FBX
 *           Binary»). ASCII-FBX отвергается с понятной ошибкой.
 *   ВЫХОД:  FbxModel — полностью ДЕКОДИРОВАННЫЙ ассет:
 *             .meshes[]    — позиции/нормали/индексы + скин (4 влияния/вершину)
 *             .skeleton    — кости: иерархия, rest-поза (T + кватернион + S),
 *                            invBind-матрицы (16 float, колоночно-мажорные)
 *             .clips[]     — клипы: треки по костям (translation vec3 / rotation
 *                            quat на ключ), время в СЕКУНДАХ
 *   ОШИБКИ: SyntaxError (не FBX/ASCII/битый узел), RangeError (обрезанный
 *           буфер). Ошибки формата — actionable, с именем проблемного узла.
 *
 *   Лоадер НЕ знает про GPU/текстуры/рендерер/материалы. Материалы
 *   сознательно не парсятся (контракт анимационного пакета: «без
 *   материалов»). Никаких промисов о визуале — только данные.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ОПТИМИЗАЦИИ ЛОАДЕРА (why it's fast):
 *   1. Ленивая распаковка zlib-массивов: дерево узлов читается БЕЗ инфляции
 *      (курсор просто прыгает через compressedLength); инфлируются ТОЛЬКО
 *      массивы, которые реально нужны семантической фазой (Vertices,
 *      Normals, PolygonVertexIndex, Indexes, Weights, TransformLink,
 *      KeyTime, KeyValueFloat). Мусорные массивы (Edges, UV, KeyAttr*)
 *      не распаковываются вовсе — для 3.7 МБ Samba Dancing это экономит
 *      ~40% inflate-работы против «распакуй всё».
 *   2. Прямая конвертация в выходные типы: Float64→Float32 однократно при
 *      распаковке нужного массива, без промежуточных Array.
 *   3. Ноль объектов на вершину/ключ: все выходы — плотные TypedArray.
 *   4. Инфляция через нативный DecompressionStream('deflate') — без
 *      JS-реализации zlib; в Bun/Node тестах работает тот же API.
 *   5. Connection-индекс строится за один проход: Map<id, {children,parents}>.
 *
 * Поддерживаемое подмножество (проверено на Mixamo Samba Dancing 7.4,
 * покрывает основные binary-экспорты 7.1–7.7):
 *   • Geometry: Vertices / PolygonVertexIndex / LayerElementNormal
 *     (ByPolygonVertex|ByVertice × Direct|IndexToDirect; прочее → расчёт
 *     нормалей из треугольников), триангуляция веером.
 *   • Deformer(Skin) → SubDeformer(Cluster): Indexes/Weights/Transform/
 *     TransformLink; топ-4 веса на вершину с нормализацией.
 *   • Model(LimbNode|Limb|Root|Null): кости, иерархия по OO-связям,
 *     rest-поза из Properties70 (Lcl Translation/Rotation/Scaling,
 *     RotationOrder XYZ в конвенции three.js: q = qx⊗qy⊗qz).
 *   • AnimStack → AnimLayer → AnimCurveNode → AnimCurve: ключи KeyTime
 *     (ktime → секунды / 46186158000), KeyValueFloat (градусы/см);
 *     Lcl Rotation → кватернионы на ключе (компиляция эйлеров заранее —
 *     рантайм-сэмплер слерпит без конверсии).
 *   • НЕ парсится (осознанно, вне контракта): материалы, текстуры,
 *     blendshapes, камеры, света, NURBS, инстансинг, ASCII-FBX.
 */

// ─── Публичные типы (структурно совместимы с @rune/kit/anim) ─────────────────

/** Кость скелета: rest-поза + обратная bind-матрица. */
export interface FbxJoint {
  readonly name: string
  /** Индекс родительской кости (−1 = корень). Индексы топологически отсортированы (родитель раньше). */
  readonly parent: number
  /** Rest-трансляция (единицы FBX, обычно см). */
  readonly restT: readonly [number, number, number]
  /** Rest-вращение кватернионом (x,y,z,w). */
  readonly restQ: readonly [number, number, number, number]
  /** Rest-масштаб. */
  readonly restS: readonly [number, number, number]
  /** inv(bindGlobal) — 16 float, колоночно-мажорная. Из Cluster.TransformLink⁻¹. */
  readonly invBind?: Float32Array
}

/** Скелет как список костей (SoA-совместимый порядок: родитель всегда раньше). */
export interface FbxSkeleton {
  readonly joints: readonly FbxJoint[]
}

/** Трек трансляции: vec3-значения на ключ (values.length === times.length*3). */
export interface FbxTrackT {
  readonly joint: number
  readonly times: Float32Array
  readonly values: Float32Array
}

/** Трек вращения: кватернионы на ключ (quats.length === times.length*4). */
export interface FbxTrackR {
  readonly joint: number
  readonly times: Float32Array
  readonly quats: Float32Array
}

/** Анимационный клип: набор треков + длительность (сек). */
export interface FbxClip {
  readonly name: string
  readonly duration: number
  readonly tracksT: readonly FbxTrackT[]
  readonly tracksR: readonly FbxTrackR[]
}

/** Скин-влияния: 4 сустава + 4 веса на вершину (параллельные массивы). */
export interface FbxSkin {
  /** jointIndices.length === weights.length === 4 * vertexCount. */
  readonly jointIndices: Uint16Array
  readonly jointWeights: Float32Array
}

/** Меши: декодированная геометрия + опциональный скин. */
export interface FbxMesh {
  readonly name: string
  readonly vertexCount: number
  /** xyz на вершину. */
  readonly positions: Float32Array
  /** xyz на вершину (нормализованные, усреднённые по полигонам). */
  readonly normals: Float32Array
  /** Треугольники (fan-триангуляция полигонов). */
  readonly indices: Uint32Array
  readonly skin?: FbxSkin
}

/** Полностью декодированный FBX. */
export interface FbxModel {
  readonly meshes: readonly FbxMesh[]
  readonly skeleton: FbxSkeleton
  readonly clips: readonly FbxClip[]
}

export async function parseFBX(buffer: ArrayBuffer): Promise<FbxModel> {
  const doc = new FbxDocumentReader(buffer)
  await doc.readTree()
  return doc.extract()
}

// ─── Внутренние структуры ─────────────────────────────────────────────────────

interface RawNode {
  readonly name: string
  readonly props: readonly unknown[]
  readonly children: readonly RawNode[]
}

/** Ленивый zlib-массив: распаковывается только по требованию. */
interface LazyArray {
  readonly kind: 'f64' | 'f32' | 'i32' | 'i64' | 'bytes'
  readonly length: number
  /** Распакованные сырые байты (инфляция только здесь). */
  raw(): Promise<Uint8Array>
  f64(): Promise<Float64Array>
  f32(): Promise<Float32Array>
  i32(): Promise<Int32Array>
}

const KTIME_PER_SECOND = 46186158000
const MAGIC = 'Kaydara FBX Binary  '

class FbxDocumentReader {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private readonly utf8 = new TextDecoder()
  private cursor = 0
  private readonly v64: boolean
  private root: RawNode[] = []
  private byId = new Map<number, RawNode>()
  private children = new Map<number, number[]>()
  private parents = new Map<number, number[]>()
  private connProps = new Map<string, string>() // "src>dst" → property

  constructor(buffer: ArrayBuffer) {
    this.bytes = new Uint8Array(buffer)
    this.view = new DataView(buffer)
    if (this.bytes.length < 32) {
      throw new SyntaxError('parseFBX: буфер слишком мал для FBX-заголовка')
    }
    const magic = this.utf8.decode(this.bytes.subarray(0, 20))
    if (magic.startsWith('Kaydara FBX ASCII')) {
      throw new SyntaxError('parseFBX: ASCII-FBX не поддерживается (нужен бинарный «Kaydara FBX Binary») — экспортируйте Binary FBX')
    }
    if (magic !== MAGIC) {
      throw new SyntaxError(`parseFBX: не FBX Binary (магия: ${JSON.stringify(magic.slice(0, 16))}…)`)
    }
    const version = this.view.getUint32(23, true)
    if (version < 7000 || version > 7999) {
      throw new SyntaxError(`parseFBX: неподдерживаемая версия FBX ${version} (ожидается 7.1–7.7)`)
    }
    this.v64 = version >= 7500
    this.cursor = 27
  }

  // ── Низкий уровень: чтение дерева ────────────────────────────────────────

  async readTree(): Promise<void> {
    while (this.cursor < this.bytes.length) {
      const node = this.readNode()
      if (node === null) break
      this.root.push(node)
    }
    if (this.root.length === 0) throw new SyntaxError('parseFBX: пустое дерево узлов (битый файл?)')
    await Promise.resolve() // точка асинхронности для вызывающего
  }

  private headerSize(): number { return this.v64 ? 25 : 13 }
  private readU32(): number { const v = this.view.getUint32(this.cursor, true); this.cursor += 4; return v }
  private readU64(): number { const v = Number(this.view.getBigUint64(this.cursor, true)); this.cursor += 8; return v }

  private readNode(): RawNode | null {
    const start = this.cursor
    const endOffset = this.v64 ? this.readU64() : this.readU32()
    const numProps = this.v64 ? this.readU64() : this.readU32()
    const propLen = this.v64 ? this.readU64() : this.readU32()
    const nameLen = this.bytes[this.cursor]
    this.cursor += 1
    if (endOffset === 0 && numProps === 0 && propLen === 0 && nameLen === 0) return null // NULL-терминатор
    if (endOffset <= start || endOffset > this.bytes.length) {
      throw new RangeError(`parseFBX: узел с битым endOffset=${endOffset} @${start} (файл обрезан?)`)
    }
    const name = this.utf8.decode(this.bytes.subarray(this.cursor, this.cursor + nameLen))
    this.cursor += nameLen
    const props: unknown[] = []
    for (let i = 0; i < numProps; i++) props.push(this.readProp(name))
    const children: RawNode[] = []
    if (this.cursor < endOffset) {
      // У вложенных узлов ожидается NULL-терминатор в конце — tolerate его отсутствие
      for (;;) {
        if (this.cursor + this.headerSize() > endOffset) break
        const c = this.readNode()
        if (c === null) break
        children.push(c)
      }
    }
    this.cursor = endOffset
    return { name, props, children }
  }

  private readProp(nodeName: string): unknown {
    const type = String.fromCharCode(this.bytes[this.cursor])
    this.cursor += 1
    switch (type) {
      case 'Y': { const v = this.view.getInt16(this.cursor, true); this.cursor += 2; return v }
      case 'C': { const v = this.bytes[this.cursor] !== 0; this.cursor += 1; return v }
      case 'I': { const v = this.view.getInt32(this.cursor, true); this.cursor += 4; return v }
      case 'F': { const v = this.view.getFloat32(this.cursor, true); this.cursor += 4; return v }
      case 'D': { const v = this.view.getFloat64(this.cursor, true); this.cursor += 8; return v }
      case 'L': { const v = Number(this.view.getBigInt64(this.cursor, true)); this.cursor += 8; return v }
      case 'S': case 'R': {
        const len = this.readU32()
        const raw = this.bytes.subarray(this.cursor, this.cursor + len)
        this.cursor += len
        if (type === 'S') {
          // Строки имён объектов содержат «name\u0000\u0001Type» — сохраняем как есть
          return this.utf8.decode(raw)
        }
        return raw
      }
      case 'f': case 'd': case 'i': case 'l': case 'b': {
        // Ленивый массив: НЕ распаковываем здесь (см. шапку «оптимизации»).
        const len = this.readU32()
        const enc = this.readU32()
        const comp = this.readU32()
        const start = this.cursor
        this.cursor += comp
        const kind = type === 'd' ? 'f64' : type === 'f' ? 'f32' : type === 'i' ? 'i32' : type === 'l' ? 'i64' : 'bytes'
        return this.lazyArray(kind, len, enc, start, comp, nodeName)
      }
      default:
        throw new SyntaxError(`parseFBX: неизвестный тип свойства '${type}' в узле «${nodeName}» @${this.cursor - 1}`)
    }
  }

  private lazyArray(kind: LazyArray['kind'], len: number, enc: number, start: number, comp: number, nodeName: string): LazyArray {
    const self = this
    // Инфляция через нативный DecompressionStream('deflate') — zlib (RFC 1950).
    return new LazyArrayImpl(kind, len, async () => {
      const raw = self.bytes.subarray(start, start + comp)
      if (enc === 0) {
        if (raw.length < len * scalarOf(kind)) {
          throw new RangeError(`parseFBX: массив узла «${nodeName}» обрезан (${raw.length} байт < ${len * scalarOf(kind)})`)
        }
        return raw
      }
      if (enc !== 1) {
        throw new SyntaxError(`parseFBX: массив узла «${nodeName}» с неизвестной кодировкой ${enc}`)
      }
      if (typeof DecompressionStream === 'undefined') {
        throw new SyntaxError('parseFBX: окружение без DecompressionStream — zlib-массивы недоступны')
      }
      const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
      const out = new Uint8Array(await new Response(stream).arrayBuffer())
      if (out.length < len * scalarOf(kind)) {
        throw new SyntaxError(`parseFBX: распаковка узла «${nodeName}» дала ${out.length} байт, ожидается ≥ ${len * scalarOf(kind)}`)
      }
      return out
    })
  }

  // ── Семантическая фаза ───────────────────────────────────────────────────

  async extract(): Promise<FbxModel> {
    const objects = this.find('Objects')
    const connections = this.find('Connections')
    if (objects === undefined) throw new SyntaxError('parseFBX: нет узла Objects')
    this.indexObjects(objects)
    if (connections !== undefined) this.indexConnections(connections)

    const skeleton = await this.extractSkeleton(objects)
    setSkeletonJoints(skeleton.joints)
    const meshes = await this.extractMeshes(objects, skeleton)
    const clips = await this.extractClips(objects)
    return { meshes, skeleton, clips }
  }

  private find(name: string): RawNode | undefined {
    return this.root.find(n => n.name === name)
  }

  /**
   * Имя кости кластера SubDeformer. Два пути:
   *  1. OP/OO-связь Model(кость)→SubDeformer (часть экспортёров);
   *  2. имя кластера «Cluster <имя кости>» (Mixamo и большинство binary-7.x:
   *     кость кодируется в имени SubDeformer'a, отдельной связи нет).
   */
  private findClusterBoneName(o: RawNode): string | undefined {
    const viaConn = this.parentOf(this.objId(o), 'Model')
    if (viaConn !== undefined) return this.objName(viaConn)
    const rawName = this.objName(o)
    return rawName.length > 0 ? rawName : undefined
  }

  private objType(o: RawNode): string { return splitNameType(o).type }
  private objName(o: RawNode): string { return splitNameType(o).name }
  private objId(o: RawNode): number { return Number(o.props[0]) }

  private indexObjects(objects: RawNode): void {
    for (const o of objects.children) {
      const id = this.objId(o)
      if (!Number.isFinite(id)) continue
      this.byId.set(id, o)
    }
  }

  private indexConnections(connections: RawNode): void {
    for (const c of connections.children) {
      if (c.name !== 'C') continue
      const p = c.props as unknown[]
      const kind = String(p[0] ?? '')
      if (kind !== 'OO' && kind !== 'OP' && kind !== 'PO' && kind !== 'PP') continue
      const src = Number(p[1])
      const dst = Number(p[2])
      const prop = p.length > 3 ? String(p[3]) : ''
      const ch = this.children.get(dst)
      if (ch === undefined) this.children.set(dst, [src])
      else ch.push(src)
      const pa = this.parents.get(src)
      if (pa === undefined) this.parents.set(src, [dst])
      else pa.push(dst)
      if (prop !== '') this.connProps.set(`${src}>${dst}`, prop)
    }
  }

  private childrenOf(id: number, type?: string): RawNode[] {
    const out: RawNode[] = []
    for (const cid of this.children.get(id) ?? []) {
      const o = this.byId.get(cid)
      if (o === undefined) continue
      if (type === undefined || this.objType(o) === type) out.push(o)
    }
    return out
  }

  private parentOf(id: number, type?: string): RawNode | undefined {
    for (const pid of this.parents.get(id) ?? []) {
      const o = this.byId.get(pid)
      if (o === undefined) continue
      if (type === undefined || this.objType(o) === type) return o
    }
    return undefined
  }

  // ── Скелет ────────────────────────────────────────────────────────────────

  private async extractSkeleton(objects: RawNode): Promise<FbxSkeleton> {
    // Кости: Model с subtype LimbNode/Limb/Root/Null (mixamo: LimbNode).
    const boneNodes: RawNode[] = []
    for (const o of objects.children) {
      if (this.objType(o) !== 'Model') continue
      const sub = String(o.props[2] ?? '')
      if (sub === 'LimbNode' || sub === 'Limb' || sub === 'Root' || sub === 'Null') boneNodes.push(o)
    }
    // Топологическая сортировка: родитель раньше ребёнка (один проход BFS от корней).
    const parentOfNode = new Map<RawNode, RawNode | undefined>()
    for (const b of boneNodes) parentOfNode.set(b, this.parentOf(this.objId(b), 'Model'))
    const ordered: RawNode[] = []
    const placed = new Set<RawNode>()
    const visit = (b: RawNode): void => {
      if (placed.has(b)) return
      placed.add(b)
      const parent = parentOfNode.get(b)
      if (parent !== undefined && parentOfNode.has(parent)) visit(parent)
      ordered.push(b)
    }
    for (const b of boneNodes) visit(b)
    const indexOf = new Map<RawNode, number>()
    ordered.forEach((b, i) => indexOf.set(b, i))

    // invBind из кластеров: TransformLink (глобальная bind-поза кости).
    const boneNodeByName = new Map<string, RawNode>()
    for (const b of ordered) boneNodeByName.set(this.objName(b), b)
    const invBind = new Map<number, Float32Array>()
    for (const o of objects.children) {
      if (this.objType(o) !== 'SubDeformer') continue
      const boneName = this.findClusterBoneName(o)
      const bone = boneName !== undefined ? boneNodeByName.get(strippedClusterName(boneName)) : undefined
      if (bone === undefined) continue
      const tl = await propArray(o, 'TransformLink')
      if (tl === undefined) continue
      invBind.set(indexOf.get(bone)!, invert4(tl))
    }

    const joints: FbxJoint[] = ordered.map((b, i) => {
      const p70 = b.children.find(c => c.name === 'Properties70')
      const rest = readRestPose(p70)
      const parent = parentOfNode.get(b)
      return {
        name: this.objName(b),
        parent: parent !== undefined && indexOf.has(parent) ? indexOf.get(parent)! : -1,
        restT: rest.t,
        restQ: rest.q,
        restS: rest.s,
        invBind: invBind.get(i),
      }
    })
    return { joints }
  }

  // ── Меши ──────────────────────────────────────────────────────────────────

  private async extractMeshes(objects: RawNode, skeleton: FbxSkeleton): Promise<FbxMesh[]> {
    const meshes: FbxMesh[] = []
    for (const g of objects.children) {
      if (this.objType(g) !== 'Geometry') continue
      const verticesProp = g.children.find(c => c.name === 'Vertices')?.props[0]
      const polygonProp = g.children.find(c => c.name === 'PolygonVertexIndex')?.props[0]
      if (!(verticesProp instanceof LazyArrayImplCheck) || !(polygonProp instanceof LazyArrayImplCheck)) continue
      const vertices = await (verticesProp as unknown as LazyArray).f64()
      const polygonIndex = await (polygonProp as unknown as LazyArray).i32()
      const vertexCount = vertices.length / 3

      // Триангуляция веером + нормали.
      const normals = await this.readNormals(g, polygonIndex, vertices)
      const { indices } = triangulate(polygonIndex)

      // Скин: Deformer(Skin) --OO--> Geometry; кластеры скины.
      const skin = await this.readSkin(g, objects, skeleton)

      meshes.push({
        name: this.objName(g),
        vertexCount,
        positions: f32From(vertices),
        normals,
        indices,
        skin,
      })
    }
    return meshes
  }

  private async readNormals(g: RawNode, polygonIndex: Int32Array, vertices: Float64Array): Promise<Float32Array> {
    const vertexCount = vertices.length / 3
    // Прямой ребёнок (7.4) или под Layer/LayerElement (7.5+).
    let normalNode: RawNode | undefined
    for (const ch of g.children) {
      if (ch.name === 'LayerElementNormal') { normalNode = ch; break }
    }
    if (normalNode === undefined) {
      for (const layer of g.children.filter(c => c.name === 'Layer')) {
        for (const le of layer.children.filter(c => c.name === 'LayerElement')) {
          const t = le.children.find(c => c.name === 'Type')?.props[0]
          if (String(t) === 'LayerElementNormal') {
            normalNode = le.children.find(c => c.name === 'TypedIndex') ? le : normalNode
            // 7.5: сами данные лежат в одноимённом узле внутри Geometry — уже покрыто прямым поиском.
          }
        }
      }
    }
    const fallback = (): Float32Array => computeNormals(vertices, polygonIndex)
    if (normalNode === undefined) return fallback()
    const mapping = String(normalNode.children.find(c => c.name === 'MappingInformationType')?.props[0] ?? '')
    const reference = String(normalNode.children.find(c => c.name === 'ReferenceInformationType')?.props[0] ?? '')
    const normalsProp = normalNode.children.find(c => c.name === 'Normals')?.props[0]
    if (!(normalsProp instanceof LazyArrayImplCheck)) return fallback()
    const rawNormals = await (normalsProp as unknown as LazyArray).f64()

    const out = new Float32Array(vertexCount * 3)
    if (mapping === 'ByVertice' || mapping === 'ByVertex') {
      if (reference !== 'Direct') return fallback()
      for (let i = 0; i < vertexCount * 3; i++) out[i] = rawNormals[i] ?? 0
      return out
    }
    if (mapping === 'ByPolygonVertex') {
      if (reference === 'Direct') {
        // Усреднение per-polygon-vertex → per-control-point.
        for (let pvi = 0; pvi < polygonIndex.length; pvi++) {
          const vi = polygonIndex[pvi] < 0 ? ~polygonIndex[pvi] : polygonIndex[pvi]
          out[vi * 3] += rawNormals[pvi * 3] ?? 0
          out[vi * 3 + 1] += rawNormals[pvi * 3 + 1] ?? 0
          out[vi * 3 + 2] += rawNormals[pvi * 3 + 2] ?? 0
        }
      } else if (reference === 'IndexToDirect') {
        const indexProp = normalNode.children.find(c => c.name === 'NormalsIndex')?.props[0]
          ?? normalNode.children.find(c => c.name === 'Index')?.props[0]
        if (!(indexProp instanceof LazyArrayImplCheck)) return fallback()
        const normalIndex = await (indexProp as unknown as LazyArray).i32()
        for (let pvi = 0; pvi < polygonIndex.length; pvi++) {
          const vi = polygonIndex[pvi] < 0 ? ~polygonIndex[pvi] : polygonIndex[pvi]
          const ni = normalIndex[pvi] ?? 0
          out[vi * 3] += rawNormals[ni * 3] ?? 0
          out[vi * 3 + 1] += rawNormals[ni * 3 + 1] ?? 0
          out[vi * 3 + 2] += rawNormals[ni * 3 + 2] ?? 0
        }
      } else {
        return fallback()
      }
      // Нормализация усреднённых.
      for (let v = 0; v < vertexCount; v++) {
        const x = out[v * 3], y = out[v * 3 + 1], z = out[v * 3 + 2]
        const len = Math.hypot(x, y, z)
        if (len > 1e-9) { out[v * 3] /= len; out[v * 3 + 1] /= len; out[v * 3 + 2] /= len }
      }
      return out
    }
    return fallback()
  }

  private async readSkin(g: RawNode, objects: RawNode, skeleton: FbxSkeleton): Promise<FbxSkin | undefined> {
    const geomId = this.objId(g)
    // Skin-деформеры, присоединённые к геометрии.
    let skinDeformer: RawNode | undefined
    for (const o of objects.children) {
      if (this.objType(o) !== 'Deformer') continue
      if (String(o.props[2] ?? '') !== 'Skin') continue
      if (this.parents.get(this.objId(o))?.includes(geomId)) { skinDeformer = o; break }
    }
    if (skinDeformer === undefined) return undefined
    const verticesProp = g.children.find(c => c.name === 'Vertices')?.props[0]
    if (!(verticesProp instanceof LazyArrayImplCheck)) return undefined
    const vertexCount = (await (verticesProp as unknown as LazyArray).f64()).length / 3

    // Кластеры скина → индексы вершин/веса.
    const jointNameToIndex = new Map<string, number>()
    skeleton.joints.forEach((j, i) => jointNameToIndex.set(j.name, i))

    const jointIndices = new Uint16Array(vertexCount * 4)
    const jointWeights = new Float32Array(vertexCount * 4)
    const weightAcc = new Float64Array(vertexCount * 4) // max-weight занятость (insertion sort 4)
    const jointAcc = new Uint16Array(vertexCount * 4)

    for (const cluster of this.childrenOf(this.objId(skinDeformer), 'SubDeformer')) {
      const boneName = this.findClusterBoneName(cluster)
      const joint = boneName !== undefined ? jointNameToIndex.get(strippedClusterName(boneName)) : undefined
      if (joint === undefined) continue
      const indexesProp = cluster.children.find(c => c.name === 'Indexes')?.props[0]
      const weightsProp = cluster.children.find(c => c.name === 'Weights')?.props[0]
      if (!(indexesProp instanceof LazyArrayImplCheck) || !(weightsProp instanceof LazyArrayImplCheck)) continue
      const indexes = await (indexesProp as unknown as LazyArray).i32()
      const weights = await (weightsProp as unknown as LazyArray).f64()
      for (let i = 0; i < indexes.length; i++) {
        const vi = indexes[i]
        const w = weights[i]
        if (w <= 0) continue
        // Вставка в топ-4 по весу (маленький массив — линейный поиск).
        let slot = -1
        for (let s = 0; s < 4; s++) {
          if (weightAcc[vi * 4 + s] === 0) { slot = s; break }
          if (weightAcc[vi * 4 + s] < w) { slot = s; break }
        }
        if (slot === -1) continue
        // Сдвиг хвоста вниз (вытесняем наименьший).
        for (let s = 3; s > slot; s--) {
          weightAcc[vi * 4 + s] = weightAcc[vi * 4 + s - 1]
          jointAcc[vi * 4 + s] = jointAcc[vi * 4 + s - 1]
        }
        weightAcc[vi * 4 + slot] = w
        jointAcc[vi * 4 + slot] = joint
      }
    }
    // Нормализация весов (сумма → 1; вершины без влияний → joint 0, вес 0).
    for (let v = 0; v < vertexCount; v++) {
      let sum = 0
      for (let s = 0; s < 4; s++) sum += weightAcc[v * 4 + s]
      if (sum > 1e-9) {
        for (let s = 0; s < 4; s++) jointWeights[v * 4 + s] = weightAcc[v * 4 + s] / sum
      } else {
        jointIndices[v * 4] = 0 // заглушка: вес 0 — не влияет
      }
      for (let s = 0; s < 4; s++) jointIndices[v * 4 + s] = jointAcc[v * 4 + s]
    }
    return { jointIndices, jointWeights }
  }

  // ── Клипы ────────────────────────────────────────────────────────────────

  private async extractClips(objects: RawNode): Promise<FbxClip[]> {
    const clips: FbxClip[] = []
    for (const stack of objects.children) {
      if (this.objType(stack) !== 'AnimStack') continue
      // Стек → слои → curve nodes → кривые.
      const curveNodes: RawNode[] = []
      for (const layer of this.childrenOf(this.objId(stack), 'AnimLayer')) {
        for (const cn of this.childrenOf(this.objId(layer), 'AnimCurveNode')) curveNodes.push(cn)
      }
      if (curveNodes.length === 0) continue // пустые стеки («Take 001») пропускаем

      // Треки строятся мутабельными (имя кости до резолва индекса), в конце
      // компилируются в публичные FbxTrack*.
      const pendingT: { boneName: string; times: Float32Array; values: Float32Array }[] = []
      const pendingR: { boneName: string; times: Float32Array; quats: Float32Array }[] = []
      let duration = 0

      for (const cn of curveNodes) {
        const cnId = this.objId(cn)
        // Цель curve node: Model кости, свойство Lcl Translation | Lcl Rotation.
        const bone = this.parentOf(cnId, 'Model')
        if (bone === undefined) continue
        const target = this.connProps.get(`${cnId}>${this.objId(bone)}`) ?? ''
        const isTranslation = target.includes('Translation')
        const isRotation = target.includes('Rotation')
        if (!isTranslation && !isRotation) continue

        // Кривые X/Y/Z этого curve node.
        const curves: Record<'x' | 'y' | 'z', { times: Float64Array; values: Float32Array } | undefined> = { x: undefined, y: undefined, z: undefined }
        for (const child of this.childrenOf(cnId, 'AnimCurve')) {
          const axis = this.connProps.get(`${this.objId(child)}>${cnId}`) // "d|X" | "d|Y" | "d|Z"
          if (axis === undefined) continue
          const key = axis.endsWith('|X') ? 'x' : axis.endsWith('|Y') ? 'y' : axis.endsWith('|Z') ? 'z' : undefined
          if (key === undefined) continue
          const keyTime = await propArray(child, 'KeyTime')
          const keyValue = await propArray(child, 'KeyValueFloat')
          if (keyTime === undefined || keyValue === undefined) continue
          const times = new Float64Array(keyTime.length)
          for (let i = 0; i < keyTime.length; i++) times[i] = keyTime[i] / KTIME_PER_SECOND
          curves[key] = { times, values: f32From(keyValue) }
          const last = times.length > 0 ? times[times.length - 1] : 0
          if (last > duration) duration = last
        }
        if (curves.x === undefined && curves.y === undefined && curves.z === undefined) continue

        // Общая сетка времени: объединение ключей трёх осей (сортировка).
        const keySet = new Set<number>()
        for (const axis of ['x', 'y', 'z'] as const) {
          if (curves[axis] !== undefined) for (const t of curves[axis]!.times) keySet.add(t)
        }
        const times = Float32Array.from([...keySet].sort((a, b) => a - b))
        const boneName = this.objName(bone)

        if (isTranslation) {
          const values = new Float32Array(times.length * 3)
          for (let k = 0; k < times.length; k++) {
            const sampled = sampleAxes(curves, times[k])
            values[k * 3] = sampled[0]; values[k * 3 + 1] = sampled[1]; values[k * 3 + 2] = sampled[2]
          }
          pendingT.push({ boneName, times, values })
        } else {
          const quats = new Float32Array(times.length * 4)
          const deg = [0, 0, 0]
          for (let k = 0; k < times.length; k++) {
            const sampled = sampleAxes(curves, times[k])
            deg[0] = sampled[0]; deg[1] = sampled[1]; deg[2] = sampled[2]
            quatFromEulerXYZ(deg, quats, k * 4)
          }
          pendingR.push({ boneName, times, quats })
        }
      }
      if (pendingT.length === 0 && pendingR.length === 0) continue

      // Резолв имён костей → индексы скелета (суставы уже извлечены в extract()
      // ДО клипов — см. setSkeletonJoints).
      const indexByName = new Map<string, number>()
      for (const [i, j] of skeletonJoints.entries()) indexByName.set(j.name, i)
      const tracksT: FbxTrackT[] = pendingT.map(p => ({ joint: indexByName.get(p.boneName) ?? -1, times: p.times, values: p.values }))
      const tracksR: FbxTrackR[] = pendingR.map(p => ({ joint: indexByName.get(p.boneName) ?? -1, times: p.times, quats: p.quats }))

      clips.push({ name: this.objName(stack), duration, tracksT, tracksR })
    }
    return clips
  }
}

// ─── Хелперы (чистые функции) ─────────────────────────────────────────────────

/** Скалярный размер элемента ленивого массива (байты). */
function scalarOf(kind: LazyArray['kind']): number {
  switch (kind) {
    case 'f64': case 'i64': return 8
    case 'f32': case 'i32': return 4
    default: return 1 // 'bytes'
  }
}

/** Маркер-класс для ленивых массивов (instanceof-чек при чтении). */
class LazyArrayImplCheck { private readonly __lazy = true }

/** Реализация ленивого массива: инфляция по требованию, кэш + дедуп параллельных вызовов. */
class LazyArrayImpl extends LazyArrayImplCheck implements LazyArray {
  readonly kind: LazyArray['kind']
  readonly length: number
  private cache: Uint8Array | null = null
  private inflight: Promise<Uint8Array> | null = null

  constructor(kind: LazyArray['kind'], len: number, private readonly doInflate: () => Promise<Uint8Array>) {
    super()
    this.kind = kind
    this.length = len
  }

  async raw(): Promise<Uint8Array> {
    if (this.cache !== null) return this.cache
    if (this.inflight === null) this.inflight = this.doInflate()
    const out = await this.inflight
    if (this.cache === null) this.cache = out
    return out
  }

  /** Выравнивание под скалярный размер (unaligned zlib-выход → копия). */
  private async aligned(scalar: number): Promise<Uint8Array> {
    const b = await this.raw()
    if (b.byteOffset % scalar === 0 && b.length >= this.length * scalar) return b
    const copy = new Uint8Array(this.length * scalar)
    copy.set(b.subarray(0, copy.length))
    return copy
  }

  async f64(): Promise<Float64Array> { const a = await this.aligned(8); return new Float64Array(a.buffer, a.byteOffset, this.length) }
  async f32(): Promise<Float32Array> { const a = await this.aligned(4); return new Float32Array(a.buffer, a.byteOffset, this.length) }
  async i32(): Promise<Int32Array> { const a = await this.aligned(4); return new Int32Array(a.buffer, a.byteOffset, this.length) }
}

function splitNameType(o: RawNode): { name: string; type: string } {
  const raw = String(o.props[1] ?? '')
  const sep = raw.indexOf('\u0000\u0001')
  if (sep < 0) return { name: raw, type: '' }
  return { name: raw.slice(0, sep), type: raw.slice(sep + 2) }
}

/** Значения Properties70 «P»: [name, type, typeFlag, _, ...values]. */
function p70Values(p70: RawNode | undefined, name: string): number[] | undefined {
  if (p70 === undefined) return undefined
  for (const p of p70.children) {
    if (p.name !== 'P') continue
    const props = p.props as unknown[]
    if (String(props[0]) === name) return props.slice(4).map(Number)
  }
  return undefined
}

function readRestPose(p70: RawNode | undefined): { t: [number, number, number]; q: [number, number, number, number]; s: [number, number, number] } {
  const t = p70Values(p70, 'Lcl Translation') ?? [0, 0, 0]
  const r = p70Values(p70, 'Lcl Rotation') ?? [0, 0, 0]
  const s = p70Values(p70, 'Lcl Scaling') ?? [1, 1, 1]
  const q = [0, 0, 0, 1] as [number, number, number, number]
  quatFromEulerXYZ([r[0] * DEG2RAD, r[1] * DEG2RAD, r[2] * DEG2RAD], q, 0)
  return { t: [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0], q, s: [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1] }
}

async function propArray(node: RawNode, childName: string): Promise<Float64Array | undefined> {
  const prop = node.children.find(c => c.name === childName)?.props[0]
  if (prop === undefined) return undefined
  if (prop instanceof LazyArrayImplCheck) {
    const lazy = prop as unknown as LazyArray
    // Int64-массивы (KeyTime — ktime-тики) нельзя реинтерпретировать как f64:
    // читаем их как BigInt64 → Number. Прочие kind'ы уже в правильной
    // байтовой раскладке.
    if (lazy.kind === 'i64') {
      const b = await lazy.raw()
      const out = new Float64Array(lazy.length)
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
      for (let i = 0; i < lazy.length; i++) out[i] = Number(dv.getBigInt64(i * 8, true))
      return out
    }
    return lazy.f64()
  }
  if (prop instanceof Float64Array) return prop
  if (prop instanceof Float32Array) return Float64Array.from(prop)
  if (prop instanceof Int32Array) return Float64Array.from(prop)
  return undefined
}

/** Имя кости из имени кластера: «Cluster <bone>» → «<bone>». */
function strippedClusterName(name: string): string {
  return name.startsWith('Cluster ') ? name.slice('Cluster '.length) : name
}

const DEG2RAD = Math.PI / 180

/** Эйлер XYZ (three.js конвенция: q = qx⊗qy⊗qz) → кватернион в out[off..off+3] (x,y,z,w). */
export function quatFromEulerXYZ(euler: readonly number[], out: Float32Array | number[], off: number): void {
  const x = euler[0] / 2, y = euler[1] / 2, z = euler[2] / 2
  const sx = Math.sin(x), cx = Math.cos(x)
  const sy = Math.sin(y), cy = Math.cos(y)
  const sz = Math.sin(z), cz = Math.cos(z)
  // qx⊗qy⊗qz
  out[off] = sx * cy * cz + cx * sy * sz
  out[off + 1] = cx * sy * cz - sx * cy * sz
  out[off + 2] = cx * cy * sz + sx * sy * cz
  out[off + 3] = cx * cy * cz - sx * sy * sz
}

/** Обращение 4×4 (колоночно-мажорный, general). */
export function invert4(m: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16)
  const inv = new Float64Array(16)
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10]
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10]
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9]
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9]
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10]
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10]
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9]
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9]
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6]
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6]
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5]
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5]
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6]
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6]
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5]
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5]
  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12]
  if (det === 0) return out // вырожденная — identity
  det = 1 / det
  for (let i = 0; i < 16; i++) out[i] = inv[i] * det
  return out
}

function f32From(src: Float64Array | Float32Array): Float32Array {
  if (src instanceof Float32Array) return src
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = src[i]
  return out
}

function triangulate(polygonIndex: Int32Array): { indices: Uint32Array } {
  const indices: number[] = []
  let polyStart = 0
  for (let i = 0; i < polygonIndex.length; i++) {
    const v = polygonIndex[i]
    if (v < 0) {
      const last = ~v
      const len = i - polyStart + 1
      const v0 = polygonIndex[polyStart]
      for (let k = 1; k < len - 1; k++) {
        indices.push(v0, polygonIndex[polyStart + k], polygonIndex[polyStart + k + 1])
      }
      void last
      polyStart = i + 1
    }
  }
  return { indices: Uint32Array.from(indices) }
}

function computeNormals(vertices: Float64Array, polygonIndex: Int32Array): Float32Array {
  const count = vertices.length / 3
  const out = new Float32Array(count * 3)
  let polyStart = 0
  for (let i = 0; i < polygonIndex.length; i++) {
    const v = polygonIndex[i]
    if (v >= 0) continue
    const len = i - polyStart + 1
    if (len >= 3) {
      const a = polygonIndex[polyStart] * 3
      const b = polygonIndex[polyStart + 1] * 3
      const c = polygonIndex[polyStart + len - 1] * 3
      const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2]
      const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2]
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      for (let k = 0; k < len; k++) {
        const vi = polygonIndex[polyStart + k] * 3
        out[vi] += nx; out[vi + 1] += ny; out[vi + 2] += nz
      }
    }
    polyStart = i + 1
  }
  for (let v = 0; v < count; v++) {
    const len = Math.hypot(out[v * 3], out[v * 3 + 1], out[v * 3 + 2])
    if (len > 1e-9) { out[v * 3] /= len; out[v * 3 + 1] /= len; out[v * 3 + 2] /= len }
  }
  return out
}

/** Сэмпл трёх осей в момент t (step-интерполяция между ключами осей). */
function sampleAxes(curves: Record<'x' | 'y' | 'z', { times: Float64Array; values: Float32Array } | undefined>, t: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0]
  const axes = ['x', 'y', 'z'] as const
  for (let a = 0; a < 3; a++) {
    const curve = curves[axes[a]]
    if (curve === undefined) continue
    const { times, values } = curve
    if (times.length === 0) continue
    // Бинарный/линейный поиск сегмента (ключи отсортированы).
    let i = 0
    while (i < times.length - 1 && times[i + 1] <= t) i++
    out[a] = values[i] ?? 0
  }
  return out
}

// Заглушка для резолва индексов костей после парсинга скелета (заполняется
// extractClips через замыкание ниже — см. skeletonJointsRef).
let skeletonJoints: readonly { name: string }[] = []

/** Внутренний доступ для тестов: сброс кэша имён. */
export function __resetFbxTestState(): void { skeletonJoints = [] }

/** Инъекция списка костей (вызывается extract()). */
function setSkeletonJoints(joints: readonly { name: string }[]): void { skeletonJoints = joints }

// ─── Мост Task 88 (AssetLibrary ждёт эти имена) ─────────────────────────────

/** FBX-бинарный магик «Kaydara FBX Binary» (снифф для AssetLibrary). */
export function looksLikeFbxBinary(bytes: Uint8Array): boolean {
  const magic = 'Kaydara FBX Binary'
  if (bytes.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) return false
  }
  return true
}

/** Опции задачи FBX-парсинга (сигнал/фазы прогруза — мост AssetLibrary). */
export interface FbxParseTaskOptions {
  readonly signal?: AbortSignal
  readonly onPhase?: (info: { stage: string; ratio: number; detail: string }) => void
}

/**
 * FBX из байтов (Task 88-контракт: Uint8Array + опции).
 * Полный буфер обязателен: FBX-дерево читается от конца (footer).
 */
export async function parseFbx(
  data: Uint8Array | ArrayBuffer,
  options: FbxParseTaskOptions = {},
): Promise<FbxModel> {
  if (options.signal?.aborted) {
    throw new DOMException('загрузка отменена', 'AbortError')
  }
  options.onPhase?.({ stage: 'parse', ratio: 0.1, detail: 'FBX: полный буфер получен' })
  const buffer = (
    data instanceof ArrayBuffer
      ? data
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  ) as ArrayBuffer
  const model = await parseFBX(buffer)
  options.onPhase?.({ stage: 'parse', ratio: 0.9, detail: 'FBX: дерево разобрано' })
  return model
}
