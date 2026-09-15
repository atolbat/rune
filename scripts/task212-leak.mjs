// task212-leak.mjs — THE FIELD REPORT, REPRODUCED HEADLESS
//
// The user's report: «Scene edit сразу взвинчивает мс на кадр, увеличивая
// лаги в разы. Со временем мс увеличивается.» This script reproduces the
// DEMO'S EXACT per-frame tree work (tickEdits' octree.update/bvh.update × 48
// drones + the LANE-BUDGET fold) against the real scene and the real
// indexes, and prints the growth curve: per-frame µs, node counts, the
// live count's honesty, duplicate answers, and stale-geometry answers.
//
// Run:  bun scripts/task212-leak.mjs [--frames N]
//
// BEFORE the fix this showed (measured, Task 212): the octree 55828 →
// 3.3M nodes in one second of updates, bvh.live lying +2880/s, and the
// every-180-frames fold baking the whole overflow into the layout
// forever (the fold itself growing cycle over cycle). AFTER the fix the
// same run must be flat and honest — this script is the before/after
// instrument, not a one-off.
import { buildOctree, buildBVH, frustumPlanes } from '../packages/core/src/spatial.ts'
import { createScene, cameraAt } from '../demo/occlusion/scene.js'

// octree.rebuild exists at runtime (the interface keeps it optional for
// the legacy callers); the probe uses it unconditionally after a typeof check

const args = process.argv.slice(2)
const framesArg = args.indexOf('--frames')
const FRAMES = framesArg >= 0 ? Number(args[framesArg + 1]) : 3600 // 60 s @ 60 fps
const DRONES = 48
const scene = createScene(16384)
const N = scene.N, K = scene.K

// the demo's own spatialBoxes construction (main.js:100-110)
const spatialBoxes = new Array(N)
for (let i = 0; i < N; i++) {
  const wo = scene.INST_OFF + i * 12
  spatialBoxes[i] = {
    id: i,
    cx: scene.sceneF32[wo], cy: scene.sceneF32[wo + 1], cz: scene.sceneF32[wo + 2],
    hx: scene.sceneF32[wo + 3], hy: scene.sceneF32[wo + 4], hz: scene.sceneF32[wo + 5],
  }
}
const octree = buildOctree(spatialBoxes)
const bvh = buildBVH(spatialBoxes)

// the demo's own drone anchors (main.js:129-141)
const anchors = []
for (let d = 0; d < DRONES; d++) {
  const id = K + Math.floor(((d + 0.5) / DRONES) * (N - K))
  const w = id * 12
  anchors.push({
    id,
    ax: scene.sceneF32[scene.INST_OFF + w], ay: scene.sceneF32[scene.INST_OFF + w + 1], az: scene.sceneF32[scene.INST_OFF + w + 2],
    rx: 2.5 + (d % 5) * 0.4, ry: 1.2 + (d % 3) * 0.5, rz: 2.5 + (d % 7) * 0.3,
    w1: 0.35 + (d % 4) * 0.06, w2: 0.22 + (d % 5) * 0.05, w3: 0.3 + (d % 6) * 0.04,
    p: d * 0.6180339887498949,
  })
}

const { mvp, eye, fwd, right, up, fovY } = cameraAt(0.9, 0.3, 38, 16 / 9, Math.PI / 3)
const planes = frustumPlanes(mvp)
function bruteSurvivors() {
  const s = new Set()
  for (const b of spatialBoxes) if (!outsideSix(b)) s.add(b.id)
  return s
}
function outsideSix(b) {
  const out = [0, 0, 0, 0, 0, 0]
  for (let k = 0; k < 8; k++) {
    const sx = (k & 1) * 2 - 1, sy = ((k >> 1) & 1) * 2 - 1, sz = ((k >> 2) & 1) * 2 - 1
    const x = b.cx + sx * b.hx, y = b.cy + sy * b.hy, z = b.cz + sz * b.hz
    const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]
    const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]
    const cz = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14]
    const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15]
    if (cx + cw < 0) out[0]++
    if (cx - cw > 0) out[1]++
    if (cy + cw < 0) out[2]++
    if (cy - cw > 0) out[3]++
    if (cz < 0) out[4]++
    if (cz - cw > 0) out[5]++
  }
  return out[0] === 8 || out[1] === 8 || out[2] === 8 || out[3] === 8 || out[4] === 8 || out[5] === 8
}

let lastFoldCost = 0
let folds = 0
const LANE_FOLD = 256
const marks = new Map([[60, '1s'], [300, '5s'], [900, '15s'], [1800, '30s'], [3600, '60s']])
let emaUs = 0
let maxUs = 0
const rows = []
let dupTotal = 0, staleWrong = 0

function report(f) {
  const octIds = octree.queryFrustum(planes)
  const bvhIds = bvh.queryFrustum(planes)
  const truth = bruteSurvivors()
  const octSet = new Set(Array.from(octIds))
  // duplicates: any id appearing more than once in an answer
  const octDup = octIds.length - octSet.size
  const bvhDup = bvhIds.length - new Set(Array.from(bvhIds)).size
  dupTotal += octDup + bvhDup
  // stale answers: ids the index reports that brute truth (CURRENT boxes) rejects
  let octGhost = 0
  for (const id of octSet) if (!truth.has(id)) octGhost++
  // cross-structure agreement (both indexes must answer the same set)
  const agree = octIds.length === bvhIds.length && octSet.size === new Set(Array.from(bvhIds)).size && bvhIds.every(id => octSet.has(id))
  staleWrong += octGhost
  rows.push({
    mark: marks.get(f) ?? `f${f}`,
    emaUs: +emaUs.toFixed(1), maxUs: Math.round(maxUs),
    foldMs: +lastFoldCost.toFixed(2), folds,
    octNodes: octree.stats.nodes, octLeaves: octree.stats.leaves, octDepth: octree.stats.depth,
    octLane: octree.stats.lane, bvhLane: bvh.stats.lane,
    bvhNodes: bvh.stats.nodes, bvhLive: bvh.live,
    octDup, bvhDup, octGhost, agree,
  })
}

console.log(`scene N=${N} K=${K} · drones=${DRONES} · frames=${FRAMES} (${(FRAMES / 60).toFixed(0)}s @60fps)`)
console.log(`boot: octree ${octree.stats.nodes} nodes / ${octree.stats.leaves} leaves / depth ${octree.stats.depth} · bvh ${bvh.stats.nodes} nodes · live ${octree.live}/${bvh.live}`)

for (let f = 1; f <= FRAMES; f++) {
  const t = f / 60
  const t0 = performance.now()
  // ── the demo's tickEdits tree work, verbatim shape ──
  for (let d = 0; d < DRONES; d++) {
    const a = anchors[d]
    const w = a.id * 12
    const cx = a.ax + a.rx * Math.sin(t * a.w1 + a.p)
    const cy = a.ay + a.ry * Math.sin(t * a.w2 + a.p * 2)
    const cz = a.az + a.rz * Math.cos(t * a.w3 + a.p)
    const box = { id: a.id, cx, cy, cz, hx: spatialBoxes[a.id].hx, hy: spatialBoxes[a.id].hy, hz: spatialBoxes[a.id].hz }
    octree.update(box)
    bvh.update(box)
    spatialBoxes[a.id] = box
  }
  // the demo's LANE-BUDGET fold (Task 212): the override lane's linear
  // per-query scan is the cost driver — fold when the lane outgrows the
  // budget, never on a blind cadence (48 drones ride a 48-entry lane
  // forever; the old 180-frame timer billed a ~25ms full rebuild every
  // 3s for nothing)
  if (Math.max(octree.stats.lane, bvh.stats.lane) > LANE_FOLD) {
    const r0 = performance.now()
    octree.rebuild?.()
    bvh.rebuild?.()
    lastFoldCost = performance.now() - r0
    folds++
  }
  const us = (performance.now() - t0) * 1000
  if (us > maxUs) maxUs = us
  emaUs = emaUs === 0 ? us : emaUs * 0.95 + us * 0.05
  if (marks.has(f)) report(f)
}
if (!marks.has(FRAMES)) report(FRAMES)

console.log('\nmark | tick µs EMA/max | fold ms ×n | oct nodes/leaves/depth · lane | bvh nodes · lane | bvh live | oct dup | bvh dup | ghost | agree')
for (const r of rows) {
  console.log(`${String(r.mark).padStart(5)} | ${String(r.emaUs).padStart(9)}/${String(r.maxUs).padStart(7)} | ${String(r.foldMs).padStart(5)}×${r.folds} | ${r.octNodes}/${r.octLeaves}/${r.octDepth} · ${r.octLane} | ${String(r.bvhNodes).padStart(8)} · ${r.bvhLane} | ${String(r.bvhLive).padStart(8)} | ${String(r.octDup).padStart(7)} | ${String(r.bvhDup).padStart(7)} | ${String(r.octGhost).padStart(5)} | ${r.agree ? 'YES' : 'NO'}`)
}
console.log(`\nverdict: truth live=${N} · final bvh.live=${bvh.live} (Δ${bvh.live - N}) · oct.live=${octree.live} (Δ${octree.live - N}) · total duplicate answers=${dupTotal} · total stale-ghost answers=${staleWrong}`)
console.log(`growth: oct nodes ${rows[0]?.octNodes} → ${octree.stats.nodes} (${(octree.stats.nodes / (rows[0]?.octNodes || 1)).toFixed(2)}×) · tick ${rows[0]?.emaUs}µs → ${emaUs.toFixed(1)}µs (${(emaUs / (rows[0]?.emaUs || 1)).toFixed(2)}×) · folds fired=${folds}`)

// ── THE EXPLICIT FOLD PROBE: fold both structures NOW (past the budget
// traffic) — the answers must be IDENTICAL sets, the lanes must empty,
// and the next update must re-arm the lane cleanly ──
const nodesBeforeProbe = octree.stats.nodes   // the fold re-splits at the drones' CURRENT positions — a different node count is EXPECTED
const beforeOct = new Set(Array.from(octree.queryFrustum(planes)))
const beforeBvh = new Set(Array.from(bvh.queryFrustum(planes)))
octree.rebuild?.()
bvh.rebuild?.()
const afterOct = octree.queryFrustum(planes)
const afterBvh = bvh.queryFrustum(planes)
const foldSame = afterOct.length === beforeOct.size && afterOct.every(id => beforeOct.has(id))
  && afterBvh.length === beforeBvh.size && afterBvh.every(id => beforeBvh.has(id))
const laneEmpty = octree.stats.lane === 0 && bvh.stats.lane === 0
const liveHonest = octree.live === N && bvh.live === N
// re-arm: one more update must land in the lane and answer from the NEW bounds
const a0 = anchors[0]
const moved0 = { id: a0.id, cx: a0.ax + 999, cy: a0.ay, cz: a0.az, hx: 1, hy: 1, hz: 1 }
octree.update(moved0)
bvh.update(moved0)
spatialBoxes[a0.id] = moved0
const rearmed = octree.stats.lane === 1 && bvh.stats.lane === 1
const hitMoved = octree.queryPoint(moved0.cx, moved0.cy, moved0.cz).includes(a0.id)
  && bvh.queryPoint(moved0.cx, moved0.cy, moved0.cz).includes(a0.id)
  && !octree.queryPoint(a0.ax, a0.ay, a0.az).includes(a0.id)
console.log(`fold probe: answers ${foldSame ? 'IDENTICAL' : 'CHANGED (FAIL)'} · lanes empty ${laneEmpty ? 'YES' : 'NO'} · live honest ${liveHonest ? 'YES' : 'NO'} · re-arm ${rearmed ? 'YES' : 'NO'} · moved-box point hit ${hitMoved ? 'YES (stale position rejected)' : 'NO (FAIL)'}`)
const PASS = dupTotal === 0 && staleWrong === 0 && folds === 0 && foldSame && laneEmpty && liveHonest && rearmed && hitMoved
  && nodesBeforeProbe === rows[0]?.octNodes && bvh.live === N && octree.live === N
  && emaUs / (rows[0]?.emaUs || 1) < 3
console.log(`gate: ${PASS ? 'PASS — flat, honest, zero growth, fold clean' : 'FAIL — see the rows above'}`)
if (!PASS) process.exit(1)
