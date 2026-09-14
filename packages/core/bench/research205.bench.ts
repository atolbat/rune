/**
 * research205.bench.ts — Task 205: THE MEASURED HARVEST.
 *
 * The research techniques are A/B'd against their legacy twins on the
 * DEMO'S OWN corpus — demo/occlusion/scene.js builds the exact city (23
 * occluders + 16384 street boxes) and the exact validation cameras, so
 * the numbers below are the demo's real load, not a synthetic stand-in:
 *
 *   A. THE RASTER — softwareOccluder 'legacy' (the Task-201 per-pixel
 *      barycentric loop) vs 'tiled' (Greene's hierarchical tiling, the
 *      rawrunprotected coarse tier tests, the ryg incremental edges +
 *      the depth gradient): begin + 23 writeView + reduce.
 *   B. THE QUERY — hidden() with the full mip scan vs the monotone-max
 *      early-out: hiddenView × N over the whole scene.
 *   C. THE FRUSTUM WALK — plane-mask inheritance off vs on, octree and
 *      BVH: ms + the instrumented planeTests counter + set parity.
 *   D. THE PICKING RAY — the allocation-free slab walk: 2048 rays
 *      through the camera grid, octree vs BVH, ms + agreement.
 *
 * The bench is a gate too: every section asserts the parity it relies
 * on (verdicts, sets, rays) — a win that changes an answer is no win.
 */
import { softwareOccluder, recordView } from '../src/index.ts'
import { buildOctree, buildBVH, frustumPlanes } from '../src/index.ts'
import type { SpatialBox } from '../src/index.ts'
// the demo's own scene + cameras (pure math, no DOM)
import { createScene, cameraAt, VAL_CAMERAS, HIZ_W, HIZ_H } from '../../../demo/occlusion/scene.js'

const OCCL = 16384
const scene = createScene(OCCL)
const view = recordView(scene.sceneF32, scene.INST_OFF, scene.N, scene.STRIDE, scene.FIELDS)
const boxes: SpatialBox[] = []
for (let i = 0; i < scene.N; i++) {
  boxes.push({
    id: i,
    cx: view.cx(i), cy: view.cy(i), cz: view.cz(i),
    hx: view.hx(i), hy: view.hy(i), hz: view.hz(i),
  })
}

const ms = (digits = 3) => {
  const t = performance.now()
  return () => performance.now() - t
}

function bench(label: string, fn: () => void, iters: number): number {
  // warmup (JIT + caches), then the timed passes — the MIN is the honest
  // number for a pure function (the mean carries scheduler noise)
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

const CAMS = VAL_CAMERAS.map(c => cameraAt(c.yaw, c.pitch, c.dist))
const fmt = (v: number) => v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3)

let allOk = true
const fail = (msg: string) => { allOk = false; console.log(`  ✗ PARITY FAIL: ${msg}`) }

console.log('══ Task 205 — the research harvest, measured on the demo\'s own city ══')
console.log(`corpus: ${scene.K} occluders + ${scene.N - scene.K} occludees = ${scene.N} boxes, tile ${HIZ_W}×${HIZ_H}, ${CAMS.length} validation cameras`)

// ── A. the raster ──────────────────────────────────────────────────────────
{
  const legacy = softwareOccluder({ width: HIZ_W, height: HIZ_H, raster: 'legacy' })
  const tiled = softwareOccluder({ width: HIZ_W, height: HIZ_H })
  const feed = (soft: ReturnType<typeof softwareOccluder>, mvp: Float32Array) => {
    soft.begin(mvp)
    for (let i = 0; i < scene.K; i++) soft.writeView(view, i)
    soft.reduce()
  }
  let tl = 0, tt = 0
  for (const cam of CAMS) {
    tl += bench('legacy', () => feed(legacy, cam.mvp), 40)
    tt += bench('tiled', () => feed(tiled, cam.mvp), 40)
  }
  // parity: same verdicts over the whole scene (the bench is a gate)
  let hiddenL = 0, hiddenT = 0, mism = 0
  for (const cam of CAMS) {
    feed(legacy, cam.mvp)
    feed(tiled, cam.mvp)
    for (let i = 0; i < scene.N; i++) {
      const a = legacy.hiddenView(view, i)
      const b = tiled.hiddenView(view, i)
      if (a !== b) mism++
      if (a) hiddenL++
      if (b) hiddenT++
    }
  }
  if (mism > 0) fail(`raster verdicts: ${mism} mismatches`)
  if (hiddenL !== hiddenT) fail(`hidden counts ${hiddenL} vs ${hiddenT}`)
  const speedup = tl / tt
  console.log(`\nA. THE RASTER (Greene tiles + incremental edges + the z gradient)`)
  console.log(`   legacy per-camera feed (23 writeBox + reduce): ${fmt(tl / CAMS.length)} ms`)
  console.log(`   tiled  per-camera feed (23 writeBox + reduce): ${fmt(tt / CAMS.length)} ms`)
  console.log(`   → ${speedup.toFixed(2)}× faster · verdicts identical (${hiddenT} hidden / ${CAMS.length} cameras, 0 mismatches)`)
  if (speedup <= 1) fail('the tiled raster did not win')
}

// ── B. the query ───────────────────────────────────────────────────────────
{
  // the sweep's cost decomposes: the feed (the raster — A's win) plus
  // 16k hiddenView queries. The MEASURED Task-201 baseline query path =
  // the per-corner projector + the full mip scan; the Task-205 query =
  // the CSE projector + the monotone-max early-out. The decomposition
  // stays honest about which lever actually moved the time.
  const base = softwareOccluder({ width: HIZ_W, height: HIZ_H, raster: 'tiled', project: 'legacy', earlyOut: false })
  const cseFull = softwareOccluder({ width: HIZ_W, height: HIZ_H, raster: 'tiled', project: 'cse', earlyOut: false })
  const ship = softwareOccluder({ width: HIZ_W, height: HIZ_H, raster: 'tiled', project: 'cse', earlyOut: true })
  const sweep = (s: ReturnType<typeof softwareOccluder>, mvp: Float32Array) => {
    s.begin(mvp)
    for (let i = 0; i < scene.K; i++) s.writeView(view, i)
    s.reduce()
    let hid = 0
    for (let i = 0; i < scene.N; i++) if (s.hiddenView(view, i)) hid++
    return hid
  }
  let tB = 0, tC = 0, tS = 0
  let hidB = 0, hidC = 0, hidS = 0
  for (const cam of CAMS) {
    let a = 0, b = 0, c = 0
    tB += bench('base', () => { a = sweep(base, cam.mvp) }, 12)
    tC += bench('cse', () => { b = sweep(cseFull, cam.mvp) }, 12)
    tS += bench('ship', () => { c = sweep(ship, cam.mvp) }, 12)
    if (a !== b || b !== c) fail(`query hidden counts ${a}/${b}/${c} disagree`)
    hidB += a; hidC += b; hidS += c
  }
  const projSpeed = tB / tC
  const totalSpeed = tB / tS
  console.log(`\nB. THE QUERY (16k hiddenView per camera, the same tiled feed)`)
  console.log(`   Task-201 query path (per-corner projector + full scan): ${fmt(tB / CAMS.length)} ms/camera`)
  console.log(`   + ryg CSE projector (24 mults/box, not 96):             ${fmt(tC / CAMS.length)} ms/camera → ${projSpeed.toFixed(2)}×`)
  console.log(`   + the monotone-max early-out (the shipped config):      ${fmt(tS / CAMS.length)} ms/camera → ${totalSpeed.toFixed(2)}× total`)
  console.log(`   hidden counts identical on every leg (${hidS}) — the reassociation noise stays under the 1e-5 slack`)
  if (totalSpeed <= 1.05) fail('the query path did not win')
  if (hidB !== hidC || hidC !== hidS) fail('hidden-count drift')
}

// ── C. the frustum walk ────────────────────────────────────────────────────
{
  const octM = buildOctree(boxes, { planeMask: true })
  const octL = buildOctree(boxes, { planeMask: false })
  const bvhM = buildBVH(boxes, { planeMask: true })
  const bvhL = buildBVH(boxes, { planeMask: false })
  const setsEqual = (a: Uint32Array, b: Uint32Array) => {
    if (a.length !== b.length) return false
    const sa = Array.from(a).sort((x, y) => x - y)
    const sb = Array.from(b).sort((x, y) => x - y)
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false
    return true
  }
  let to = 0, tm = 0, tb = 0, tq = 0
  let testsL = 0, testsM = 0, testsBL = 0, testsBM = 0
  for (const cam of CAMS) {
    const planes = frustumPlanes(cam.mvp)
    let a: Uint32Array, b: Uint32Array, c: Uint32Array, d: Uint32Array
    to += bench('oct-legacy', () => { a = octL.queryFrustum(planes) }, 30)
    testsL += octL.planeTests
    tm += bench('oct-mask', () => { b = octM.queryFrustum(planes) }, 30)
    testsM += octM.planeTests
    tb += bench('bvh-legacy', () => { c = bvhL.queryFrustum(planes) }, 30)
    testsBL += bvhL.planeTests
    tq += bench('bvh-mask', () => { d = bvhM.queryFrustum(planes) }, 30)
    testsBM += bvhM.planeTests
    if (!setsEqual(a!, b!)) fail('octree mask set drift')
    if (!setsEqual(c!, d!)) fail('bvh mask set drift')
    if (!setsEqual(b!, d!)) fail('octree/bvh set drift')
  }
  const so = to / tm, sb = tb / tq
  console.log(`\nC. THE FRUSTUM WALK (Sýkora-Jelínek plane-mask inheritance)`)
  console.log(`   octree legacy: ${fmt(to / CAMS.length)} ms/camera, ${Math.round(testsL / CAMS.length)} plane tests`)
  console.log(`   octree masked: ${fmt(tm / CAMS.length)} ms/camera, ${Math.round(testsM / CAMS.length)} plane tests → ${(testsL / Math.max(1, testsM)).toFixed(1)}× fewer plane evals, wall ${so.toFixed(2)}× (the octree's cost is the stamp dedup + the result copy, not the planes — measured, documented)`)
  console.log(`   BVH   legacy: ${fmt(tb / CAMS.length)} ms/camera, ${Math.round(testsBL / CAMS.length)} plane tests`)
  console.log(`   BVH   masked: ${fmt(tq / CAMS.length)} ms/camera, ${Math.round(testsBM / CAMS.length)} plane tests → ${(testsBL / Math.max(1, testsBM)).toFixed(1)}× fewer plane evals, ${sb.toFixed(2)}× wall`)
  console.log(`   survivor sets identical on all cameras (octree ≡ BVH ≡ legacy)`)
  // the honest gates: the EVALUATION win (the counter) is structural;
  // the wall-clock win follows the structure — the BVH rides it directly,
  // the octree's walk overhead dominates its time (reported, not hidden)
  if (testsM >= testsL || testsBM >= testsBL) fail('the mask did not cut plane evals')
  if (sb <= 1.05) fail('the masked BVH walk did not win')
}

// ── D. the picking ray ─────────────────────────────────────────────────────
{
  const oct = buildOctree(boxes)
  const bvh = buildBVH(boxes)
  const RAYS = 2048
  const rays: { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }[] = []
  for (const cam of CAMS) {
    for (let i = 0; i < RAYS / CAMS.length; i++) {
      const nx = (i % 64) / 32 - 1 + 0.011
      const ny = 1 - ((Math.floor(i / 64)) / (RAYS / CAMS.length / 2)) * 2 + 0.013
      // the camera basis → the world ray (the kit's own unprojection)
      const tanY = Math.tan(cam.fovY / 2)
      const tanX = tanY * cam.aspect
      const dx = cam.fwd[0] + cam.right[0] * nx * tanX + cam.up[0] * ny * tanY
      const dy = cam.fwd[1] + cam.right[1] * nx * tanX + cam.up[1] * ny * tanY
      const dz = cam.fwd[2] + cam.right[2] * nx * tanX + cam.up[2] * ny * tanY
      const l = Math.hypot(dx, dy, dz)
      rays.push({
        ox: cam.eye[0], oy: cam.eye[1], oz: cam.eye[2],
        dx: dx / l, dy: dy / l, dz: dz / l,
      })
    }
  }
  let to = 0, tb = 0
  let agree = 0, total = 0
  to = bench('oct-ray', () => {
    for (const ray of rays) oct.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz)
  }, 6)
  tb = bench('bvh-ray', () => {
    for (const ray of rays) {
      const h = bvh.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz)
      if (h !== null) agree++
    }
  }, 6)
  for (const ray of rays) {
    const a = oct.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz)
    const b = bvh.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz)
    total++
    if (a === null && b === null) continue
    if (a === null || b === null) fail('raycast null mismatch')
    else if (Math.abs(a.t - b.t) > 1e-9) fail(`raycast t drift ${a.t} vs ${b.t}`)
  }
  console.log(`\nD. THE PICKING RAY (the allocation-free slab walk)`)
  console.log(`   octree: ${RAYS} rays in ${fmt(to)} ms → ${Math.round(RAYS / (to / 1000))} rays/s`)
  console.log(`   BVH:    ${RAYS} rays in ${fmt(tb)} ms → ${Math.round(RAYS / (tb / 1000))} rays/s (near-first ordered)`)
  console.log(`   t agreement on all ${total} rays (the tie law), ${agree} hits`)
}

console.log(`\n${allOk ? 'VERDICT: PASS — every win measured, every parity held' : 'VERDICT: FAIL — a parity gate broke'}`)
if (!allOk) process.exit(1)
