/**
 * task190-memo.mjs — Task 190 probe: the frame MEMOES in production
 * (the Task-189 N3a+N5 theories, now the real culling.ts/instances.ts code).
 *
 * A/B design (the repo's honest canon): TWIN scenes built identically run the
 * SAME imported functions; twin A has the memoes KILLED (the pre-190
 * behavior), twin B has them LIVE. Every scenario asserts BIT-IDENTITY of
 * everything the frame produces (return, counts, offsets, pool bytes, bitset
 * words) before printing any timing — a memo that cannot prove parity does
 * not get to print numbers.
 *
 * Scenarios (100k nodes, ~45% visibility — the demo's band; the Task-186/188
 * fixture family):
 *   static    — 10 unchanged cull+collect frames: the memo's home turf;
 *   flipping  — 10 frames with a group's visibility toggled every other
 *               frame (updateWorld runs): the memo's miss price;
 *   drone     — 10 frames where ONE node moves: sparse animation;
 *   sweep     — 100 collects across a frame (the T0 asymptotic, now memoized
 *               per (buffer, camera) — the second sweep of the same frame).
 *
 * The pipeline rows run runScenePipeline (the worker's own frame shape) —
 * the "static scene ≈ zero CPU frame" claim, measured at the source.
 */
import {
  createScene,
  createCamera,
  cullViewsBrute,
  cullViewsHierarchical,
  collectInstancesViews,
  instancePoolBase,
  runScenePipeline,
  setCullMemo,
  setCollectMemo,
  cullMemoCounters,
  collectMemoCounters,
  writeCameraPlanes,
} from '../packages/scene/src/index.ts'

const N = 100_000
const H_CAMERA_COUNT = 4

function bitsBaseOf(views, b, cam) {
  return (b * views.cameraMax + cam) * views.bitsWords
}

function bench(name, fn, runs = 20) {
  for (let i = 0; i < 3; i++) fn() // warmup
  const times = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return { name, med: times[times.length >> 1], min: times[0] }
}

function report(rows) {
  for (const r of rows) {
    console.log(`   ${r.name.padEnd(44)} ${r.med.toFixed(3)}ms  min ${r.min.toFixed(3)}ms`)
  }
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The 100k fixture (the Task-186/188 canon): a 100×100×10 lattice,
 * 100 groups, ~45% visible under the camera, ~10% NF_VISIBLE=0. */
function buildScene(seed) {
  const rng = mulberry32(seed)
  const scene = createScene({ capacity: N, cameraMax: 1, groupMax: 100, maxInstances: N })
  for (let i = 0; i < N; i++) {
    const x = (i % 100) * 6 - 300
    const y = ((i / 100) | 0) % 100 * 6 - 300
    const z = ((i / 10000) | 0) * 8
    scene.create({ position: [x, y, z], sphere: [0, 0, 0, 2], group: i % 100 })
    if (rng() > 0.9) scene.setVisible(i, false)
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  const cam = createCamera().setPerspective(1.0, 1, 0.1, 900)
  cam.setViewLookAt(0, 0, 400, 0, 0, 0, 0, 1, 0)
  writeCameraPlanes(scene.views, 0, cam.planes)
  return scene
}

/** Full state comparison between the twins (the parity gate). */
function assertTwinParity(viewsA, viewsB, b, label) {
  const retA = viewsA.lastRet
  const retB = viewsB.lastRet
  if (retA !== retB) {
    console.log(`   ✗ parity (${label}): return ${retB} vs ${retA}`)
    process.exit(1)
  }
  const countsA = (b * viewsA.cameraMax) * viewsA.groupMax
  const countsB = (b * viewsB.cameraMax) * viewsB.groupMax
  for (let g = 0; g < 100; g++) {
    if (viewsA.instCounts[countsA + g] !== viewsB.instCounts[countsB + g]
      || viewsA.instOffsets[countsA + g] !== viewsB.instOffsets[countsB + g]) {
      console.log(`   ✗ parity (${label}) group ${g}: counts/offsets`)
      process.exit(1)
    }
  }
  const pA = instancePoolBase(viewsA, b, 0)
  const pB = instancePoolBase(viewsB, b, 0)
  for (let i = 0; i < retA * 16; i++) {
    if (viewsA.instPool[pA + i] !== viewsB.instPool[pB + i]) {
      console.log(`   ✗ parity (${label}): pool bytes at ${i}`)
      process.exit(1)
    }
  }
  const bA = bitsBaseOf(viewsA, b, 0)
  const bB = bitsBaseOf(viewsB, b, 0)
  for (let w = 0; w < viewsA.bitsWords; w++) {
    if (viewsA.bits[bA + w] !== viewsB.bits[bB + w]) {
      console.log(`   ✗ parity (${label}): bits word ${w}`)
      process.exit(1)
    }
  }
}

console.log(`\n== task190-memo: the frame memoes (N=${N.toLocaleString('en-US')}, the twin A/B canon) ==`)

// ── S1: STATIC frames — the memo's home turf ────────────────────────────────
{
  const sceneA = buildScene(1)
  const sceneB = buildScene(1)
  const vA = sceneA.views
  const vB = sceneB.views

  const frame = (scene, b) => {
    cullViewsBrute(scene.views, 0, b)
    scene.views.lastRet = collectInstancesViews(scene.views, 0, b)
  }
  // parity: 12 static frames through both twins (A killed, B live)
  setCullMemo(false); setCollectMemo(false)
  for (let f = 0; f < 12; f++) {
    frame(sceneA, f & 1)
    setCullMemo(true); setCollectMemo(true)
    frame(sceneB, f & 1)
    setCullMemo(false); setCollectMemo(false)
    assertTwinParity(vA, vB, f & 1, `static frame ${f}`)
  }
  console.log('   parity OK: 12 static frames (bits/counts/offsets/pool/return)')

  const staticFrames = (scene, memo) => {
    setCullMemo(memo); setCollectMemo(memo)
    for (let f = 0; f < 10; f++) frame(scene, f & 1)
  }
  const rows = [
    bench('10 static frames: real (no memo)', () => staticFrames(sceneA, false)),
    bench('10 static frames: +both memoes', () => staticFrames(sceneB, true)),
  ]
  report(rows)
  const c = collectMemoCounters()
  const k = cullMemoCounters()
  console.log(`   collect memo: hits=${c.hits} misses=${c.misses}; cull memo: hits=${k.hits} misses=${k.misses}`)
}

// ── S2: FLIPPING frames — the miss price ────────────────────────────────────
{
  const sceneA = buildScene(2)
  const sceneB = buildScene(2)
  const members = []
  for (let r = 0; r < N; r++) {
    const s = sceneA.views.order[r]
    if (sceneA.views.group[s] === 7) members.push(s)
  }
  const flipFrame = (scene, f) => {
    const b = f & 1
    if ((f & 2) === 0) {
      const vis = (f & 4) === 0
      for (const s of members) scene.setVisible(s, vis)
    }
    scene.updateWorld()
    cullViewsBrute(scene.views, 0, b)
    scene.views.lastRet = collectInstancesViews(scene.views, 0, b)
  }
  setCollectMemo(false); setCullMemo(false)
  for (let f = 0; f < 12; f++) {
    flipFrame(sceneA, f)
    setCullMemo(true); setCollectMemo(true)
    flipFrame(sceneB, f)
    setCullMemo(false); setCollectMemo(false)
    assertTwinParity(sceneA.views, sceneB.views, f & 1, `flip frame ${f}`)
  }
  console.log('   parity OK: 12 flipping frames (the memo never serves stale pool content)')

  const run10 = (scene, memo) => {
    setCullMemo(memo); setCollectMemo(memo)
    for (let f = 0; f < 10; f++) flipFrame(scene, f)
  }
  report([
    bench('10 flipping frames: real (no memo)', () => run10(sceneA, false)),
    bench('10 flipping frames: +both memoes', () => run10(sceneB, true)),
  ])
}

// ── S3: DRONE frames — one node moves per frame (sparse animation) ──────────
{
  const sceneA = buildScene(3)
  const sceneB = buildScene(3)
  const victimA = sceneA.views.order[0]
  const victimB = sceneB.views.order[0]
  const droneFrame = (scene, f, victim) => {
    const b = f & 1
    scene.setLocalTR(victim, (f % 10) * 3, 0, 200 + (f % 7), 0, 0, 0, 1, 1, 1, 1)
    scene.updateWorld()
    cullViewsBrute(scene.views, 0, b)
    scene.views.lastRet = collectInstancesViews(scene.views, 0, b)
  }
  setCollectMemo(false); setCullMemo(false)
  for (let f = 0; f < 12; f++) {
    droneFrame(sceneA, f, victimA)
    setCullMemo(true); setCollectMemo(true)
    droneFrame(sceneB, f, victimB)
    setCullMemo(false); setCollectMemo(false)
    assertTwinParity(sceneA.views, sceneB.views, f & 1, `drone frame ${f}`)
  }
  console.log('   parity OK: 12 drone frames (one mover — the rest memoize nothing wrong)')

  const run10 = (scene, memo, victim) => {
    setCullMemo(memo); setCollectMemo(memo)
    for (let f = 0; f < 10; f++) droneFrame(scene, f, victim)
  }
  report([
    bench('10 drone frames: real (no memo)', () => run10(sceneA, false, victimA)),
    bench('10 drone frames: +both memoes', () => run10(sceneB, true, victimB)),
  ])
}

// ── S4: the PIPELINE (the worker's frame shape) ─────────────────────────────
{
  const sceneA = buildScene(4)
  const sceneB = buildScene(4)
  sceneA.views.headerI[H_CAMERA_COUNT] = 1
  sceneB.views.headerI[H_CAMERA_COUNT] = 1
  const run4 = (scene, memo) => {
    setCullMemo(memo); setCollectMemo(memo)
    runScenePipeline(scene.views, 0)
    runScenePipeline(scene.views, 1)
    runScenePipeline(scene.views, 0)
    runScenePipeline(scene.views, 1)
  }
  // parity of the pipeline outputs after the warmup
  run4(sceneA, false)
  run4(sceneB, true)
  setCollectMemo(false); setCullMemo(false)
  runScenePipeline(sceneA.views, 0)
  setCullMemo(true); setCollectMemo(true)
  runScenePipeline(sceneB.views, 0)
  sceneA.views.lastRet = collectInstancesViews(sceneA.views, 0, 0)
  sceneB.views.lastRet = collectInstancesViews(sceneB.views, 0, 0)
  assertTwinParity(sceneA.views, sceneB.views, 0, 'pipeline')
  console.log('   parity OK: the 4-call pipeline rhythm (both stages)')

  report([
    bench('4 pipeline frames: real (no memo)', () => run4(sceneA, false)),
    bench('4 pipeline frames: +both memoes', () => run4(sceneB, true)),
  ])
}

// ── S5: the CULL alone (hierarchical — the tree walk the memo skips) ────────
{
  const sceneA = buildScene(5)
  const sceneB = buildScene(5)
  const runCull = (scene, memo) => {
    setCullMemo(memo)
    for (let f = 0; f < 10; f++) cullViewsHierarchical(scene.views, 0, f & 1, undefined, true, false)
  }
  runCull(sceneA, false)
  runCull(sceneB, true)
  // parity: the last written buffer of each twin
  const bA = bitsBaseOf(sceneA.views, 0, 0)
  const bB = bitsBaseOf(sceneB.views, 0, 0)
  for (let w = 0; w < sceneA.views.bitsWords; w++) {
    if (sceneA.views.bits[bA + w] !== sceneB.views.bits[bB + w]) {
      console.log(`   ✗ cull parity: bits word ${w}`)
      process.exit(1)
    }
  }
  console.log('   parity OK: 10 hierarchical culls (bits identical)')
  report([
    bench('10 hier culls: real (no memo)', () => runCull(sceneA, false)),
    bench('10 hier culls: +cull memo', () => runCull(sceneB, true)),
  ])
}

setCullMemo(true)
setCollectMemo(true)
console.log('\nAll parities bit-identical; every timing row above is gated on them.')
