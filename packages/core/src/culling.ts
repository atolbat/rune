/**
 * culling.ts — Task 201: THE COMPOSABLE CULLING KIT (pure, device-free).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY HERE: the GPU pipeline (packages/gl device.ts) owns the FRAME — the
 * z prepass, the pyramid, the kernel, the compact. But a culling SYSTEM is
 * more than one frame recipe: it is POLICIES (what counts as an occluder,
 * what may be culled, how verdicts behave over TIME) and CPU-side answers
 * (a worker culling before it ships a draw, a picking ray, a selection
 * marquee, a vegetation cluster). Those bricks must be pure — no device,
 * no DOM, plain arithmetic — so the same policy runs on the GPU path's
 * validation gates, in a worker, or over a scene graph.
 *
 * THE FROSTBITE NOTES MADE CODE (the user's field citations):
 *   · HYSTERESIS — «объект не мигает при переключении видимости»: an
 *     occluded verdict must hold for K consecutive frames before the
 *     object is actually culled (BF3's software culler ran exactly this).
 *     The GPU leg (device.hysteresisPass) and this kit share ONE encoding:
 *     verdict + streak/32 in a single float word.
 *   · DATA-ORIENTED DESIGN — «структуры массивов»: the kit never sees
 *     boxed objects; it sees the SCENE'S OWN Float32Array through a
 *     strided RecordView (zero-copy, zero allocation per query).
 *   · SOFTWARE OCCLUSION — «окклюдеры растеризуются программно в маленький
 *     depth-буфер + иерархический Z»: the softwareOccluder brick is the
 *     CPU twin of the GPU pyramid — a conservative front-plane raster into
 *     a tiny depth buffer + the same 2×2 max reduce + the same sound
 *     nearest-corner test. For a worker that culls BEFORE submitting
 *     draws (the 64-player battlefield shape), this is the whole job.
 *   · CLUSTERING — dense populations (vegetation, crowds, debris) cull
 *     in TWO tiers: the cluster's AABB answers the broad question, the
 *     members answer the narrow one only for surviving clusters.
 *
 * THE BILLBOARD / FLAT-GEOMETRY ANSWER (the user's «грани под углами»):
 *   a flat object (a wall, a sign, a crossed-quad tree) seen EDGE-ON has a
 *   degenerate projected rect — its thinnest world axis projects to ~0
 *   texels. flatCull() tests exactly that: the projected rect's MIN side
 *   below a texel threshold ⇒ rendering buys nothing (the Hi-Z tile is
 *   half-res: 1 tile texel ≈ 2 screen pixels — the threshold rides the
 *   caller's own tile). No normals needed, no winding needed — the
 *   projection does the math the |dot(n, view)| form does, one step
 *   earlier and for any flat shape, not just camera-facing billboards.
 *
 * THE TRANSPARENCY ANSWER (the user's «прозрачные и полупрозрачные»):
 *   layerPolicy() — every layer resolves to two booleans: `occluder`
 *     (does it WRITE the z prepass? glass does not — its depth would
 *     hide what the player must see through it) and `occludee` (may it
 *     BE culled? glass behind a wall is still invisible — YES). An
 *     excluded-everything layer (`occluder: false, occludee: false`) is
 *     the «выключить объекты из окклюжна» switch, one line.
 * ══════════════════════════════════════════════════════════════════════════
 */

// ─── the record view (SoA over the scene's own words) ─────────────────────

/** A strided view over the scenario's instance records — the data-oriented
 *  front door. `words` is the scene's Float32Array (WG legs: the whole
 *  scene buffer; CPU legs: the same array the demo built), `base` the word
 *  offset of record 0, `stride` words per record, `fields` the word offsets
 *  of the AABB feed. All kit bricks speak THIS shape — zero boxing, zero
 *  copies, the same numbers the GPU kernel reads. */
export interface RecordView {
  readonly count: number
  readonly stride: number
  readonly words: Float32Array
  readonly base: number
  readonly center: number
  readonly half: number
  cx(i: number): number
  cy(i: number): number
  cz(i: number): number
  hx(i: number): number
  hy(i: number): number
  hz(i: number): number
}

export function recordView(
  words: Float32Array,
  base: number,
  count: number,
  stride: number,
  fields: { center: number; half: number },
): RecordView {
  const cOff = base + fields.center
  const hOff = base + fields.half
  return {
    count, stride, words, base, center: fields.center, half: fields.half,
    cx: (i: number) => words[cOff + i * stride],
    cy: (i: number) => words[cOff + i * stride + 1],
    cz: (i: number) => words[cOff + i * stride + 2],
    hx: (i: number) => words[hOff + i * stride],
    hy: (i: number) => words[hOff + i * stride + 1],
    hz: (i: number) => words[hOff + i * stride + 2],
  }
}

// ─── the shared projection (the 8-corner walk, fp64) ──────────────────────

/** The 8-corner projection scratch: [x0, x1, y0, y1, minZ, minW, anyFinite]. */
export type ProjectedBox = Float64Array

/** Projects a record's AABB through a COLUMN-MAJOR mvp: the conservative
 *  screen rect (tile units), the NEAREST normalized z, the NEAREST w.
 *  Corners at/behind the eye (w ≤ 1e-4) contribute nothing (the kernel's
 *  own guard — a straddler is never flat-culled, never hidden). `zMap`:
 *  0 = the WebGPU-style z ∈ [0,1] (the demo's own matrices — the value
 *  rides as-is); 1 = the GL-style z ∈ [−1,1] (remapped (nz+1)·0.5 — the
 *  monotonicity is all the consumers need). */
export function projectBox(
  mvp: ArrayLike<number>,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  out: ProjectedBox,
  tileW: number, tileH: number,
  zMap: 0 | 1 = 0,
): ProjectedBox {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  let minZ = Infinity, minW = Infinity, anyFinite = 0
  for (let k = 0; k < 8; k++) {
    const sx = (k & 1) * 2 - 1
    const sy = ((k >> 1) & 1) * 2 - 1
    const sz = ((k >> 2) & 1) * 2 - 1
    const x = cx + sx * hx, y = cy + sy * hy, z = cz + sz * hz
    const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15]
    // minW counts EVERY corner (the kernel's own semantics — a corner at
    // or behind the eye marks the box a straddler even when the valid
    // corners' w is huge)
    if (w < minW) minW = w
    if (w > 1e-4) {
      anyFinite = 1
      const nx = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w
      const ny = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w
      const nz = (mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14]) / w
      const px = (nx * 0.5 + 0.5) * tileW
      const py = (ny * 0.5 + 0.5) * tileH
      const d = zMap === 1 ? (nz + 1) * 0.5 : nz
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      if (d < minZ) minZ = d
    }
  }
  out[0] = x0; out[1] = x1; out[2] = y0; out[3] = y1
  out[4] = minZ; out[5] = minW; out[6] = anyFinite
  return out
}

// ─── the frustum sweep (the kit's CPU mirror of the kernel's plane walk) ──

/** Per-record frustum verdicts: 1 = visible (inside or straddling), 2 =
 *  fully outside some plane. The planes are frustumPlanes()'s 24-float
 *  layout; `out` may be provided (the zero-alloc hot path). */
export function frustumVerdicts(
  view: RecordView,
  planes: ArrayLike<number>,
  out?: Uint8Array,
): Uint8Array {
  const v = out ?? new Uint8Array(view.count)
  for (let i = 0; i < view.count; i++) {
    let outside = false
    for (let p = 0; p < 6 && !outside; p++) {
      const o = p * 4
      const reach = Math.abs(planes[o]) * view.hx(i) + Math.abs(planes[o + 1]) * view.hy(i) + Math.abs(planes[o + 2]) * view.hz(i)
      if (planes[o] * view.cx(i) + planes[o + 1] * view.cy(i) + planes[o + 2] * view.cz(i) + planes[o + 3] < -reach) outside = true
    }
    v[i] = outside ? 2 : 1
  }
  return v
}

// ─── HYSTERESIS (the Frostbite temporal policy) ───────────────────────────

/** THE ENCODING CONTRACT (shared with the GPU leg — device.hysteresisPass):
 *  one float word = verdict + streak/32, streak ≤ 15. floor(word) reads
 *  the verdict; (word − floor(word))·32 reads the streak. 1/32 steps are
 *  EXACT binary fractions — the encoding is lossless in f32, f64, and the
 *  u32 twin (verdict | streak << 8) reads the same numbers. */
export const HYST_STREAK_SCALE = 32

export function decodeVerdict(word: number): number {
  return Math.floor(word)
}
export function decodeStreak(word: number): number {
  return (word - Math.floor(word)) * HYST_STREAK_SCALE
}

export interface HysteresisPolicy {
  readonly frames: number
  /** Folds this frame's RAW verdicts (the kernel's own 1..4 words) into
   *  the persistent `state` (the encoded words — allocate once per scene):
   *  an occluded verdict must repeat `frames` times before it culls; a
   *  visible verdict shows IMMEDIATELY (the asymmetric Frostbite form —
   *  late-culled is safe, late-shown is a pop). Returns the same state. */
  apply(raw: ArrayLike<number>, state: Float32Array): Float32Array
  /** The smoothed verdict of record i (1..4 — the raw vocabulary). */
  verdict(state: Float32Array, i: number): number
}

/** The temporal smoothing brick. `frames` = how many consecutive occluded
 *  frames before the cull lands (default 3; 1 = off — the raw verdicts).
 *  Why it is PIXEL-SAFE in the GPU pipeline: a box the policy keeps
 *  visible one extra frame is a box the kernel already proved occluded —
 *  the depth test buries it behind the very wall that occludes it. The
 *  image never changes; only the draw count decays. */
export function hysteresisPolicy(options?: { frames?: number }): HysteresisPolicy {
  const frames = Math.max(1, Math.min(15, options?.frames ?? 3))
  return {
    frames,
    apply(raw: ArrayLike<number>, state: Float32Array): Float32Array {
      for (let i = 0; i < state.length; i++) {
        const r = Math.floor(raw[i])
        const prev = state[i]
        const streak = (prev - Math.floor(prev)) * HYST_STREAK_SCALE
        if (r === 3) {
          const s = Math.min(streak + 1, 15)
          state[i] = (s >= frames ? 3 : 1) + s / HYST_STREAK_SCALE
        } else {
          state[i] = r
        }
      }
      return state
    },
    verdict(state: Float32Array, i: number): number {
      return Math.floor(state[i])
    },
  }
}

// ─── FLAT / BILLBOARD CULL (the edge-on geometry policy) ──────────────────

export interface FlatCull {
  readonly minTexels: number
  /** Verdicts over the view at this camera: 1 = worth rendering, 5 = the
   *  projected rect's min side is under `minTexels` tile texels — the
   *  edge-on sliver class (or a genuinely tiny object — the same test,
   *  the same honest answer: it covers ~nothing). */
  test(view: RecordView, mvp: ArrayLike<number>, out?: Uint8Array): Uint8Array
}

/** The flat-geometry brick. A wall seen edge-on, a fixed billboard seen
 *  from its side, a crossed-quad tree from the corner: the AABB's
 *  projection degenerates exactly when the object covers no meaningful
 *  pixels — the thin axis folds into the long one. The test needs no
 *  normals and no winding; the caller owns the threshold (the demo's Hi-Z
 *  tile is half-res — 2 tile texels ≈ 4 screen pixels, the honest
 *  «no point rendering» line for a 960×540 canvas). */
export function flatCull(options: { minTexels?: number; tileW: number; tileH: number }): FlatCull {
  const minTexels = Math.max(1, options.minTexels ?? 2)
  const tileW = options.tileW
  const tileH = options.tileH
  const scratch = new Float64Array(7)
  return {
    minTexels,
    test(view: RecordView, mvp: ArrayLike<number>, out?: Uint8Array): Uint8Array {
      const v = out ?? new Uint8Array(view.count)
      for (let i = 0; i < view.count; i++) {
        const p = projectBox(mvp, view.cx(i), view.cy(i), view.cz(i), view.hx(i), view.hy(i), view.hz(i), scratch, tileW, tileH, 0)
        // a straddler (a corner behind the eye) is NEVER flat-culled —
        // the projected rect is meaningless there
        if (p[6] < 1 || p[5] <= 1e-4) { v[i] = 1; continue }
        const w = p[1] - p[0]
        const h = p[3] - p[2]
        v[i] = (w < minTexels || h < minTexels) ? 5 : 1
      }
      return v
    },
  }
}

// ─── LAYERS (the transparency / participation policy) ─────────────────────

export interface LayerVerdict { readonly occluder: boolean; readonly occludee: boolean }

/** The participation policy: what each named layer does in the cull.
 *  Defaults are the OPAQUE answer (occluder AND occludee); the glass
 *  half of the world is `{ occluder: false }` (never writes depth — a
 *  transparent depth-writer would hide what must be seen through it,
 *  and a blended fragment's z is not «in front of» anything), while
 *  fully-excluded objects (UI ghosts, editor gizmos) are both false —
 *  the «выключить из окклюжна» switch. */
export function layerPolicy(spec: Record<string, { occluder?: boolean; occludee?: boolean }>): {
  of(name: string): LayerVerdict
  /** Resolves every record through `assign` (the name of record i's layer)
   *  into two per-record masks — the occluder feed and the occludee feed. */
  masks(count: number, assign: (i: number) => string): { occluder: Uint8Array; occludee: Uint8Array }
} {
  const table = new Map<string, LayerVerdict>()
  for (const [name, v] of Object.entries(spec)) {
    table.set(name, { occluder: v.occluder ?? true, occludee: v.occludee ?? true })
  }
  const fallback: LayerVerdict = { occluder: true, occludee: true }
  return {
    of(name: string): LayerVerdict {
      return table.get(name) ?? fallback
    },
    masks(count: number, assign: (i: number) => string) {
      const occluder = new Uint8Array(count)
      const occludee = new Uint8Array(count)
      for (let i = 0; i < count; i++) {
        const v = table.get(assign(i)) ?? fallback
        occluder[i] = v.occluder ? 1 : 0
        occludee[i] = v.occludee ? 1 : 0
      }
      return { occluder, occludee }
    },
  }
}

// ─── CLUSTERING (the dense-population two-tier cull) ─────────────────────

export interface SpatialCluster {
  /** the cluster's tight world bounds (the union of its members' AABBs) */
  readonly minx: number; readonly miny: number; readonly minz: number
  readonly maxx: number; readonly maxy: number; readonly maxz: number
  /** the member record ids (a view slice — never a copy) */
  readonly ids: Uint32Array
}

/** Groups the view's records into a uniform XZ grid of `cell` world units
 *  (vegetation lives on the ground plane — the y axis folds into the
 *  bounds, not the addressing). The two-tier cull: query the CLUSTERS
 *  first (one AABB per cell — the frustum/occlusion answer for the whole
 *  population at 1/N the tests), then test the members of the survivors
 *  only. A culled cluster's members are provably culled (the cluster
 *  bound ⊇ every member bound) — conservative by construction. */
export function clusterize(view: RecordView, options?: { cell?: number }): {
  clusters: SpatialCluster[]
  cell: number
  stats: { clusters: number; avg: number; max: number }
} {
  const cell = Math.max(0.001, options?.cell ?? 8)
  const buckets = new Map<number, number[]>()
  for (let i = 0; i < view.count; i++) {
    const gx = Math.floor(view.cx(i) / cell)
    const gz = Math.floor(view.cz(i) / cell)
    const key = (gx + 4096) * 8192 + (gz + 4096)
    let list = buckets.get(key)
    if (list === undefined) { list = []; buckets.set(key, list) }
    list.push(i)
  }
  const clusters: SpatialCluster[] = []
  let maxSize = 0
  for (const ids of buckets.values()) {
    let minx = Infinity, miny = Infinity, minz = Infinity
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
    for (const i of ids) {
      if (view.cx(i) - view.hx(i) < minx) minx = view.cx(i) - view.hx(i)
      if (view.cy(i) - view.hy(i) < miny) miny = view.cy(i) - view.hy(i)
      if (view.cz(i) - view.hz(i) < minz) minz = view.cz(i) - view.hz(i)
      if (view.cx(i) + view.hx(i) > maxx) maxx = view.cx(i) + view.hx(i)
      if (view.cy(i) + view.hy(i) > maxy) maxy = view.cy(i) + view.hy(i)
      if (view.cz(i) + view.hz(i) > maxz) maxz = view.cz(i) + view.hz(i)
    }
    if (ids.length > maxSize) maxSize = ids.length
    clusters.push({ minx, miny, minz, maxx, maxy, maxz, ids: Uint32Array.from(ids) })
  }
  return {
    clusters,
    cell,
    stats: {
      clusters: clusters.length,
      avg: clusters.length === 0 ? 0 : view.count / clusters.length,
      max: maxSize,
    },
  }
}

// ─── THE SOFTWARE OCCLUDER (the Frostbite CPU brick) ──────────────────────

/** The CPU occlusion brick: `begin(mvp)` → `writeBox(...)` for every
 *  occluder → `reduce()` → `hidden(...)` for the occludees. The
 *  conservative front-plane raster: each occluder fills its projected
 *  rect with its NEAREST corner's z (a z ≤ every actual surface z in that
 *  rect — the buffer never claims more coverage than the box really
 *  has); overlapping writers keep the NEAREST value (the depth-test
 *  direction). The 2×2 max pyramid then answers «the farthest thing in
 *  this region is at z» — the same reduce, the same sound nearest-corner
 *  compare, the same count-form integer mip pick as the GPU kernels.
 *
 *  THE HONEST SCOPE: this under-occludes (the front plane is closer than
 *  the real surfaces — a box judged hidden here is hidden EVERYWHERE,
 *  including the GPU's own pyramid; the converse does not hold). That is
 *  the right direction for a worker-side pre-cull: never wrong, often
 *  enough right to skip whole draw submissions. */
export function softwareOccluder(options?: { width?: number; height?: number; zMap?: 0 | 1 }): {
  readonly width: number
  readonly height: number
  readonly levels: number
  begin(mvp: ArrayLike<number>): void
  writeBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void
  writeView(view: RecordView, i: number): void
  reduce(): void
  hidden(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): boolean
  hiddenView(view: RecordView, i: number): boolean
} {
  const width = Math.max(2, options?.width ?? 256)
  const height = Math.max(2, options?.height ?? 144)
  const zMap: 0 | 1 = options?.zMap ?? 0
  // the mip dims: level 0 = the tile, then the 2×2 halves down to 1×1
  const dims: { w: number; h: number }[] = [{ w: width, h: height }]
  for (;;) {
    const prev = dims[dims.length - 1]
    const w = Math.max(1, Math.ceil(prev.w / 2))
    const h = Math.max(1, Math.ceil(prev.h / 2))
    dims.push({ w, h })
    if (w === 1 && h === 1) break
  }
  const levels = dims.length
  const zbuf = new Float64Array(width * height)
  const mips: Float64Array[] = [zbuf]
  for (let L = 1; L < levels; L++) {
    mips.push(new Float64Array(dims[L].w * dims[L].h))
  }
  const proj = new Float64Array(7)
  let mvp: ArrayLike<number> | null = null
  let reduced = false
  // the 8-corner scratch (px, py, z — w already guarded) + the face raster
  const cornerPx = new Float64Array(8)
  const cornerPy = new Float64Array(8)
  const cornerZ = new Float64Array(8)

  /** ONE TRIANGLE of a face quad, edge-function fill with the perspective
   *  plane depth: z/w is AFFINE in screen space over a planar source, so
   *  the screen barycentric interpolation of the corner depths IS the
   *  perspective-correct depth (the standard rasterizer identity). The
   *  fill is INCLUSIVE (edge values of the area's sign count — pixels
   *  whose centers sit exactly on an edge are covered) and the bounding
   *  rect grows one texel outward (the hidden() twin's own guard). */
  function rasterTri(i0: number, i1: number, i2: number): void {
    const x0 = cornerPx[i0], y0 = cornerPy[i0], z0 = cornerZ[i0]
    const x1 = cornerPx[i1], y1 = cornerPy[i1], z1 = cornerZ[i1]
    const x2 = cornerPx[i2], y2 = cornerPy[i2], z2 = cornerZ[i2]
    const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)
    if (Math.abs(area) < 1e-12) return // a degenerate sliver (an edge-on face)
    const sign = area > 0 ? 1 : -1
    let minx = Math.floor(Math.min(x0, x1, x2)) - 1
    let maxx = Math.ceil(Math.max(x0, x1, x2)) + 1
    let miny = Math.floor(Math.min(y0, y1, y2)) - 1
    let maxy = Math.ceil(Math.max(y0, y1, y2)) + 1
    minx = Math.max(0, minx); miny = Math.max(0, miny)
    maxx = Math.min(width, maxx); maxy = Math.min(height, maxy)
    const inv = 1 / area
    for (let py = miny; py < maxy; py++) {
      const row = py * width
      for (let px = minx; px < maxx; px++) {
        // THE EXACT CENTER FILL (the honest twin of the hardware raster —
        // a conservative rim would extrapolate the face plane beyond the
        // silhouette, where the real surface bends AWAY: the extrapolated
        // z runs NEARER than the truth and the buffer over-claims — the
        // exact fill + the doubled read guard is the sound combination)
        const e0 = ((x2 - x1) * (py + 0.5 - y1) - (y2 - y1) * (px + 0.5 - x1)) * sign
        const e1 = ((x0 - x2) * (py + 0.5 - y2) - (y0 - y2) * (px + 0.5 - x2)) * sign
        const e2 = ((x1 - x0) * (py + 0.5 - y0) - (y1 - y0) * (px + 0.5 - x0)) * sign
        if (e0 < 0 || e1 < 0 || e2 < 0) continue
        const b0 = e0 * inv * sign
        const b1 = e1 * inv * sign
        const b2 = e2 * inv * sign
        const z = b0 * z0 + b1 * z1 + b2 * z2
        const idx = row + px
        if (z < zbuf[idx]) zbuf[idx] = z
      }
    }
  }

  /** A face quad (its 4 projected corners) as 2 triangles. */
  function rasterQuad(a: number, b: number, c: number, d: number): void {
    rasterTri(a, b, c)
    rasterTri(a, c, d)
  }

  function mipOf(size: number): number {
    // the count form — the smallest L with 2^L ≥ size (the kernels' own
    // integer spell; ≤ 9 iterations at these tile sizes)
    let L = 0
    while ((1 << L) < size) L++
    return Math.min(L, mips.length - 1)
  }

  return {
    width, height,
    get levels() { return levels },
    begin(nextMvp: ArrayLike<number>): void {
      mvp = nextMvp
      reduced = false
      zbuf.fill(1)
      for (let L = 1; L < mips.length; L++) mips[L].fill(-1)
    },
    writeBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
      if (mvp === null) throw new Error('rune/core: softwareOccluder.writeBox — begin(mvp) first (the tile is per-camera)')
      // THE 8-CORNER PROJECTION (per-corner — the faces need each corner's
      // own screen position and depth; a straddler box — any corner at or
      // behind the eye — refuses to write at all, the safe direction)
      for (let k = 0; k < 8; k++) {
        const sx = (k & 1) * 2 - 1
        const sy = ((k >> 1) & 1) * 2 - 1
        const sz = ((k >> 2) & 1) * 2 - 1
        const x = cx + sx * hx, y = cy + sy * hy, z = cz + sz * hz
        const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15]
        if (w <= 1e-4) return // the straddler guard (the kernel's own class)
        const nx = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w
        const ny = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w
        let nz = (mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14]) / w
        if (zMap === 1) nz = (nz + 1) * 0.5
        cornerPx[k] = (nx * 0.5 + 0.5) * width
        cornerPy[k] = (ny * 0.5 + 0.5) * height
        cornerZ[k] = nz
      }
      // THE 3 FRONT FACES — the box's visible hull: per axis, the face
      // whose center projects NEARER is the camera-facing one (a depth
      // compare — no eye position needed). Their union IS the silhouette
      // the GPU's z prepass would raster; writing THEIR depth (not a flat
      // front-corner plane over the bounding rect — that OVER-CLAIMS
      // occlusion the box does not have) keeps the brick sound: every
      // texel's value is a real surface depth of this box.
      // corner k: (k&1)→x, ((k>>1)&1)→y, ((k>>2)&1)→z half signs
      const faceAlong = (axis: 0 | 1 | 2, front: boolean): [number, number, number, number] => {
        // the four corners sharing the axis's chosen face plane, in
        // PERIMETER order: the k enumeration walks the two free bits
        // row-major ((hi,lo) = 00, 01, 10, 11) — a BOWTIE as a quad; the
        // last two swap into the walk-around order (00, 01, 11, 10)
        const ids: number[] = []
        for (let k = 0; k < 8; k++) {
          const bit = (k >> axis) & 1
          if (front ? bit === 0 : bit === 1) ids.push(k)
        }
        return [ids[0], ids[1], ids[3], ids[2]]
      }
      const m = mvp as ArrayLike<number>
      const faceNear = (axis: 0 | 1 | 2): boolean => {
        // project the two face centers along the axis; the NEARER one is
        // front (center = the box center with the axis half pushed)
        const half = axis === 0 ? hx : axis === 1 ? hy : hz
        const c = axis === 0 ? cx : axis === 1 ? cy : cz
        let dFront = 0, dBack = 0
        for (const sign of [-1, 1]) {
          const x = axis === 0 ? c + sign * half : cx
          const y = axis === 1 ? c + sign * half : cy
          const z = axis === 2 ? c + sign * half : cz
          const w = m[3] * x + m[7] * y + m[11] * z + m[15]
          const d = (m[2] * x + m[6] * y + m[10] * z + m[14]) / (w !== 0 ? w : 1)
          if (sign < 0) dFront = d
          else dBack = d
        }
        return dFront <= dBack
      }
      for (const axis of [0, 1, 2] as const) {
        const quad = faceAlong(axis, faceNear(axis))
        rasterQuad(quad[0], quad[1], quad[2], quad[3])
      }
    },

        writeView(view: RecordView, i: number): void {
      this.writeBox(view.cx(i), view.cy(i), view.cz(i), view.hx(i), view.hy(i), view.hz(i))
    },
    reduce(): void {
      reduced = true
      for (let L = 1; L < mips.length; L++) {
        const src = mips[L - 1]
        const dst = mips[L]
        const wi = dims[L - 1], wo = dims[L]
        for (let t = 0; t < wo.w * wo.h; t++) {
          const x = t % wo.w, y = (t / wo.w) | 0
          const x0 = Math.min(x * 2, wi.w - 1), x1 = Math.min(x * 2 + 1, wi.w - 1)
          const y0 = Math.min(y * 2, wi.h - 1), y1 = Math.min(y * 2 + 1, wi.h - 1)
          const a = src[y0 * wi.w + x0], b = src[y0 * wi.w + x1]
          const c = src[y1 * wi.w + x0], d = src[y1 * wi.w + x1]
          dst[t] = Math.max(a, b, c, d)
        }
      }
    },
    hidden(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): boolean {
      if (mvp === null) throw new Error('rune/core: softwareOccluder.hidden — begin(mvp) first')
      if (!reduced) throw new Error('rune/core: softwareOccluder.hidden — reduce() first (the mips are the test)')
      const p = projectBox(mvp, cx, cy, cz, hx, hy, hz, proj, width, height, zMap)
      if (p[6] < 1) return false      // fully behind the eye — not our call
      if (p[5] <= 1e-4) return false  // a straddler — keep it (the kernel's own class)
      let x0 = Math.max(0, Math.floor(p[0]))
      let x1 = Math.min(width, Math.ceil(p[1]))
      let y0 = Math.max(0, Math.floor(p[2]))
      let y1 = Math.min(height, Math.ceil(p[3]))
      // the guard DOMINATES the kernel's own ±1: the fp64 rect here vs the
      // kernel's fp32 rounds a texel-boundary edge one texel either way —
      // the doubled guard swallows the flip, the sampled region ⊇ the
      // kernel's, the max only grows (the sound direction)
      x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2)
      x1 = Math.min(width, x1 + 2); y1 = Math.min(height, y1 + 2)
      if (x1 <= x0 || y1 <= y0) return false
      const L = mipOf(Math.max(x1 - x0, y1 - y0))
      const lw = dims[L].w, lh = dims[L].h
      const mip = mips[L]
      const tx0 = x0 >> L, tx1 = Math.min((x1 - 1) >> L, lw - 1)
      const ty0 = y0 >> L, ty1 = Math.min((y1 - 1) >> L, lh - 1)
      let zmax = -Infinity
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const z = mip[ty * lw + tx]
          if (z > zmax) zmax = z
        }
      }
      // the occludee's NEAREST corner vs the region's FARTHEST front plane
      // (the same 1e-5 slack the GPU kernels carry — borderline stays drawn)
      return p[4] > zmax + 1e-5
    },
    hiddenView(view: RecordView, i: number): boolean {
      return this.hidden(view.cx(i), view.cy(i), view.cz(i), view.hx(i), view.hy(i), view.hz(i))
    },
  }
}

// ─── the ray helpers (the kit's picking surface) ─────────────────────────

/** The world ray through a NDC point (nx, ny ∈ [−1, 1]) of a camera given
 *  by its basis (fwd, right, up — the lookAt columns) and fovY/aspect.
 *  The classic primary-ray unprojection — no matrix inversion: the frustum
 *  rays ARE the basis scaled by tan(fovY/2) and the aspect. */
export function cameraRay(
  eye: readonly number[],
  fwd: readonly number[],
  right: readonly number[],
  up: readonly number[],
  fovY: number, aspect: number,
  nx: number, ny: number,
): { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number } {
  const tf = Math.tan(fovY / 2)
  let dx = fwd[0] + right[0] * nx * aspect * tf + up[0] * ny * tf
  let dy = fwd[1] + right[1] * nx * aspect * tf + up[1] * ny * tf
  let dz = fwd[2] + right[2] * nx * aspect * tf + up[2] * ny * tf
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
  dx /= l; dy /= l; dz /= l
  return { ox: eye[0], oy: eye[1], oz: eye[2], dx, dy, dz }
}

/** The brute-force ray sweep (the gates' reference and the small-scene
 *  path): every record the ray touches, sorted by entry t. */
export function rayBoxes(
  view: RecordView,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): { id: number; t: number }[] {
  const ix = dx !== 0 ? 1 / dx : Infinity
  const iy = dy !== 0 ? 1 / dy : Infinity
  const iz = dz !== 0 ? 1 / dz : Infinity
  const hits: { id: number; t: number }[] = []
  for (let i = 0; i < view.count; i++) {
    const bx0 = view.cx(i) - view.hx(i), bx1 = view.cx(i) + view.hx(i)
    const by0 = view.cy(i) - view.hy(i), by1 = view.cy(i) + view.hy(i)
    const bz0 = view.cz(i) - view.hz(i), bz1 = view.cz(i) + view.hz(i)
    let t0 = 0, t1 = Infinity, miss = false
    // x
    if (ix === Infinity || ix === -Infinity) {
      if (ox < bx0 || ox > bx1) miss = true
    } else {
      let ta = (bx0 - ox) * ix, tb = (bx1 - ox) * ix
      if (ta > tb) { const s = ta; ta = tb; tb = s }
      if (ta > t0) t0 = ta
      if (tb < t1) t1 = tb
      if (t0 > t1) miss = true
    }
    // y
    if (!miss) {
      if (iy === Infinity || iy === -Infinity) {
        if (oy < by0 || oy > by1) miss = true
      } else {
        let ta = (by0 - oy) * iy, tb = (by1 - oy) * iy
        if (ta > tb) { const s = ta; ta = tb; tb = s }
        if (ta > t0) t0 = ta
        if (tb < t1) t1 = tb
        if (t0 > t1) miss = true
      }
    }
    // z
    if (!miss) {
      if (iz === Infinity || iz === -Infinity) {
        if (oz < bz0 || oz > bz1) miss = true
      } else {
        let ta = (bz0 - oz) * iz, tb = (bz1 - oz) * iz
        if (ta > tb) { const s = ta; ta = tb; tb = s }
        if (ta > t0) t0 = ta
        if (tb < t1) t1 = tb
        if (t0 > t1) miss = true
      }
    }
    if (!miss) hits.push({ id: i, t: t0 })
  }
  hits.sort((a, b) => a.t - b.t)
  return hits
}
