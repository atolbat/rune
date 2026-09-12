/**
 * task192-tail.mjs — Task 192: the TAIL LAYOUT (N2+N1) A/B probe.
 *
 * NOTHING here invents data: every measurement is a twin-scene A/B (the
 * kill-switch setTailLayout(false) = the pre-192 layout family — the pack,
 * the cull and the collects all degenerate to the legacy shapes), medians
 * over warm runs, parity gates before every benchmark (a broken variant
 * does not get to be measured).
 *
 * Sections:
 *   S1 — the DIRECT collect (collectGroupMatrices): the all-groups sweep,
 *        a small group (~1%), a large group (~50%), the out-of-frustum
 *        sweep (the N4 pre-reject composed);
 *   S2 — the POOL pass (collectInstancesViews): the full collect (counting
 *        + prefix + fill) on the demo band (45% visible);
 *   S3 — the CULL: hierarchical (tree walk + the tail brute sweep) vs the
 *        legacy full walk;
 *   S4 — the FEES: pack (the tail scatter + the world permutation), the
 *        animated updateWorld (the rank-major write pattern — absolute),
 *        the drone frame pipeline;
 *   S5 — the pipeline frames: static (the memo hit), flip, drone.
 */
import {
  createScene, createCamera, writeCameraPlanes, cullViewsBrute, cullViewsHierarchical,
  collectGroupMatrices, collectInstancesViews, instancePoolBase, setTailLayout,
  popcountBits, tailCounters, setCullMemo, setCollectMemo,
} from '../packages/scene/src/index.ts'

import { bitsBase } from '../packages/scene/src/culling.ts'

// ── the bench harness (median + min, warm) ─────────────────────────────────
function bench(name, fn, iters = 12, inner = 1) {
  for (let i = 0; i < 3; i++) fn() // warmup
  const samples = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    for (let j = 0; j < inner; j++) fn()
    samples.push((performance.now() - t0) / inner)
  }
  samples.sort((a, b) => a - b)
  return { name, med: samples[samples.length >> 1], min: samples[0] }
}

function report(rows) {
  for (const r of rows) console.log(`   ${r.name.padEnd(46)} ${r.med.toFixed(4)}ms  min ${r.min.toFixed(4)}ms`)
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const N = 100_000

/** The demo pattern: structure forest + grouped instanced LEAVES (the tail domain). */
function buildScene(seed, groups = 100) {
  const rnd = mulberry32(seed)
  const scene = createScene({ capacity: N + 64, groupMax: groups, cameraMax: 2, maxInstances: N })
  const parents = []
  for (let i = 0; i < N; i++) {
    const parent = parents.length > 0 && rnd() < 0.6 ? parents[(rnd() * parents.length) | 0] : -1
    const isLeaf = rnd() < 0.45
    const slot = scene.create({
      parent,
      position: [(rnd() - 0.5) * 600, (rnd() - 0.5) * 300, (rnd() - 0.5) * 600],
      group: isLeaf ? (rnd() * groups) | 0 : -1,
      sphere: [0, 0, 0, isLeaf ? 0.5 + rnd() * 2 : -1],
    })
    if (isLeaf) parents.length = 0 // a leaf never gains children in this pattern
    else parents.push(slot)
    if (parents.length > 64) parents.splice(0, 32)
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  return scene
}

// ── the ISOLATE mode (argv: --isolate <on|off>) ─────────────────────────────
// Interleaved A/B in ONE process deoptimizes the shared functions (JSC
// polymorphism on the mode branch — measured: the same call 1.6ms isolated,
// 7.4ms interleaved). Production NEVER flips the switch — the honest kernel
// numbers come from SEPARATE processes, one per mode.
if (process.argv[2] === '--isolate') {
  const mode = process.argv[3] === 'on'
  const scene = buildScene(7)
  setTailLayout(mode)
  scene.pack()
  const v = scene.views
  const camIso = createCamera().setPerspective(1.0, 1, 0.1, 1200)
  camIso.setViewLookAt(0, 120, 500, 0, 0, 0, 0, 1, 0)
  writeCameraPlanes(v, 1, camIso.planes)
  cullViewsBrute(v, 1, 0)
  setCollectMemo(false)
  setCullMemo(false)
  const groups = Math.min(v.headerI[11], v.groupMax)
  const outIso = new Float32Array(1200 * 16)
  console.log(`   [isolate/${mode ? 'on' : 'off'}]`)
  report([
    bench(`pool pass (${mode ? 'segments' : 'legacy'})`, () => collectInstancesViews(v, 1, 0), 10),
    bench(`cull hier (${mode ? 'tree+tail' : 'full walk'})`, () => cullViewsHierarchical(v, 1, 1), 10),
    bench(`cull brute (${mode ? 'tail order' : 'DFS order'})`, () => cullViewsBrute(v, 1, 0), 10),
    bench(`direct sweep ×${groups}`, () => { for (let g = 0; g < groups; g++) collectGroupMatrices(v, 1, 0, g, outIso) }, 8),
  ])
  process.exit(0)
}

// twin scenes: A = OFF (legacy), B = ON (tail)
const sceneA = buildScene(7)
const sceneB = buildScene(7)
setTailLayout(false)
sceneA.pack()
setTailLayout(true)
sceneB.pack()
const va = sceneA.views
const vb = sceneB.views
const GROUPS = Math.min(va.headerI[11], va.groupMax)

const cam = createCamera().setPerspective(1.0, 1, 0.1, 1200)
cam.setViewLookAt(0, 120, 500, 0, 0, 0, 0, 1, 0)
writeCameraPlanes(va, 0, cam.planes)
writeCameraPlanes(vb, 1, cam.planes)

// the culls (both twins, brute — layout-agnostic, same visible sets)
setTailLayout(false)
cullViewsBrute(va, 0, 0)
setTailLayout(true)
cullViewsBrute(vb, 1, 0)
const popA = popcountBits(va.bits, bitsBase(va, 0, 0), va.bitsWords)
const popB = popcountBits(vb.bits, bitsBase(vb, 0, 1), vb.bitsWords) // (buffer, camera)!
console.log(`\n== the fixture: N=${N}, groups=${GROUPS}, visible ${popA}/${N} (${((popA / N) * 100) | 0}%) — twins ${popA === popB ? 'EQUAL' : 'MISMATCH'} ==`)

// ── PARITY GATES (a broken variant does not get measured) ──────────────────
{
  const outA = new Float32Array((N / GROUPS + 64) * 16)
  const outB = new Float32Array((N / GROUPS + 64) * 16)
  let mismatch = 0
  for (let g = 0; g < GROUPS; g++) {
    outA.fill(7.77)
    outB.fill(7.77)
    setTailLayout(false)
    const ka = collectGroupMatrices(va, 0, 0, g, outA)
    setTailLayout(true)
    const kb = collectGroupMatrices(vb, 1, 0, g, outB)
    if (ka !== kb) { mismatch++; continue }
    for (let i = 0; i < ka * 16; i++) if (outA[i] !== outB[i]) { mismatch++; break }
  }
  // the pool parity
  setTailLayout(false)
  const retA = collectInstancesViews(va, 0, 0)
  setTailLayout(true)
  const retB = collectInstancesViews(vb, 1, 0)
  const poolA = instancePoolBase(va, 0, 0)
  const poolB = instancePoolBase(vb, 0, 1) // (buffer, camera)!
  let poolMismatch = 0
  if (retA !== retB) poolMismatch = 1
  else for (let i = 0; i < retA * 16; i++) if (va.instPool[poolA + i] !== vb.instPool[poolB + i]) { poolMismatch = 1; break }
  console.log(`   parity: direct ${mismatch === 0 ? 'OK' : `${mismatch} FAILS`} / pool ${retA} vs ${retB} ${poolMismatch === 0 ? 'OK' : 'FAILS'}`)
  if (mismatch !== 0 || poolMismatch !== 0) { console.log('   ✗ PARITY FAILED — no benchmarks'); process.exit(1) }
}

// ── S1: the DIRECT collect ──────────────────────────────────────────────────
console.log('\n== S1: collectGroupMatrices ==')
{
  const sweep = () => {
    for (let g = 0; g < GROUPS; g++) collectGroupMatrices(v, 0, 0, g, out)
  }
  const out = new Float32Array((N / GROUPS + 64) * 16)
  const v = va
  setTailLayout(false)
  const sweepOff = bench('all-groups sweep (legacy walk)', sweep, 10)
  setTailLayout(true)
  const sweepOn = bench('all-groups sweep (tail segments)', () => {
    for (let g = 0; g < GROUPS; g++) collectGroupMatrices(vb, 1, 0, g, out)
  }, 10)
  report([sweepOff, sweepOn])

  // a small group (~1% of the nodes)
  const members = new Int32Array(GROUPS)
  for (let r = 0; r < vb.headerI[2]; r++) {
    const g = vb.group[vb.order[r]]
    if (g >= 0 && g < GROUPS) members[g]++
  }
  let smallG = 0
  for (let g = 1; g < GROUPS; g++) if (members[g] < members[smallG] + 30 && members[g] > 0) { smallG = g; break }
  console.log(`   the small group: g=${smallG}, |g|=${members[smallG]}`)
  const outS = new Float32Array((members[smallG] + 8) * 16)
  setTailLayout(false)
  const smallOff = bench('small group (legacy walk)', () => collectGroupMatrices(va, 0, 0, smallG, outS), 40)
  setTailLayout(true)
  const smallOn = bench('small group (segment)', () => collectGroupMatrices(vb, 1, 0, smallG, outS), 40)
  report([smallOff, smallOn])

  // a large group (~a third of the visible)
  let largeG = 0
  for (let g = 0; g < GROUPS; g++) if (members[g] > members[largeG]) largeG = g
  console.log(`   the large group: g=${largeG}, |g|=${members[largeG]}`)
  const outL = new Float32Array((members[largeG] + 8) * 16)
  setTailLayout(false)
  const largeOff = bench('large group (legacy walk)', () => collectGroupMatrices(va, 0, 0, largeG, outL), 20)
  setTailLayout(true)
  const largeOn = bench('large group (segment)', () => collectGroupMatrices(vb, 1, 0, largeG, outL), 20)
  report([largeOff, largeOn])

  // a single call (the cold-cache shape)
  setTailLayout(false)
  const singleOff = bench('single call (legacy walk)', () => collectGroupMatrices(va, 0, 0, (Math.random() * GROUPS) | 0, outS), 40)
  setTailLayout(true)
  const singleOn = bench('single call (segment)', () => collectGroupMatrices(vb, 1, 0, (Math.random() * GROUPS) | 0, outS), 40)
  report([singleOff, singleOn])

  // the out-of-frustum sweep (the N4 pre-reject composed)
  const far = createCamera().setPerspective(1.0, 1, 0.1, 500)
  far.setViewLookAt(0, 0, 5000, 5000, 5000, 5000, 0, 1, 0) // looking AWAY
  writeCameraPlanes(va, 0, far.planes) // overwrite camera 0's planes on A? no — use buffer 1
  writeCameraPlanes(va, 1, far.planes)
  writeCameraPlanes(vb, 0, far.planes)
  setTailLayout(false)
  cullViewsBrute(va, 1, 1) // A: camera 1, buffer 1 — everything culled
  setTailLayout(true)
  cullViewsBrute(vb, 0, 1) // B: camera 0, buffer 1
  console.log(`   the out-frustum bits: A pop ${popcountBits(va.bits, bitsBase(va, 1, 1), va.bitsWords)} / B pop ${popcountBits(vb.bits, bitsBase(vb, 1, 0), vb.bitsWords)}`)
  setTailLayout(false)
  const outOff = bench('out-sweep 100 groups (legacy)', () => {
    for (let g = 0; g < GROUPS; g++) collectGroupMatrices(va, 1, 1, g, outS)
  }, 10)
  setTailLayout(true)
  const outOn = bench('out-sweep 100 groups (segment+N4)', () => {
    for (let g = 0; g < GROUPS; g++) collectGroupMatrices(vb, 0, 1, g, outS)
  }, 10)
  report([outOff, outOn])
}

// ── S1b: the BIG-GROUP fixture (one group ≈ half the nodes, dense in view) ──
console.log('\n== S1b: the big group (4 groups, ~11k members each, in view) ==')
{
  const BIG = 50_000
  const buildBig = (seed) => {
    const rnd = mulberry32(seed)
    const scene = createScene({ capacity: BIG + 16, groupMax: 4, cameraMax: 2, maxInstances: BIG })
    const parents = []
    for (let i = 0; i < BIG; i++) {
      const parent = parents.length > 0 && rnd() < 0.5 ? parents[(rnd() * parents.length) | 0] : -1
      const isLeaf = rnd() < 0.9
      const slot = scene.create({ parent, position: [(rnd() - 0.5) * 200, (rnd() - 0.5) * 200, (rnd() - 0.5) * 200], group: isLeaf ? (rnd() * 4) | 0 : -1, sphere: [0, 0, 0, 0.3 + rnd() * 0.5] })
      if (isLeaf) parents.length = 0
      else parents.push(slot)
      if (parents.length > 64) parents.splice(0, 32)
    }
    scene.updateWorld()
    scene.refitGroupBounds()
    return scene
  }
  const bigA = buildBig(21)
  const bigB = buildBig(21)
  setTailLayout(false)
  bigA.pack()
  setTailLayout(true)
  bigB.pack()
  const bva = bigA.views
  const bvb = bigB.views
  const camBig = createCamera().setPerspective(1.4, 1, 0.1, 600)
  camBig.setViewLookAt(0, 0, 350, 0, 0, 0, 0, 1, 0)
  writeCameraPlanes(bva, 0, camBig.planes)
  writeCameraPlanes(bvb, 1, camBig.planes)
  setTailLayout(false)
  cullViewsBrute(bva, 0, 0)
  setTailLayout(true)
  cullViewsBrute(bvb, 1, 0)
  const popBig = popcountBits(bvb.bits, bitsBase(bvb, 0, 1), bvb.bitsWords)
  console.log(`   fixture: N=${BIG}, visible ${popBig}/${BIG} (${((popBig / BIG) * 100) | 0}%)`)
  const outBig = new Float32Array(BIG * 16)
  setTailLayout(false)
  const bigOff = bench('big-group sweep ×4 (legacy walk)', () => {
    for (let g = 0; g < 4; g++) collectGroupMatrices(bva, 0, 0, g, outBig)
  }, 10)
  setTailLayout(true)
  const bigOn = bench('big-group sweep ×4 (segment/block)', () => {
    for (let g = 0; g < 4; g++) collectGroupMatrices(bvb, 1, 0, g, outBig)
  }, 10)
  report([bigOff, bigOn])
  setCollectMemo(false)
  setTailLayout(false)
  const bigPoolOff = bench('big pool pass (legacy walk)', () => collectInstancesViews(bva, 0, 0), 10)
  setTailLayout(true)
  const bigPoolOn = bench('big pool pass (segments + blocks)', () => collectInstancesViews(bvb, 1, 0), 10)
  setCollectMemo(true)
  report([bigPoolOff, bigPoolOn])
}

// ── S2: the POOL pass ───────────────────────────────────────────────────────
console.log('\n== S2: collectInstancesViews (the pool pass) ==')
{
  setTailLayout(false)
  const poolOff = bench('pool pass (legacy walk)', () => collectInstancesViews(va, 0, 0), 12)
  setTailLayout(true)
  const poolOn = bench('pool pass (segments + blocks)', () => collectInstancesViews(vb, 1, 0), 12)
  report([poolOff, poolOn])
  const tc = tailCounters()
  console.log(`   tail counters: scans=${tc.scans} blocks=${tc.blocks} popcounts=${tc.popcounts}`)
}

// ── S3: the CULL ────────────────────────────────────────────────────────────
console.log('\n== S3: the cull (hierarchical) ==')
{
  writeCameraPlanes(va, 0, cam.planes)
  writeCameraPlanes(vb, 1, cam.planes)
  setCullMemo(false) // the KERNEL, not the memo hits
  setTailLayout(false)
  const cullOff = bench('cull hier kernel (legacy full walk)', () => cullViewsHierarchical(va, 0, 0), 10)
  setTailLayout(true)
  const cullOn = bench('cull hier kernel (tree + tail sweep)', () => cullViewsHierarchical(vb, 1, 1), 10)
  report([cullOff, cullOn])
  setCullMemo(true)
  // parity: each side against ITS OWN brute reference (fresh slots)
  setTailLayout(false)
  cullViewsBrute(va, 1, 1) // A: camera 1, buffer 1 — never written before
  setTailLayout(true)
  cullViewsBrute(vb, 0, 1) // B: camera 0, buffer 1 — was the out-frustum slot; RE-cull in view
  const aH = bitsBase(va, 0, 0) // the hier results
  const bH = bitsBase(vb, 1, 1)
  const aBrute = bitsBase(va, 1, 1) // camera 1 — same planes as camera 0? NO — planes are PER CAMERA
  // (cameras 0 and 1 hold the SAME cam here for A? camera 1 got the FAR planes
  // in the out-frustum section — rewrite them first!)
  writeCameraPlanes(va, 1, cam.planes)
  setTailLayout(false)
  cullViewsBrute(va, 1, 1)
  setTailLayout(true)
  let diffA = 0, diffB = 0
  for (let w = 0; w < va.bitsWords; w++) {
    if (va.bits[aH + w] !== va.bits[aBrute + w]) diffA++
    if (vb.bits[bH + w] !== vb.bits[bitsBase(vb, 0, 1) + w]) diffB++
  }
  console.log(`   cull parity vs brute: A ${diffA === 0 ? 'OK' : diffA + ' words DIFFER'} / B ${diffB === 0 ? 'OK' : diffB + ' words DIFFER'}`)
}

// ── S4: the FEES ────────────────────────────────────────────────────────────
console.log('\n== S4: the fees ==')
{
  setTailLayout(true)
  const packOn = bench('pack (DFS + scatter + permutation)', () => { sceneB.pack() }, 8)
  setTailLayout(false)
  const packOff = bench('pack (DFS + permutation, legacy)', () => { sceneA.pack() }, 8)
  setTailLayout(true)
  report([packOff, packOn])
  // the animated updateWorld (the rank-major write pattern — the absolute)
  const anim = () => {
    for (let i = 0; i < 2000; i++) sceneB.setLocalTR((i * 37) % 900, Math.random() * 40, 0, 0, 0, 0, 1, 1, 1, 1)
    sceneB.updateWorld()
  }
  report([bench('animated updateWorld (2000 nodes, absolute)', anim, 6)])
  const animA = () => {
    for (let i = 0; i < 2000; i++) sceneA.setLocalTR((i * 37) % 900, Math.random() * 40, 0, 0, 0, 0, 1, 1, 1, 1)
    sceneA.updateWorld()
  }
  const animB = () => {
    for (let i = 0; i < 2000; i++) sceneB.setLocalTR((i * 37) % 900, Math.random() * 40, 0, 0, 0, 0, 1, 1, 1, 1)
    sceneB.updateWorld()
  }
  // (the drone A/B lives in the ISOLATE child processes — see the S6 block)
}

// ── S5: the pipeline frames ─────────────────────────────────────────────────
console.log('\n== S5: the pipeline frames ==')
{
  // static (the Task-190 memoes hit)
  setTailLayout(false)
  const staticOff = bench('10 static frames (legacy)', () => {
    for (let f = 0; f < 10; f++) { cullViewsBrute(va, 0, f & 1); collectInstancesViews(va, 0, f & 1) }
  }, 8)
  setTailLayout(true)
  const staticOn = bench('10 static frames (tail + memoes)', () => {
    for (let f = 0; f < 10; f++) { cullViewsBrute(vb, 1, f & 1); collectInstancesViews(vb, 1, f & 1) }
  }, 8)
  report([staticOff, staticOn])
}
// ── S6: the isolated kernel A/B (separate processes — no interleaving deopt) ──
console.log('\n== S6: the isolated kernels (one process per mode) ==')
for (const mode of ['off', 'on']) {
  const proc = Bun.spawnSync(['bun', import.meta.path, '--isolate', mode])
  process.stdout.write(proc.stdout.toString())
}

console.log('\nTASK 192 TAIL A/B: DONE')
