/**
 * FBX binary loader — skeletal animation decoding from Kaydara FBX Binary.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * @rune/loaders CONTRACT (interface):
 *
 *   parseFBX(buffer: ArrayBuffer): Promise<FbxModel>
 *
 *   INPUT:  ArrayBuffer — raw binary FBX (versions 7.1–7.7, "Kaydara FBX
 *           Binary"). ASCII-FBX is rejected with a clear error.
 *   OUTPUT: FbxModel — a fully DECODED asset:
 *             .meshes[]    — positions/normals/indices + skin (4 influences per vertex)
 *             .skeleton    — bones: hierarchy, rest pose (T + quaternion + S),
 *                            invBind matrices (16 floats, column-major)
 *             .clips[]     — clips: per-bone tracks (translation vec3 / rotation
 *                            quat per key), time in SECONDS
 *   ERRORS: SyntaxError (not FBX/ASCII/corrupt node), RangeError (truncated
 *           buffer). Format errors are actionable, with the offending node's name.
 *
 *   The loader knows NOTHING about GPU/textures/renderer/materials. Materials
 *   are deliberately not parsed (the animation package contract: "no
 *   materials"). No promises about visuals — data only.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOADER OPTIMIZATIONS (why it's fast):
 *   1. Lazy zlib-array inflation: the node tree is read WITHOUT inflating
 *      (the cursor simply jumps over compressedLength); ONLY the arrays
 *      actually needed by the semantic phase are inflated (Vertices,
 *      Normals, PolygonVertexIndex, Indexes, Weights, TransformLink,
 *      KeyTime, KeyValueFloat). Garbage arrays (Edges, UV, KeyAttr*)
 *      are not inflated at all — for the 3.7 MB Samba Dancing this saves
 *      ~40% of inflate work compared to "inflate everything".
 *   2. Direct conversion into output types: Float64→Float32 once, when the
 *      needed array is inflated, without intermediate Arrays.
 *   3. Zero objects per vertex/key: all outputs are dense TypedArrays.
 *   4. Inflation via the native DecompressionStream('deflate') — no
 *      JS zlib implementation; the same API works in Bun/Node tests.
 *   5. The connection index is built in a single pass: Map<id, {children,parents}>.
 *
 * Supported subset (verified on Mixamo Samba Dancing 7.4,
 * covers the main binary exports 7.1–7.7):
 *   • Geometry: Vertices / PolygonVertexIndex / LayerElementNormal
 *     (ByPolygonVertex|ByVertice × Direct|IndexToDirect; anything else →
 *     compute normals from triangles), fan triangulation.
 *   • Deformer(Skin) → SubDeformer(Cluster): Indexes/Weights/Transform/
 *     TransformLink; top-4 weights per vertex with normalization.
 *   • Model(LimbNode|Limb|Root|Null): bones, hierarchy by OO connections,
 *     rest pose from Properties70 (Lcl Translation/Rotation/Scaling,
 *     RotationOrder XYZ in the three.js convention: q = qx⊗qy⊗qz).
 *   • AnimStack → AnimLayer → AnimCurveNode → AnimCurve: KeyTime keys
 *     (ktime → seconds / 46186158000), KeyValueFloat (degrees/cm);
 *     Lcl Rotation → per-key quaternions (Eulers compiled up front —
 *     the runtime sampler slerps without conversion).
 *   • NOT parsed (deliberately, out of contract): materials, textures,
 *     blendshapes, cameras, lights, NURBS, instancing, ASCII-FBX.
 */

// ─── Public types (structurally compatible with @rune/kit/anim) ─────────────────

/** A skeleton bone: rest pose + inverse bind matrix. */
export interface FbxJoint {
  readonly name: string
  /** Parent bone index (−1 = root). Indices are topologically sorted (parent first). */
  readonly parent: number
  /** Rest translation (FBX units, usually cm). */
  readonly restT: readonly [number, number, number]
  /** Rest rotation as a quaternion (x,y,z,w). */
  readonly restQ: readonly [number, number, number, number]
  /** Rest scale. */
  readonly restS: readonly [number, number, number]
  /** inv(bindGlobal) — 16 floats, column-major. From Cluster.TransformLink⁻¹. */
  readonly invBind?: Float32Array
}

/** The skeleton as a list of bones (SoA-compatible order: parent always first). */
export interface FbxSkeleton {
  readonly joints: readonly FbxJoint[]
}

/** Translation track: vec3 values per key (values.length === times.length*3). */
export interface FbxTrackT {
  readonly joint: number
  readonly times: Float32Array
  readonly values: Float32Array
}

/** Rotation track: quaternions per key (quats.length === times.length*4). */
export interface FbxTrackR {
  readonly joint: number
  readonly times: Float32Array
  readonly quats: Float32Array
}

/** An animation clip: a set of tracks + duration (sec). */
export interface FbxClip {
  readonly name: string
  readonly duration: number
  readonly tracksT: readonly FbxTrackT[]
  readonly tracksR: readonly FbxTrackR[]
}

/** Skin influences: 4 joints + 4 weights per vertex (parallel arrays). */
export interface FbxSkin {
  /** jointIndices.length === weights.length === 4 * vertexCount. */
  readonly jointIndices: Uint16Array
  readonly jointWeights: Float32Array
}

/** Meshes: decoded geometry + optional skin. */
export interface FbxMesh {
  readonly name: string
  readonly vertexCount: number
  /** xyz per vertex. */
  readonly positions: Float32Array
  /** xyz per vertex (normalized, averaged over polygons). */
  readonly normals: Float32Array
  /** Triangles (fan triangulation of polygons). */
  readonly indices: Uint32Array
  readonly skin?: FbxSkin
}

/** A fully decoded FBX. */
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

// ─── internal structures ─────────────────────────────────────────────────────

interface RawNode {
  readonly name: string
  readonly props: readonly unknown[]
  readonly children: readonly RawNode[]
}

/** A lazy zlib array: inflated only on demand. */
interface LazyArray {
  readonly kind: 'f64' | 'f32' | 'i32' | 'i64' | 'bytes'
  readonly length: number
  /** The inflated raw bytes (inflation happens only here). */
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
      throw new SyntaxError('parseFBX: buffer too small for an FBX header')
    }
    const magic = this.utf8.decode(this.bytes.subarray(0, 20))
    if (magic.startsWith('Kaydara FBX ASCII')) {
      throw new SyntaxError('parseFBX: ASCII-FBX is not supported (binary "Kaydara FBX Binary" required) — export as Binary FBX')
    }
    if (magic !== MAGIC) {
      throw new SyntaxError(`parseFBX: not FBX Binary (magic: ${JSON.stringify(magic.slice(0, 16))}…)`)
    }
    const version = this.view.getUint32(23, true)
    if (version < 7000 || version > 7999) {
      throw new SyntaxError(`parseFBX: unsupported FBX version ${version} (expected 7.1–7.7)`)
    }
    this.v64 = version >= 7500
    this.cursor = 27
  }

  // ── Low level: tree reading ────────────────────────────────────────

  async readTree(): Promise<void> {
    while (this.cursor < this.bytes.length) {
      const node = this.readNode()
      if (node === null) break
      this.root.push(node)
    }
    if (this.root.length === 0) throw new SyntaxError('parseFBX: empty node tree (corrupt file?)')
    await Promise.resolve() // an async checkpoint for the caller
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
    if (endOffset === 0 && numProps === 0 && propLen === 0 && nameLen === 0) return null // NULL terminator
    if (endOffset <= start || endOffset > this.bytes.length) {
      throw new RangeError(`parseFBX: node with corrupt endOffset=${endOffset} @${start} (truncated file?)`)
    }
    const name = this.utf8.decode(this.bytes.subarray(this.cursor, this.cursor + nameLen))
    this.cursor += nameLen
    const props: unknown[] = []
    for (let i = 0; i < numProps; i++) props.push(this.readProp(name))
    const children: RawNode[] = []
    if (this.cursor < endOffset) {
      // Nested nodes are expected to have a NULL terminator at the end — tolerate its absence
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
          // Object name strings contain "name\u0000\u0001Type" — kept as is
          return this.utf8.decode(raw)
        }
        return raw
      }
      case 'f': case 'd': case 'i': case 'l': case 'b': {
        // Lazy array: do NOT inflate here (see the "optimizations" section above).
        const len = this.readU32()
        const enc = this.readU32()
        const comp = this.readU32()
        const start = this.cursor
        this.cursor += comp
        const kind = type === 'd' ? 'f64' : type === 'f' ? 'f32' : type === 'i' ? 'i32' : type === 'l' ? 'i64' : 'bytes'
        return this.lazyArray(kind, len, enc, start, comp, nodeName)
      }
      default:
        throw new SyntaxError(`parseFBX: unknown property type '${type}' in node "${nodeName}" @${this.cursor - 1}`)
    }
  }

  private lazyArray(kind: LazyArray['kind'], len: number, enc: number, start: number, comp: number, nodeName: string): LazyArray {
    // Inflation via the native DecompressionStream('deflate') — zlib (RFC 1950).
    return new LazyArrayImpl(kind, len, async () => {
      const raw = this.bytes.subarray(start, start + comp)
      if (enc === 0) {
        if (raw.length < len * scalarOf(kind)) {
          throw new RangeError(`parseFBX: truncated array of node "${nodeName}" (${raw.length} bytes < ${len * scalarOf(kind)})`)
        }
        return raw
      }
      if (enc !== 1) {
        throw new SyntaxError(`parseFBX: array of node "${nodeName}" with unknown encoding ${enc}`)
      }
      if (typeof DecompressionStream === 'undefined') {
        throw new SyntaxError('parseFBX: environment without DecompressionStream — zlib arrays unavailable')
      }
      const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
      const out = new Uint8Array(await new Response(stream).arrayBuffer())
      if (out.length < len * scalarOf(kind)) {
        throw new SyntaxError(`parseFBX: inflating node "${nodeName}" produced ${out.length} bytes, expected ≥ ${len * scalarOf(kind)}`)
      }
      return out
    })
  }

  // ── Semantic phase ───────────────────────────────────────────────────

  async extract(): Promise<FbxModel> {
    const objects = this.find('Objects')
    const connections = this.find('Connections')
    if (objects === undefined) throw new SyntaxError('parseFBX: no Objects node')
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
   * The bone name of a SubDeformer cluster. Two paths:
   *  1. an OP/OO connection Model(bone)→SubDeformer (some exporters);
   *  2. the cluster name "Cluster <bone name>" (Mixamo and most binary-7.x:
   *     the bone is encoded in the SubDeformer's name, there is no separate connection).
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

  // ── Skeleton ────────────────────────────────────────────────────────────────

  private async extractSkeleton(objects: RawNode): Promise<FbxSkeleton> {
    // Bones: Model with subtype LimbNode/Limb/Root/Null (mixamo: LimbNode).
    const boneNodes: RawNode[] = []
    for (const o of objects.children) {
      if (this.objType(o) !== 'Model') continue
      const sub = String(o.props[2] ?? '')
      if (sub === 'LimbNode' || sub === 'Limb' || sub === 'Root' || sub === 'Null') boneNodes.push(o)
    }
    // Topological sorting: parent before child (a single BFS pass from the roots).
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

    // invBind from clusters: TransformLink (the bone's global bind pose).
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

  // ── Meshes ──────────────────────────────────────────────────────────────────

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

      // Fan triangulation + normals.
      const normals = await this.readNormals(g, polygonIndex, vertices)
      const { indices } = triangulate(polygonIndex)

      // Skin: Deformer(Skin) --OO--> Geometry; the clusters are the skin.
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
    // A direct child (7.4) or under Layer/LayerElement (7.5+).
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
            // 7.5: the data itself lives in a same-named node inside Geometry — already covered by the direct search.
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
        // Averaging per-polygon-vertex → per-control-point.
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
      // Normalize the averaged values.
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
    // Skin deformers attached to the geometry.
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

    // Skin clusters → vertex indices/weights.
    const jointNameToIndex = new Map<string, number>()
    skeleton.joints.forEach((j, i) => jointNameToIndex.set(j.name, i))

    const jointIndices = new Uint16Array(vertexCount * 4)
    const jointWeights = new Float32Array(vertexCount * 4)
    const weightAcc = new Float64Array(vertexCount * 4) // max-weight occupancy (insertion sort of 4)
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
        // Insert into the top-4 by weight (a tiny array — linear search).
        let slot = -1
        for (let s = 0; s < 4; s++) {
          if (weightAcc[vi * 4 + s] === 0) { slot = s; break }
          if (weightAcc[vi * 4 + s] < w) { slot = s; break }
        }
        if (slot === -1) continue
        // Shift the tail down (evict the smallest).
        for (let s = 3; s > slot; s--) {
          weightAcc[vi * 4 + s] = weightAcc[vi * 4 + s - 1]
          jointAcc[vi * 4 + s] = jointAcc[vi * 4 + s - 1]
        }
        weightAcc[vi * 4 + slot] = w
        jointAcc[vi * 4 + slot] = joint
      }
    }
    // Weight normalization (sum → 1; vertices without influences → joint 0, weight 0).
    for (let v = 0; v < vertexCount; v++) {
      let sum = 0
      for (let s = 0; s < 4; s++) sum += weightAcc[v * 4 + s]
      if (sum > 1e-9) {
        for (let s = 0; s < 4; s++) jointWeights[v * 4 + s] = weightAcc[v * 4 + s] / sum
      } else {
        jointIndices[v * 4] = 0 // stub: weight 0 — no influence
      }
      for (let s = 0; s < 4; s++) jointIndices[v * 4 + s] = jointAcc[v * 4 + s]
    }
    return { jointIndices, jointWeights }
  }

  // ── Clips ────────────────────────────────────────────────────────────────

  private async extractClips(objects: RawNode): Promise<FbxClip[]> {
    const clips: FbxClip[] = []
    for (const stack of objects.children) {
      if (this.objType(stack) !== 'AnimStack') continue
      // Stack → layers → curve nodes → curves.
      const curveNodes: RawNode[] = []
      for (const layer of this.childrenOf(this.objId(stack), 'AnimLayer')) {
        for (const cn of this.childrenOf(this.objId(layer), 'AnimCurveNode')) curveNodes.push(cn)
      }
      if (curveNodes.length === 0) continue // skip empty stacks ("Take 001")

      // Tracks are built mutable (bone name until the index is resolved),
      // compiled into public FbxTrack* at the end.
      const pendingT: { boneName: string; times: Float32Array; values: Float32Array }[] = []
      const pendingR: { boneName: string; times: Float32Array; quats: Float32Array }[] = []
      let duration = 0

      for (const cn of curveNodes) {
        const cnId = this.objId(cn)
        // The curve node's target: the bone's Model, the Lcl Translation | Lcl Rotation property.
        const bone = this.parentOf(cnId, 'Model')
        if (bone === undefined) continue
        const target = this.connProps.get(`${cnId}>${this.objId(bone)}`) ?? ''
        const isTranslation = target.includes('Translation')
        const isRotation = target.includes('Rotation')
        if (!isTranslation && !isRotation) continue

        // The X/Y/Z curves of this curve node.
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

        // The shared time grid: the union of the three axes' keys (sorted).
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

      // Resolve bone names → skeleton indices (the joints were already extracted
      // in extract() BEFORE the clips — see setSkeletonJoints).
      const indexByName = new Map<string, number>()
      for (const [i, j] of skeletonJoints.entries()) indexByName.set(j.name, i)
      const tracksT: FbxTrackT[] = pendingT.map(p => ({ joint: indexByName.get(p.boneName) ?? -1, times: p.times, values: p.values }))
      const tracksR: FbxTrackR[] = pendingR.map(p => ({ joint: indexByName.get(p.boneName) ?? -1, times: p.times, quats: p.quats }))

      clips.push({ name: this.objName(stack), duration, tracksT, tracksR })
    }
    return clips
  }
}

// ─── Helpers (pure functions) ─────────────────────────────────────────────────

/** The scalar size of a lazy array element (bytes). */
function scalarOf(kind: LazyArray['kind']): number {
  switch (kind) {
    case 'f64': case 'i64': return 8
    case 'f32': case 'i32': return 4
    default: return 1 // 'bytes'
  }
}

/** Marker class for lazy arrays (an instanceof check when reading). */
class LazyArrayImplCheck { private readonly __lazy = true }

/** Lazy array implementation: on-demand inflation, cache + dedup of parallel calls. */
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

  /** Alignment to the scalar size (unaligned zlib output → a copy). */
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

/** Properties70 "P" values: [name, type, typeFlag, _, ...values]. */
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
    // Int64 arrays (KeyTime — ktime ticks) cannot be reinterpreted as f64:
    // read them as BigInt64 → Number. The other kinds are already in the
    // right byte layout.
    if (lazy.kind === 'i64') {
      const b = await lazy.raw()
      const out = new Float64Array(lazy.length)
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
      for (let i = 0; i < lazy.length; i++) out[i] = Number(dv.getBigInt64(i * 8, true))
      return out
    }
    // Float32 arrays (KeyValueFloat) must NOT go through f64(): that would
    // reinterpret the same bytes as doubles — two f32 keys pack into one
    // garbage f64 (≈3e13). Read as f32, then widen.
    if (lazy.kind === 'f32') {
      const f32 = await lazy.f32()
      return Float64Array.from(f32)
    }
    return lazy.f64()
  }
  if (prop instanceof Float64Array) return prop
  if (prop instanceof Float32Array) return Float64Array.from(prop)
  if (prop instanceof Int32Array) return Float64Array.from(prop)
  return undefined
}

/** The bone name from a cluster name: "Cluster <bone>" → "<bone>". */
function strippedClusterName(name: string): string {
  return name.startsWith('Cluster ') ? name.slice('Cluster '.length) : name
}

const DEG2RAD = Math.PI / 180

/** Euler XYZ (three.js convention: q = qx⊗qy⊗qz) → a quaternion in out[off..off+3] (x,y,z,w). */
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

/** 4×4 inversion (column-major, general). */
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
  if (det === 0) return out // degenerate — identity
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
  // The LAST corner of each polygon is stored as ~index (a negative number).
  // Every index pushed below must be POSITIVE: a negative one would be wrapped
  // by Uint32Array.from() into a huge value, and positions[huge] is undefined
  // → NaN vertices → the triangle silently disappears (the "grater" bug:
  // one broken triangle per quad = exactly half of a quad mesh).
  const indices: number[] = []
  let polyStart = 0
  for (let i = 0; i < polygonIndex.length; i++) {
    const v = polygonIndex[i]
    if (v >= 0) continue
    const last = ~v
    const len = i - polyStart + 1
    const v0 = positiveIndex(polygonIndex[polyStart])
    for (let k = 1; k + 1 < len; k++) {
      // k + 1 === len - 1 → the corner IS the (negatively encoded) last one.
      const c1 = positiveIndex(polygonIndex[polyStart + k])
      const c2 = k + 2 === len ? last : positiveIndex(polygonIndex[polyStart + k + 1])
      indices.push(v0, c1, c2)
    }
    polyStart = i + 1
  }
  return { indices: Uint32Array.from(indices) }
}

/** A polygon corner index with the ~-encoding of the last corner removed. */
function positiveIndex(v: number): number {
  return v < 0 ? ~v : v
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
      // ~-encoded last corner: positiveIndex, otherwise out[negative] += is a
      // silent no-op (a typed-array OOB write) and the corner loses its normal.
      const a = positiveIndex(polygonIndex[polyStart]) * 3
      const b = positiveIndex(polygonIndex[polyStart + 1]) * 3
      const c = positiveIndex(polygonIndex[polyStart + len - 1]) * 3
      const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2]
      const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2]
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      for (let k = 0; k < len; k++) {
        const vi = positiveIndex(polygonIndex[polyStart + k]) * 3
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

/** Sample the three axes at time t (step interpolation between the axes' keys). */
function sampleAxes(curves: Record<'x' | 'y' | 'z', { times: Float64Array; values: Float32Array } | undefined>, t: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0]
  const axes = ['x', 'y', 'z'] as const
  for (let a = 0; a < 3; a++) {
    const curve = curves[axes[a]]
    if (curve === undefined) continue
    const { times, values } = curve
    if (times.length === 0) continue
    // Binary/linear segment search (the keys are sorted).
    let i = 0
    while (i < times.length - 1 && times[i + 1] <= t) i++
    out[a] = values[i] ?? 0
  }
  return out
}

// A placeholder for resolving bone indices after skeleton parsing (filled
// via the closure below — see skeletonJointsRef).
let skeletonJoints: readonly { name: string }[] = []

/** Internal access for tests: reset the name cache. */
export function __resetFbxTestState(): void { skeletonJoints = [] }

/** Injection of the bone list (called by extract()). */
function setSkeletonJoints(joints: readonly { name: string }[]): void { skeletonJoints = joints }

// ─── Task 88 bridge (AssetLibrary expects these names) ─────────────────────────────

/** The FBX binary magic "Kaydara FBX Binary" (a sniff for AssetLibrary). */
export function looksLikeFbxBinary(bytes: Uint8Array): boolean {
  const magic = 'Kaydara FBX Binary'
  if (bytes.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) return false
  }
  return true
}

/** FBX parse task options (signal/load phases — the AssetLibrary bridge). */
export interface FbxParseTaskOptions {
  readonly signal?: AbortSignal
  readonly onPhase?: (info: { stage: string; ratio: number; detail: string }) => void
}

/**
 * FBX from bytes (the Task 88 contract: Uint8Array + options).
 * A full buffer is mandatory: the FBX tree is read from the end (footer).
 */
export async function parseFbx(
  data: Uint8Array | ArrayBuffer,
  options: FbxParseTaskOptions = {},
): Promise<FbxModel> {
  if (options.signal?.aborted) {
    throw new DOMException('load cancelled', 'AbortError')
  }
  options.onPhase?.({ stage: 'parse', ratio: 0.1, detail: 'FBX: full buffer received' })
  const buffer = (
    data instanceof ArrayBuffer
      ? data
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  ) as ArrayBuffer
  const model = await parseFBX(buffer)
  options.onPhase?.({ stage: 'parse', ratio: 0.9, detail: 'FBX: tree parsed' })
  return model
}
