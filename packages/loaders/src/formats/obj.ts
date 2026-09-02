/**
 * formats/obj.ts — Wavefront OBJ (+ MTL) → MeshDocument.
 *
 * Speed: not a single per-line string in the hot path. The scanner walks over
 * bytes, numbers — parseFastFloat (no allocations), keywords are matched
 * byte-by-byte; strings are created only for names (o/g/usemtl/mtllib) and MTL.
 * "v" vertices accumulate in growable arrays; faces are welded into a merged
 * buffer, the map key is a NUMBER (t<<21|n), there are no string keys.
 *
 * Fast path: if no face referenced vt/vn and there are no streams —
 * indices point directly into the source positions, no weld map is created.
 * The appearance of vt/vn/a slash "upgrades" the state: positions are copied into merged
 * with an identity map (early indices stay valid).
 *
 * Streaming: ObjStreamSink eats chunks as they download and processes
 * whole lines; an unfinished tail is carried over into the next chunk. Geometry
 * parsing genuinely overlaps the network.
 *
 * OBJ semantics: negative indices — from the end; "f a/b/c ..." →
 * fan triangulation; usemtl/o/g — submesh boundaries; several mtllibs are
 * loaded sequentially via ctx.resolveExternal (usually one).
 *
 * MTL → approximate PBR: roughness from Ns (1 - Ns/1000, clamp 0.05..1),
 * alpha from d/Tr, Kd → baseColor, Ke → emissive, map_Kd → baseColorTexture,
 * bump/norm → normalTexture. MTL is not a PBR format — the conversion is honestly lossy.
 */

import type { ParseContext, ParseInput, Parser, StreamSink } from '../core/types.ts'
import { throwIfAborted } from '../core/errors.ts'
import { parseFastFloat, parseFastInt, asciiFromBytes } from '../core/util.ts'
import { concatBytes } from '../core/pipe.ts'
import type {
  ImageAsset,
  MaterialData,
  MeshDocument,
  MeshPrimitive,
  TextureInfo,
} from './mesh.ts'
import { meshStatsOf } from './mesh.ts'

export interface ObjParserOptions {
  /**
   * Load .mtl from mtllib via ctx.resolveExternal (default true).
   * false — materials remain names without parameters.
   */
  loadMtl?: boolean
}

// ─── growable arrays ────────────────────────────────────────────────────────

class GrowableF32 {
  private arr: Float32Array
  private len = 0
  constructor(initial = 1024) {
    this.arr = new Float32Array(initial)
  }
  get length(): number {
    return this.len
  }
  push(v: number): void {
    this.ensure(1)
    this.arr[this.len++] = v
  }
  push3(a: number, b: number, c: number): void {
    this.ensure(3)
    this.arr[this.len++] = a
    this.arr[this.len++] = b
    this.arr[this.len++] = c
  }
  push2(a: number, b: number): void {
    this.ensure(2)
    this.arr[this.len++] = a
    this.arr[this.len++] = b
  }
  at(index: number): number {
    return this.arr[index]
  }
  trimmed(): Float32Array {
    return this.arr.slice(0, this.len)
  }
  private ensure(add: number): void {
    if (this.len + add > this.arr.length) {
      let cap = this.arr.length
      while (cap < this.len + add) cap *= 2
      const next = new Float32Array(cap)
      next.set(this.arr.subarray(0, this.len))
      this.arr = next
    }
  }
}

class GrowableU32 {
  private arr: Uint32Array
  private len = 0
  constructor(initial = 1024) {
    this.arr = new Uint32Array(initial)
  }
  get length(): number {
    return this.len
  }
  push(v: number): void {
    if (this.len >= this.arr.length) {
      let cap = this.arr.length
      while (cap <= this.len) cap *= 2
      const next = new Uint32Array(cap)
      next.set(this.arr)
      this.arr = next
    }
    this.arr[this.len++] = v
  }
  trimmed(): Uint32Array {
    return this.arr.slice(0, this.len)
  }
}

// ─── parse state ───────────────────────────────────────────────────────

interface SubMeshRun {
  material: number
  name: string | null
  offset: number
  count: number
}

interface ObjState {
  /** Positions from "v" — the source stream. */
  srcPositions: GrowableF32
  srcNormals: GrowableF32
  srcUvs: GrowableF32
  /** Merged stream (created lazily on the first slash/vt/vn). */
  outPositions: GrowableF32
  outNormals: GrowableF32
  outUvs: GrowableF32
  indices: GrowableU32
  hasNormals: boolean
  hasUvs: boolean
  /** true = the merged stream is active. */
  welded: boolean
  /** How many indices were written the fast way (before welding). */
  fastCount: number
  /** p → (t<<21|n) → merged index. */
  weld: Map<number, Map<number, number>>
  runs: SubMeshRun[]
  currentMaterial: number
  currentGroup: string | null
  runStart: number
  mtllibs: string[]
  /** usemtl name → local index (before loading MTL). */
  materialNames: Map<string, number>
  warnings: string[]
  totalBytes: number
  ctx: ParseContext
}

const UV_SHIFT = 21 // t,n < 2M records per stream — more than enough for OBJ

function createState(ctx: ParseContext, totalBytes: number): ObjState {
  return {
    srcPositions: new GrowableF32(1 << 12),
    srcNormals: new GrowableF32(1 << 10),
    srcUvs: new GrowableF32(1 << 10),
    outPositions: new GrowableF32(1 << 12),
    outNormals: new GrowableF32(1 << 10),
    outUvs: new GrowableF32(1 << 10),
    indices: new GrowableU32(1 << 12),
    hasNormals: false,
    hasUvs: false,
    welded: false,
    fastCount: 0,
    weld: new Map(),
    runs: [],
    currentMaterial: -1,
    currentGroup: null,
    runStart: 0,
    mtllibs: [],
    materialNames: new Map(),
    warnings: [],
    totalBytes,
    ctx,
  }
}

// ─── line parsing ────────────────────────────────────────────────────────────

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 13
const isTokenEnd = (c: number): boolean => c === -1 || c === 32 || c === 9 || c === 13

/** Process one OBJ line [start, end). */
function processLine(bytes: Uint8Array, start: number, end: number, state: ObjState): void {
  let i = start
  while (i < end && isSpace(bytes[i])) i++
  if (i >= end) return
  const c = bytes[i]
  if (c === 35 /* # */) return

  if (c === 118 /* v */) {
    const second = i + 1 < end ? bytes[i + 1] : -1
    if (second === 110 /* n */) {
      state.hasNormals = true
      pushNumbers(bytes, i + 2, end, state.srcNormals, 3)
    } else if (second === 116 /* t */) {
      state.hasUvs = true
      pushNumbers(bytes, i + 2, end, state.srcUvs, 2)
    } else if (isTokenEnd(second)) {
      pushNumbers(bytes, i + 1, end, state.srcPositions, 3)
    }
    return
  }
  if (c === 102 /* f */ && isTokenEnd(i + 1 < end ? bytes[i + 1] : -1)) {
    processFace(bytes, i + 1, end, state)
    return
  }
  if (matchKeyword(bytes, i, end, 'usemtl')) {
    const name = asciiFromBytes(bytes, i + 7, end).trim()
    setMaterial(state, name.length > 0 ? name : null)
    return
  }
  if (matchKeyword(bytes, i, end, 'mtllib')) {
    const rest = asciiFromBytes(bytes, i + 7, end).trim()
    if (rest.length > 0) state.mtllibs.push(...rest.split(/\s+/))
    return
  }
  if ((c === 111 /* o */ || c === 103 /* g */) && isTokenEnd(i + 1 < end ? bytes[i + 1] : -1)) {
    const name = asciiFromBytes(bytes, i + 1, end).trim()
    if (name !== state.currentGroup) setGroup(state, name.length > 0 ? name : null)
    return
  }
  if (c === 108 /* l */ || c === 112 /* p */) {
    if (state.warnings.length < 16) {
      state.warnings.push(`OBJ: ${c === 108 ? 'l (lines)' : 'p (points)'} not supported — skipped`)
    }
  }
  // 's' (smoothing) and the rest — ignored
}

function matchKeyword(bytes: Uint8Array, i: number, end: number, keyword: string): boolean {
  if (i + keyword.length > end) return false
  for (let k = 0; k < keyword.length; k++) {
    if (bytes[i + k] !== keyword.charCodeAt(k)) return false
  }
  return isTokenEnd(i + keyword.length < end ? bytes[i + keyword.length] : -1)
}

/** Read up to expect floats; missing ones become zeros. */
function pushNumbers(bytes: Uint8Array, start: number, end: number, out: GrowableF32, expect: number): void {
  let i = start
  let count = 0
  while (count < expect && i < end) {
    const r = parseFastFloat(bytes, i, end)
    if (Number.isNaN(r.value)) break
    out.push(r.value)
    i = r.next
    count++
  }
  while (count < expect) {
    out.push(0)
    count++
  }
}

/** Parse "f p/t/n p/t/n ..." → fan triangulation + weld. */
function processFace(bytes: Uint8Array, start: number, end: number, state: ObjState): void {
  const posCount = state.srcPositions.length / 3
  const uvCount = state.srcUvs.length / 2
  const normCount = state.srcNormals.length / 3

  let first = -1
  let prev = -1
  let cornerIndex = 0
  let i = start
  let sawSlash = false
  for (;;) {
    while (i < end && isSpace(bytes[i])) i++
    if (i >= end) break
    const r = parseFastInt(bytes, i, end)
    if (Number.isNaN(r.value)) break
    let p = r.value
    i = r.next
    let t = 0
    let n = 0
    let hasT = false
    let hasN = false
    if (i < end && bytes[i] === 47 /* / */) {
      sawSlash = true
      i++
      if (i < end && bytes[i] !== 47) {
        const rt = parseFastInt(bytes, i, end)
        if (!Number.isNaN(rt.value)) {
          t = rt.value
          i = rt.next
          hasT = true
        }
      }
      if (i < end && bytes[i] === 47) {
        i++
        const rn = parseFastInt(bytes, i, end)
        if (!Number.isNaN(rn.value)) {
          n = rn.value
          i = rn.next
          hasN = true
        }
      }
    }
    if (p < 0) p = posCount + p
    else p -= 1
    if (p < 0 || p >= posCount) {
      if (state.warnings.length < 16) state.warnings.push('OBJ: position index out of range — corner skipped')
      cornerIndex++
      continue
    }
    // 0 = "no reference"; a valid index 0 is indistinguishable — hence the hasT/hasN flags
    if (hasT) {
      t = t < 0 ? uvCount + t : t - 1
      if (t < 0 || t >= uvCount) { t = 0; hasT = false }
    }
    if (hasN) {
      n = n < 0 ? normCount + n : n - 1
      if (n < 0 || n >= normCount) { n = 0; hasN = false }
    }

    // upgrade to the merged stream on the first slash/presence of streams
    if (!state.welded && (sawSlash || state.hasNormals || state.hasUvs)) {
      // an identity copy is needed only if fast indices have already been written
      upgradeToWeld(state, state.fastCount > 0)
    }
    const merged = state.welded ? weldCorner(state, p, hasT ? t : -1, hasN ? n : -1) : p

    if (cornerIndex === 0) {
      first = merged
    } else if (cornerIndex >= 2) {
      state.indices.push(first)
      state.indices.push(prev)
      state.indices.push(merged)
      if (!state.welded) state.fastCount += 3
    }
    prev = merged
    cornerIndex++
    if ((cornerIndex & 8191) === 0) throwIfAborted(state.ctx.signal, 'obj parse')
  }
}

/**
 * Switch the state into merged mode.
 * copyIdentity=true: before the upgrade, indices p were written the fast way → so that they
 * remain valid, all src positions are copied into the out stream with the key
 * (p, missing, missing) → the same index. copyIdentity=false (slashes
 * from the very beginning): copy lazily — out stays empty until the first weld.
 */
function upgradeToWeld(state: ObjState, copyIdentity: boolean): void {
  state.welded = true
  if (!copyIdentity) return
  const count = state.srcPositions.length / 3
  for (let p = 0; p < count; p++) {
    state.outPositions.push3(
      state.srcPositions.at(p * 3),
      state.srcPositions.at(p * 3 + 1),
      state.srcPositions.at(p * 3 + 2),
    )
    if (state.hasUvs) state.outUvs.push2(0, 0)
    if (state.hasNormals) state.outNormals.push3(0, 0, 0)
    let inner = state.weld.get(p)
    if (inner === undefined) {
      inner = new Map()
      state.weld.set(p, inner)
    }
    // identity: t=-1, n=-1 → key (0<<21)|0 = 0
    inner.set(0, p)
  }
}

/** Weld a corner (p,t,n) → a merged index. t/n = -1 means "no reference". */
function weldCorner(state: ObjState, p: number, t: number, n: number): number {
  let inner = state.weld.get(p)
  if (inner === undefined) {
    inner = new Map()
    state.weld.set(p, inner)
  }
  // key: 0 = missing, valid index i → i+1 (so that 0 does not collide)
  const key = ((t + 1) << UV_SHIFT) | (n + 1)
  const existing = inner.get(key)
  if (existing !== undefined) return existing

  const mergedIndex = state.outPositions.length / 3
  state.outPositions.push3(
    state.srcPositions.at(p * 3),
    state.srcPositions.at(p * 3 + 1),
    state.srcPositions.at(p * 3 + 2),
  )
  if (state.hasUvs) {
    if (t >= 0) state.outUvs.push2(state.srcUvs.at(t * 2), state.srcUvs.at(t * 2 + 1))
    else state.outUvs.push2(0, 0)
  }
  if (state.hasNormals) {
    if (n >= 0) {
      state.outNormals.push3(state.srcNormals.at(n * 3), state.srcNormals.at(n * 3 + 1), state.srcNormals.at(n * 3 + 2))
    } else {
      state.outNormals.push3(0, 0, 0)
    }
  }
  inner.set(key, mergedIndex)
  return mergedIndex
}

function setMaterial(state: ObjState, name: string | null): void {
  let index = -1
  if (name !== null) {
    const existing = state.materialNames.get(name)
    if (existing !== undefined) index = existing
    else {
      index = state.materialNames.size
      state.materialNames.set(name, index)
    }
  }
  if (index !== state.currentMaterial) {
    closeRun(state)
    state.currentMaterial = index
  }
}

function setGroup(state: ObjState, name: string | null): void {
  closeRun(state)
  state.currentGroup = name
}

function closeRun(state: ObjState): void {
  const end = state.indices.length
  if (end > state.runStart) {
    state.runs.push({
      material: state.currentMaterial,
      name: state.currentGroup,
      offset: state.runStart,
      count: end - state.runStart,
    })
  }
  state.runStart = end
}

// ─── MTL ─────────────────────────────────────────────────────────────────────

export interface MtlMaterial {
  name: string
  kd: [number, number, number]
  ks: [number, number, number]
  ke: [number, number, number]
  ns: number
  d: number
  tr: number
  illum: number
  mapKd: string | null
  mapKs: string | null
  mapKe: string | null
  mapBump: string | null
  mapD: string | null
  norm: string | null
}

/** Parse .mtl from bytes (a small text file — string parsing is fine). */
export function parseMtlBytes(bytes: Uint8Array): MtlMaterial[] {
  const out: MtlMaterial[] = []
  let current: MtlMaterial | null = null
  const text = asciiFromBytes(bytes)
  const lines = text.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const spaceIdx = line.indexOf(' ')
    const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx)
    const rest = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1).trim()
    switch (key) {
      case 'newmtl':
        current = {
          name: rest,
          kd: [0.8, 0.8, 0.8], ks: [0, 0, 0], ke: [0, 0, 0],
          ns: 0, d: 1, tr: -1, illum: 1,
          mapKd: null, mapKs: null, mapKe: null, mapBump: null, mapD: null, norm: null,
        }
        out.push(current)
        break
      case 'Kd':
        if (current !== null) current.kd = parseTriple(rest)
        break
      case 'Ks':
        if (current !== null) current.ks = parseTriple(rest)
        break
      case 'Ke':
        if (current !== null) current.ke = parseTriple(rest)
        break
      case 'Ns':
        if (current !== null) current.ns = Number.parseFloat(rest) || 0
        break
      case 'd':
        if (current !== null) current.d = Number.parseFloat(rest) || 1
        break
      case 'Tr':
        if (current !== null) current.tr = Number.parseFloat(rest) || 0
        break
      case 'illum':
        if (current !== null) current.illum = Number.parseInt(rest, 10) || 1
        break
      case 'map_Kd': if (current !== null) current.mapKd = firstToken(rest); break
      case 'map_Ks': if (current !== null) current.mapKs = firstToken(rest); break
      case 'map_Ke': if (current !== null) current.mapKe = firstToken(rest); break
      case 'map_d': if (current !== null) current.mapD = firstToken(rest); break
      case 'map_bump': case 'bump': if (current !== null) current.mapBump = firstToken(rest); break
      case 'norm': case 'normal_map': if (current !== null) current.norm = firstToken(rest); break
      default: break // exporter extensions — skipped silently
    }
  }
  return out
}

function firstToken(rest: string): string | null {
  const t = rest.split(/\s+/)[0]
  return t !== undefined && t.length > 0 ? t : null
}

function parseTriple(rest: string): [number, number, number] {
  const parts = rest.split(/\s+/)
  return [
    Number.parseFloat(parts[0] ?? '') || 0,
    Number.parseFloat(parts[1] ?? '') || 0,
    Number.parseFloat(parts[2] ?? '') || 0,
  ]
}

// ─── document assembly ────────────────────────────────────────────────────────

/** MTL → MaterialData[] + images; uris are resolved against the source obj URL. */
function mtlToMaterials(
  mtl: readonly MtlMaterial[],
  ctx: ParseContext,
  baseOffset: number,
  images: ImageAsset[],
): MaterialData[] {
  const materials: MaterialData[] = []
  const imageIndexCache = new Map<string, number>()
  const tex = (path: string | null): TextureInfo | null => {
    if (path === null) return null
    let idx = imageIndexCache.get(path)
    if (idx === undefined) {
      idx = images.length
      imageIndexCache.set(path, idx)
      images.push({
        name: path,
        mimeType: null,
        bytes: null,
        uri: ctx.resolveUrl(ctx.sourceUrl, path),
      })
    }
    return { image: idx, texCoord: 0, sampler: null }
  }

  for (const m of mtl) {
    const alpha = m.tr >= 0 ? 1 - m.tr : m.d
    const roughness = m.ns > 0 ? Math.max(0.05, Math.min(1, 1 - m.ns / 1000)) : 1
    materials.push({
      name: m.name,
      baseColor: [m.kd[0], m.kd[1], m.kd[2], alpha],
      metallic: 0,
      roughness,
      emissive: [m.ke[0], m.ke[1], m.ke[2]],
      emissiveStrength: 1,
      normalScale: 1,
      occlusionStrength: 1,
      alphaMode: alpha < 1 ? 'blend' : 'opaque',
      alphaCutoff: 0.5,
      doubleSided: false,
      baseColorTexture: tex(m.mapKd),
      metallicRoughnessTexture: tex(m.mapKs),
      normalTexture: tex(m.mapBump ?? m.norm),
      emissiveTexture: tex(m.mapKe),
      occlusionTexture: null,
      source: 'obj',
    })
  }
  void baseOffset
  return materials
}

/** Finalize the state → MeshDocument (+ MTL, if it succeeded). */
async function finalizeObj(state: ObjState, opts: ObjParserOptions): Promise<MeshDocument> {
  closeRun(state)
  throwIfAborted(state.ctx.signal, 'obj finalize')

  // align the lengths of merged streams (vt/vn declared AFTER the first faces)
  const vertexCount = (state.welded ? state.outPositions.length : state.srcPositions.length) / 3
  while (state.hasUvs && state.outUvs.length < vertexCount * 2) state.outUvs.push2(0, 0)
  while (state.hasNormals && state.outNormals.length < vertexCount * 3) state.outNormals.push3(0, 0, 0)

  const positions = state.welded ? state.outPositions.trimmed() : state.srcPositions.trimmed()
  const normals = state.hasNormals ? state.outNormals.trimmed() : null
  const uvs = state.hasUvs ? state.outUvs.trimmed() : null
  const indices = state.indices.trimmed()

  // MTL: load all declared libraries
  const materials: MaterialData[] = []
  const images: ImageAsset[] = []
  const mtlLoaded: string[] = []
  if ((opts.loadMtl ?? true) && state.mtllibs.length > 0) {
    // reverse map: local usemtl index → name
    const indexToName = new Map<number, string>()
    for (const [name, idx] of state.materialNames) indexToName.set(idx, name)
    // name → index in the combined material list
    const nameToFinal = new Map<string, number>()
    for (const lib of state.mtllibs) {
      try {
        const mtlBytes = await state.ctx.resolveExternal(lib)
        mtlLoaded.push(lib)
        const converted = mtlToMaterials(parseMtlBytes(mtlBytes), state.ctx, materials.length, images)
        for (let i = 0; i < converted.length; i++) {
          const name = converted[i].name
          if (name !== null) nameToFinal.set(name, materials.length + i)
        }
        materials.push(...converted)
      } catch (err) {
        if (state.warnings.length < 16) {
          state.warnings.push(`OBJ: mtllib "${lib}" failed to load: ${String((err as Error)?.message ?? err)}`)
        }
      }
    }
    // remap run.material by names
    for (const run of state.runs) {
      if (run.material >= 0) {
        const name = indexToName.get(run.material)
        run.material = name !== undefined ? (nameToFinal.get(name) ?? -1) : -1
      }
    }
  }

  const primitive: MeshPrimitive = {
    positions,
    normals,
    uvs,
    uvs2: null,
    tangents: null,
    colors: null,
    joints: null,
    weights: null,
    indices,
    mode: 'triangles',
    submeshes: state.runs,
  }
  const nodes = [
    {
      name: state.currentGroup ?? 'obj',
      translation: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      matrix: null,
      primitives: [0],
      skin: -1,
      children: [],
    },
  ]
  const doc: MeshDocument = {
    source: 'obj',
    meshNames: [state.currentGroup ?? 'obj'],
    meshes: [primitive],
    materials,
    images,
    samplers: [],
    nodes,
    scenes: [[0]],
    skins: [],
    animations: [],
    stats: meshStatsOf([primitive], materials, images, nodes, []),
    mtllibs: mtlLoaded,
  }
  return doc
}

// ─── stream sink ──────────────────────────────────────────────────────────────

/** Chunks → whole lines → processLine; the tail is carried over. */
class ObjStreamSink implements StreamSink<MeshDocument> {
  private pending: Uint8Array | null = null
  private processedBytes = 0
  private finished = false

  constructor(
    private readonly state: ObjState,
    private readonly opts: ObjParserOptions,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.finished) return
    const bytes = this.pending === null ? chunk : concatBytes(this.pending, chunk)
    this.pending = null
    let lineStart = 0
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 10 /* \n */) {
        processLine(bytes, lineStart, i, this.state)
        lineStart = i + 1
      }
    }
    if (lineStart < bytes.length) {
      this.pending = bytes.slice(lineStart)
    }
    this.processedBytes += bytes.length
    if (this.state.totalBytes > 0) {
      this.state.ctx.reportProgress(Math.min(1, this.processedBytes / this.state.totalBytes))
    }
    throwIfAborted(this.state.ctx.signal, 'obj parse')
  }

  async finish(): Promise<MeshDocument> {
    if (this.finished) throw new Error('obj: finish() already called')
    this.finished = true
    if (this.pending !== null) {
      processLine(this.pending, 0, this.pending.length, this.state)
      this.pending = null
    }
    return finalizeObj(this.state, this.opts)
  }
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export const objParser: Parser<MeshDocument, ObjParserOptions> = {
  kind: 'obj',
  extensions: ['.obj'],
  parse(input: ParseInput, options: ObjParserOptions = {}): Promise<MeshDocument> {
    const state = createState(input.ctx, input.bytes.length)
    const bytes = input.bytes
    let lineStart = 0
    let lineCount = 0
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 10) {
        processLine(bytes, lineStart, i, state)
        lineStart = i + 1
        if ((lineCount++ & 8191) === 0) throwIfAborted(input.ctx.signal, 'obj parse')
      }
    }
    if (lineStart < bytes.length) processLine(bytes, lineStart, bytes.length, state)
    return finalizeObj(state, options)
  },
  streaming(ctx: ParseContext, options: ObjParserOptions = {}): StreamSink<MeshDocument> {
    const state = createState(ctx, ctx.byteLength ?? 0)
    return new ObjStreamSink(state, options)
  },
}

/** Parse OBJ from ready bytes (outside the manager). */
export async function parseObj(
  bytes: Uint8Array,
  ctx: ParseContext,
  options: ObjParserOptions = {},
): Promise<MeshDocument> {
  return objParser.parse({ bytes, ctx }, options)
}
