/**
 * spatial213.bench.ts — Task 213: THE KIT'S OWN SoA ROUND, measured.
 *
 * The Task-210 H-group measured the SHAPE (objects vs flat records on the
 * spatialBoxes walk: 2.5-8x); this bench measures the KIT built on it —
 * the octree/BVH over the demo's real city (createScene(16384)), through
 * the public API only, so the SAME file runs against the pre-rewrite kit
 * (the object legs; the RecordView legs skip themselves) and the SoA kit
 * (every leg). The A/B claim lands as three numbers: the old kit on
 * objects, the new kit on objects, the new kit on the records view.
 *
 *   A. BOOT — buildOctree/buildBVH from objects vs from the RecordView.
 *   B. THE QUERY BATTERY — 48 frustum cameras, 96 points, 48 spheres,
 *      48 rays, 48 raycasts per structure (the walks the frame pays).
 *   C. THE EDIT CHURN — 48 movers x 600 frames, update(box) vs the
 *      scalar updateBox, a frustum probe every 25 frames vs brute.
 *   D. THE FOLD — rebuild() + the full battery again (the lane empties).
 *   E. THE ORACLE WALK — objects vs the flat record words (the H-law on
 *      the demo's own city; the validation gate's own walk).
 *
 * Every leg is checksum-gated: the input modes must agree EXACTLY (the
 * answer arrays, the stats, the planeTests counters), and the frustum
 * survivor sets must equal the brute sweep over the same live boxes.
 */
import {
  buildOctree, buildBVH, aabbOutsideFrustum, frustumPlanes,
} from '../src/spatial.ts'
import type { SpatialBox } from '../src/spatial.ts'
// The Task-213 surface — absent on the pre-rewrite kit (the legs skip).
import * as spatial213 from '../src/spatial.ts'
import { recordView } from '../src/culling.ts'
import { createScene } from '../../../demo/occlusion/scene.js'

const HAS_RECORDS = typeof (spatial213 as { buildOctreeRecords?: unknown }).buildOctreeRecords === 'function'
const HAS_UPDATE_BOX = HAS_RECORDS

function bench(label: string, fn: () => void, iters: number): number {
  for (let i = 0; i < Math.max(3, iters >> 3); i++) fn()
  let best = Infinity
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    fn()
    const dt = performance.now() - t0
    if (dt < best) best = dt
  }
  return best
}

function fmt(ms: number): string {
  return ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(1)} µs`
}

let allOk = true
function fail(why: string): void {
  allOk = false
  console.error(`   FAIL: ${why}`)
}

// ── the corpus: the demo's own city, both input shapes ────────────────────
const scene = createScene(16384)
const N = scene.N
const objects: SpatialBox[] = []
{
  const f = scene.sceneF32
  const base = scene.INST_OFF + scene.FIELDS.center
  const hbase = scene.INST_OFF + scene.FIELDS.half
  for (let i = 0; i < N; i++) {
    objects.push({
      id: i,
      cx: f[base + i * scene.STRIDE], cy: f[base + i * scene.STRIDE + 1], cz: f[base + i * scene.STRIDE + 2],
      hx: f[hbase + i * scene.STRIDE], hy: f[hbase + i * scene.STRIDE + 1], hz: f[hbase + i * scene.STRIDE + 2],
    })
  }
}

// the deterministic RNG (the repo's xorshift canon)
function rng(seed: number) {
  let s = seed | 0
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

// ── the camera battery (the demo's own orbit shape) ───────────────────────
function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, far * near * nf, 0,
  ])
}
function mvpFor(eye: readonly number[], target: readonly number[]): Float32Array {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2]
  let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
  const rx = fy * 0 - fz * 1, ry = fz * 0 - fx * 0, rz = fx * 1 - fy * 0
  l = Math.hypot(rx, ry, rz)
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
  const view = new Float32Array([
    rx / l, ux, -fx, 0,
    ry / l, uy, -fy, 0,
    rz / l, uz, -fz, 0,
    -(rx / l * eye[0] + ry / l * eye[1] + rz / l * eye[2]),
    -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
    fx * eye[0] + fy * eye[1] + fz * eye[2],
    1,
  ])
  const p = perspective(1.1, 16 / 9, 0.5, 300)
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += p[k * 4 + r] * view[c * 4 + k]
      out[c * 4 + r] = s
    }
  }
  return out
}

const FRUSTUM_CAMS = 48
const POINTS = 96
const SPHERES = 48
const RAYS = 48
const cameras: Float32Array[] = []
const points: Array<[number, number, number]> = []
const spheres: Array<[number, number, number, number]> = []
const rays: Array<[number, number, number, number, number, number]> = []
{
  const r = rng(21301)
  for (let k = 0; k < FRUSTUM_CAMS; k++) {
    const a = (k / FRUSTUM_CAMS) * Math.PI * 2
    const eye: readonly number[] = [Math.cos(a) * 90, 18 + r() * 30, Math.sin(a) * 90]
    const tgt: readonly number[] = [(r() * 2 - 1) * 30, r() * 12, (r() * 2 - 1) * 30]
    cameras.push(mvpFor(eye, tgt))
  }
  for (let k = 0; k < POINTS; k++) points.push([(r() * 2 - 1) * 60, r() * 20, (r() * 2 - 1) * 66])
  for (let k = 0; k < SPHERES; k++) spheres.push([(r() * 2 - 1) * 60, r() * 20, (r() * 2 - 1) * 66, 2 + r() * 40])
  for (let k = 0; k < RAYS; k++) {
    const a = r() * Math.PI * 2
    rays.push([Math.cos(a) * 110, 10 + r() * 25, Math.sin(a) * 110, -Math.cos(a), -(r() * 0.6 - 0.3), -Math.sin(a)])
  }
}
const camPlanes = cameras.map(m => frustumPlanes(m))

// ── the brute references (no hierarchy, no shortcuts) ─────────────────────
function bruteSurvivors(items: readonly SpatialBox[], planes: ArrayLike<number>): Set<number> {
  const set = new Set<number>()
  for (const it of items) {
    if (!aabbOutsideFrustum(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz)) set.add(it.id)
  }
  return set
}

/** The full query battery against one index; returns a checksum string. */
function runBattery(idx: { queryFrustum(p: ArrayLike<number>): Uint32Array; queryPoint(x: number, y: number, z: number): Uint32Array; querySphere(x: number, y: number, z: number, r: number): Uint32Array; queryRay(...a: number[]): { id: number; t: number }[]; raycast(...a: number[]): { id: number; t: number } | null; stats: { nodes: number; leaves: number; depth: number; lane: number }; readonly planeTests: number }): { checksum: number; labels: string[] } {
  let checksum = 0x9e3779b9
  const labels: string[] = []
  const mix = (v: number): void => { checksum = (checksum ^ (v | 0)) * 0x85ebca6b | 0 }
  for (let k = 0; k < FRUSTUM_CAMS; k++) {
    const ids = idx.queryFrustum(camPlanes[k]!)
    mix(ids.length); for (let i = 0; i < ids.length; i++) mix(ids[i]!)
  }
  labels.push(`frustum`)
  for (let k = 0; k < POINTS; k++) {
    const p = points[k]!
    const ids = idx.queryPoint(p[0], p[1], p[2])
    mix(ids.length + 1); for (let i = 0; i < ids.length; i++) mix(ids[i]!)
  }
  labels.push(`point`)
  for (let k = 0; k < SPHERES; k++) {
    const s = spheres[k]!
    const ids = idx.querySphere(s[0], s[1], s[2], s[3])
    mix(ids.length + 2); for (let i = 0; i < ids.length; i++) mix(ids[i]!)
  }
  labels.push(`sphere`)
  for (let k = 0; k < RAYS; k++) {
    const rr = rays[k]!
    const hits = idx.queryRay(rr[0], rr[1], rr[2], rr[3], rr[4], rr[5])
    mix(hits.length + 3)
    for (let i = 0; i < hits.length; i++) { mix(hits[i]!.id); mix((hits[i]!.t * 1024) | 0) }
  }
  labels.push(`ray`)
  for (let k = 0; k < RAYS; k++) {
    const rr = rays[k]!
    const hit = idx.raycast(rr[0], rr[1], rr[2], rr[3], rr[4], rr[5])
    if (hit !== null) { mix(hit.id + 4); mix((hit.t * 1024) | 0) } else mix(4)
  }
  labels.push(`raycast`)
  mix(idx.stats.nodes); mix(idx.stats.leaves); mix(idx.stats.depth)
  return { checksum, labels }
}

// ── A. BOOT ────────────────────────────────────────────────────────────────
const bootNote = HAS_RECORDS ? ' — objects vs RecordView' : ' — objects (the old kit; the records legs need Task 213)'
console.log(`A. BOOT (the demo city, N=${N})${bootNote}`)
let octObj: ReturnType<typeof buildOctree>, bvhObj: ReturnType<typeof buildBVH>
{
  const tOctObj = bench('oct-objects', () => { octObj = buildOctree(objects) }, 6)
  const tBvhObj = bench('bvh-objects', () => { bvhObj = buildBVH(objects) }, 6)
  console.log(`   octree objects: ${fmt(tOctObj)}   bvh objects: ${fmt(tBvhObj)}`)
}
let octRec: ReturnType<typeof buildOctree> | null = null
let bvhRec: ReturnType<typeof buildBVH> | null = null
if (HAS_RECORDS) {
  // the kit's own front door: the RecordView over the scene's records
  const rv = recordView(scene.sceneF32, scene.INST_OFF, scene.N, scene.STRIDE, scene.FIELDS)
  const buildOctRec = (spatial213 as { buildOctreeRecords: (v: typeof rv) => ReturnType<typeof buildOctree> }).buildOctreeRecords
  const buildBvhRec = (spatial213 as { buildBVHRecords: (v: typeof rv) => ReturnType<typeof buildBVH> }).buildBVHRecords
  const tOctRec = bench('oct-records', () => { octRec = buildOctRec(rv) }, 6)
  const tBvhRec = bench('bvh-records', () => { bvhRec = buildBvhRec(rv) }, 6)
  console.log(`   octree records: ${fmt(tOctRec)}   bvh records: ${fmt(tBvhRec)}`)
  // gate: the trees built from the two input shapes must agree COMPLETELY
  if (octRec!.stats.nodes !== octObj.stats.nodes || octRec!.stats.leaves !== octObj.stats.leaves
    || octRec!.stats.depth !== octObj.stats.depth || bvhRec!.stats.nodes !== bvhObj.stats.nodes) {
    fail(`records-built stats differ (${octRec!.stats.nodes}/${octObj.stats.nodes} oct nodes, ${bvhRec!.stats.nodes}/${bvhObj.stats.nodes} bvh nodes)`)
  } else {
    console.log(`   stats gate: oct ${octObj.stats.nodes} nodes / ${octObj.stats.leaves} leaves / depth ${octObj.stats.depth}, bvh ${bvhObj.stats.nodes} nodes — IDENTICAL across input modes`)
  }
}

// ── B. THE QUERY BATTERY ──────────────────────────────────────────────────
console.log(`\nB. THE QUERY BATTERY (${FRUSTUM_CAMS} frusta + ${POINTS} points + ${SPHERES} spheres + ${RAYS} rays + ${RAYS} raycasts per structure)`)
const refOct = runBattery(octObj)
const refBvh = runBattery(bvhObj)
{
  const t = bench('oct-objects', () => { runBattery(octObj) }, 3)
  console.log(`   octree objects: ${fmt(t)}`)
}
{
  const t = bench('bvh-objects', () => { runBattery(bvhObj) }, 3)
  console.log(`   bvh objects:    ${fmt(t)}`)
}
if (octRec !== null) {
  const got = runBattery(octRec)
  const t = bench('oct-records', () => { runBattery(octRec!) }, 3)
  if (got.checksum !== refOct.checksum) fail(`octree records battery checksum differs (${got.checksum} vs ${refOct.checksum})`)
  console.log(`   octree records: ${fmt(t)}${got.checksum === refOct.checksum ? '  [checksum IDENTICAL to objects]' : '  [CHECKSUM DIFFERS]'}`)
}
if (bvhRec !== null) {
  const got = runBattery(bvhRec)
  const t = bench('bvh-records', () => { runBattery(bvhRec!) }, 3)
  if (got.checksum !== refBvh.checksum) fail(`bvh records battery checksum differs (${got.checksum} vs ${refBvh.checksum})`)
  console.log(`   bvh records:    ${fmt(t)}${got.checksum === refBvh.checksum ? '  [checksum IDENTICAL to objects]' : '  [CHECKSUM DIFFERS]'}`)
}
// the frustum truth gate: the OBJECT-built octree's survivor sets vs brute
{
  let ok = true
  for (let k = 0; k < FRUSTUM_CAMS && ok; k++) {
    const want = bruteSurvivors(objects, camPlanes[k]!)
    const got = new Set(Array.from(octObj.queryFrustum(camPlanes[k]!)))
    if (want.size !== got.size) { ok = false; break }
    for (const id of got) if (!want.has(id)) { ok = false; break }
  }
  if (!ok) fail('the frustum survivor sets diverge from the brute sweep')
  else console.log(`   frustum truth gate: octree ≡ brute on all ${FRUSTUM_CAMS} cameras`)
}

// ── C. THE EDIT CHURN (the drone cadence) ────────────────────────────────
const MOVERS = 48
const FRAMES = 600
const moverIds: number[] = []
{
  const r = rng(21302)
  for (let d = 0; d < MOVERS; d++) moverIds.push(Math.floor(r() * N))
}
function moverGeometry(frame: number, d: number): [number, number, number, number, number, number] {
  const it = objects[moverIds[d]!]!
  const ph = frame * 0.05 + d
  return [
    it.cx + Math.sin(ph) * 8, it.cy + Math.cos(ph * 0.7) * 4, it.cz + Math.sin(ph * 1.3) * 10,
    it.hx, it.hy, it.hz,
  ]
}
// the live-set model the brute probes read (the freshest geometry)
function liveBox(frame: number, id: number): SpatialBox | null {
  for (let d = 0; d < MOVERS; d++) {
    if (moverIds[d] === id) {
      const g = moverGeometry(frame, d)
      return { id, cx: g[0], cy: g[1], cz: g[2], hx: g[3], hy: g[4], hz: g[5] }
    }
  }
  return objects[id] ?? null
}
console.log(`\nC. THE EDIT CHURN (${MOVERS} movers x ${FRAMES} frames, a frustum probe every 25)`)
{
  // the object lane (both old and new kit)
  let tMs = bench('churn-objects', () => {
    for (let f = 0; f < FRAMES; f++) {
      for (let d = 0; d < MOVERS; d++) {
        const g = moverGeometry(f, d)
        octObj.update({ id: moverIds[d]!, cx: g[0], cy: g[1], cz: g[2], hx: g[3], hy: g[4], hz: g[5] })
        bvhObj.update({ id: moverIds[d]!, cx: g[0], cy: g[1], cz: g[2], hx: g[3], hy: g[4], hz: g[5] })
      }
    }
  }, 2)
  console.log(`   update(box) objects:  ${fmt(tMs)} (${MOVERS * FRAMES * 2} updates)`)
  // the truth probe: at the LAST frame's geometry, both trees ≡ brute-live
  const live: SpatialBox[] = objects.map(o => ({ ...o }))
  for (let d = 0; d < MOVERS; d++) {
    const g = moverGeometry(FRAMES - 1, d)
    const b = live[moverIds[d]!]!
    b.cx = g[0]; b.cy = g[1]; b.cz = g[2]
  }
  let ok = true
  for (let k = 0; k < 8 && ok; k++) {
    const planes = camPlanes[k * 6 % FRUSTUM_CAMS]!
    const want = bruteSurvivors(live, planes)
    for (const idx of [octObj, bvhObj]) {
      const got = new Set(Array.from(idx.queryFrustum(planes)))
      if (want.size !== got.size) { ok = false; break }
      for (const id of got) if (!want.has(id)) { ok = false; break }
    }
  }
  if (!ok) fail('the churn truth probe diverged from the brute-live sweep')
  else console.log(`   churn truth gate: octree ≡ bvh ≡ brute-live after ${MOVERS * FRAMES} updates (lane ${octObj.stats.lane}/${bvhObj.stats.lane})`)
}
if (HAS_UPDATE_BOX && octRec !== null && bvhRec !== null) {
  const updBoxOct = (octRec as unknown as { updateBox: (id: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) => void }).updateBox
  const updBoxBvh = (bvhRec as unknown as { updateBox: (id: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) => void }).updateBox
  const t = bench('churn-scalars', () => {
    for (let f = 0; f < FRAMES; f++) {
      for (let d = 0; d < MOVERS; d++) {
        const g = moverGeometry(f, d)
        updBoxOct(moverIds[d]!, g[0], g[1], g[2], g[3], g[4], g[5])
        updBoxBvh(moverIds[d]!, g[0], g[1], g[2], g[3], g[4], g[5])
      }
    }
  }, 2)
  console.log(`   updateBox scalars:   ${fmt(t)} (${MOVERS * FRAMES * 2} updates, zero objects)`)
  // the scalar-lane parity gate — SET-based (the honest contract for a
  // churned structure: the movers answer from the LANE after the tree,
  // so the ORDER differs from a fresh build by construction; the SETS,
  // the ray (id,t) pairs and the raycast verdicts must not)
  {
    const live: SpatialBox[] = objects.map(o => ({ ...o }))
    for (let d = 0; d < MOVERS; d++) {
      const g = moverGeometry(FRAMES - 1, d)
      const b = live[moverIds[d]!]!
      b.cx = g[0]; b.cy = g[1]; b.cz = g[2]
    }
    const octLive = buildOctree(live)
    const bvhLive = buildBVH(live)
    let ok = true
    const sorted = (u: Uint32Array): string => Array.from(u).sort((a, b) => a - b).join(',')
    for (let k = 0; k < 8 && ok; k++) {
      const planes = camPlanes[k * 6 % FRUSTUM_CAMS]!
      const p = points[k * 12 % POINTS]!
      const s = spheres[k * 6 % SPHERES]!
      const rr = rays[k * 6 % RAYS]!
      const want = [octLive.queryFrustum(planes), octLive.queryPoint(p[0], p[1], p[2]), octLive.querySphere(s[0], s[1], s[2], s[3])]
      const got = [octRec!.queryFrustum(planes), octRec!.queryPoint(p[0], p[1], p[2]), octRec!.querySphere(s[0], s[1], s[2], s[3])]
      for (let q = 0; q < 3; q++) if (sorted(want[q]!) !== sorted(got[q]!)) { ok = false; break }
      if (!ok) break
      const wl = octLive.queryRay(rr[0], rr[1], rr[2], rr[3], rr[4], rr[5])
      const gl = octRec!.queryRay(rr[0], rr[1], rr[2], rr[3], rr[4], rr[5])
      if (wl.length !== gl.length) { ok = false; break }
      for (let i = 0; i < wl.length; i++) if (wl[i]!.id !== gl[i]!.id || wl[i]!.t !== gl[i]!.t) { ok = false; break }
      if (!ok) break
      const wf = octLive.raycast(rr[0], rr[1], rr[2], rr[3], rr[4], rr[5])
      const gf = octRec!.raycast(rr[0], rr[1], rr[2], rr[3], rr[4], rr[5])
      if ((wf === null) !== (gf === null)) { ok = false; break }
      if (wf !== null && gf !== null && (wf.id !== gf.id || wf.t !== gf.t)) { ok = false; break }
      // the BVH twin
      const wantB = [bvhLive.queryFrustum(planes), bvhLive.queryPoint(p[0], p[1], p[2]), bvhLive.querySphere(s[0], s[1], s[2], s[3])]
      const gotB = [bvhRec!.queryFrustum(planes), bvhRec!.queryPoint(p[0], p[1], p[2]), bvhRec!.querySphere(s[0], s[1], s[2], s[3])]
      for (let q = 0; q < 3; q++) if (sorted(wantB[q]!) !== sorted(gotB[q]!)) { ok = false; break }
      if (!ok) break
      const wb = bvhLive.raycast(rr[0], rr[1], rr[2], rr[3], rr[4], rr[5])
      const gb = bvhRec!.raycast(rr[0], rr[1], rr[2], rr[3], rr[4], rr[5])
      if ((wb === null) !== (gb === null)) { ok = false; break }
      if (wb !== null && gb !== null && (wb.id !== gb.id || wb.t !== gb.t)) { ok = false; break }
    }
    if (!ok) fail('the scalar-lane answers diverged from a fresh object build over the same live geometry')
    else console.log(`   scalar-lane parity: oct/bvh answers ≡ fresh object builds over the same live geometry (sets + rays + raycasts)`)
  }
}

// ── D. THE FOLD ───────────────────────────────────────────────────────────
console.log(`\nD. THE FOLD (rebuild over the live set)`)
{
  const tOct = bench('fold-oct', () => { octObj.rebuild?.() }, 6)
  const tBvh = bench('fold-bvh', () => { bvhObj.rebuild?.() }, 6)
  console.log(`   octree fold: ${fmt(tOct)}   bvh fold: ${fmt(tBvh)}   (lanes now ${octObj.stats.lane}/${bvhObj.stats.lane})`)
  const live: SpatialBox[] = []
  const seen = new Set<number>()
  for (let d = 0; d < MOVERS; d++) seen.add(moverIds[d]!)
  for (let i = 0; i < N; i++) {
    if (!seen.has(i)) { live.push(objects[i]!); continue }
    const g = moverGeometry(FRAMES - 1, moverIds.indexOf(i))
    live.push({ id: i, cx: g[0], cy: g[1], cz: g[2], hx: g[3], hy: g[4], hz: g[5] })
  }
  let ok = true
  for (let k = 0; k < 8 && ok; k++) {
    const planes = camPlanes[k * 6 % FRUSTUM_CAMS]!
    const want = bruteSurvivors(live, planes)
    for (const idx of [octObj, bvhObj]) {
      const got = new Set(Array.from(idx.queryFrustum(planes)))
      if (want.size !== got.size) { ok = false; break }
      for (const id of got) if (!want.has(id)) { ok = false; break }
    }
  }
  if (!ok) fail('the fold truth probe diverged')
  else console.log(`   fold truth gate: octree ≡ bvh ≡ brute-live after the fold`)
}

// ── E. THE ORACLE WALK (the H-law on the demo's own city) ────────────────
console.log(`\nE. THE ORACLE WALK (${N} records, the validation gate's own sweep)`)
{
  let csObj = 0
  const tObj = bench('oracle-objects', () => {
    csObj = 0
    for (const b of objects) csObj += b.cx + b.cy + b.cz + b.hx + b.hy + b.hz
  }, 40)
  const f = scene.sceneF32
  const cbase = scene.INST_OFF + scene.FIELDS.center
  const hbase = scene.INST_OFF + scene.FIELDS.half
  const stride = scene.STRIDE
  let csFlat = 0
  const tFlat = bench('oracle-flat', () => {
    csFlat = 0
    for (let i = 0; i < N; i++) {
      const co = cbase + i * stride, ho = hbase + i * stride
      csFlat += f[co]! + f[co + 1]! + f[co + 2]! + f[ho]! + f[ho + 1]! + f[ho + 2]!
    }
  }, 40)
  if (csObj !== csFlat) fail(`the oracle checksums differ (${csObj} vs ${csFlat})`)
  console.log(`   objects: ${fmt(tObj)}   flat record words: ${fmt(tFlat)} → ${(tObj / tFlat).toFixed(2)}x${csObj === csFlat ? '  [checksums equal]' : '  [CHECKSUMS DIFFER]'}`)
}

console.log(`\n${allOk ? 'VERDICT: PASS — every lane measured, every gate held' : 'VERDICT: FAIL — a gate broke'}`)
if (!allOk) process.exit(1)
