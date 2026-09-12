/**
 * task191-prereject.mjs — Task 191 probe: the N4 GROUP-SPHERE PRE-REJECT
 * (the Task-189 dossier, now the real instances.ts code).
 *
 * A/B (the repo canon): the SAME scene, collectGroupMatrices with the
 * pre-reject ENABLED vs the KILL-SWITCH (the pure Task-186 word-blocked
 * scan). Every scenario asserts bit-identical outputs (count + bytes)
 * before printing numbers — the enclosing argument must hold everywhere
 * the bits are cull-produced.
 *
 * Scenarios (100k nodes):
 *   inview    — one group ≈ 45% of nodes, fully in the frustum: the neutral
 *               case (the sphere is built once; per call it is 6 dots that
 *               lose to nothing — the scan runs as before);
 *   outgroup  — the SAME group, the camera turned away: 6 dots vs the full
 *               word-walk — the win;
 *   outsweep  — 100 groups, ~96 fully outside the frustum (the dossier's
 *               S6): the sweep's asymptote;
 *   drone     — 10 frames, one member moves per frame: the honest fee (the
 *               moving group's sphere rebuilds — an O(n) walk per dirty
 *               group until N2's segments land; static groups never pay).
 */
import {
  createScene,
  createCamera,
  cullViewsBrute,
  collectGroupMatrices,
  setGroupSphereReject,
  groupSphereCounters,
  writeCameraPlanes,
} from '../packages/scene/src/index.ts'

const N = 100_000

function bench(name, fn, runs = 30) {
  for (let i = 0; i < 3; i++) fn()
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
    console.log(`   ${r.name.padEnd(46)} ${r.med.toFixed(3)}ms  min ${r.min.toFixed(3)}ms`)
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

function camAimed(at, dist = 400, fov = 1.0) {
  const cam = createCamera().setPerspective(fov, 1, 0.1, 4000)
  cam.setViewLookAt(at[0], at[1], dist, at[0], at[1], 0, 0, 1, 0)
  return cam
}

/** One call: enabled vs killed, parity-checked. Returns [kEnabled, kKilled]. */
function callPair(views, cam, buf, g, size) {
  const a = new Float32Array(size * 16)
  const b = new Float32Array(size * 16)
  setGroupSphereReject(true)
  const ka = collectGroupMatrices(views, cam, buf, g, a)
  setGroupSphereReject(false)
  const kb = collectGroupMatrices(views, cam, buf, g, b)
  setGroupSphereReject(true)
  if (ka !== kb) {
    console.log(`   ✗ parity group ${g}: ${ka} vs ${kb}`)
    process.exit(1)
  }
  for (let i = 0; i < ka * 16; i++) {
    if (a[i] !== b[i]) {
      console.log(`   ✗ parity group ${g}: bytes at ${i}`)
      process.exit(1)
    }
  }
  return ka
}

// ── S1/S2: the IN-VIEW group, then the camera turns away ────────────────────
{
  const rng = mulberry32(1)
  const scene = createScene({ capacity: N, cameraMax: 1, groupMax: 8, maxInstances: N })
  for (let i = 0; i < N; i++) {
    const x = (i % 100) * 6 - 300
    const y = ((i / 100) | 0) % 100 * 6 - 300
    const z = ((i / 10000) | 0) * 8
    scene.create({ position: [x, y, z], sphere: [0, 0, 0, 2], group: 0 })
    if (rng() > 0.9) scene.setVisible(i, false)
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  const views = scene.views
  const out = new Float32Array(N * 16)
  const outKill = new Float32Array(N * 16)

  const camIn = camAimed([0, 0], 400)
  writeCameraPlanes(views, 0, camIn.planes)
  cullViewsBrute(views, 0, 0)
  cullViewsBrute(views, 0, 1)
  const kIn = callPair(views, 0, 0, 0, N)
  console.log(`\n== S1 IN-VIEW group (k=${kIn.toLocaleString('en-US')} of ${N.toLocaleString('en-US')}) ==`)
  report([
    bench('collect in-view: pre-reject ON', () => { setGroupSphereReject(true); collectGroupMatrices(views, 0, 0, 0, out) }),
    bench('collect in-view: kill-switch (scan)', () => { setGroupSphereReject(false); collectGroupMatrices(views, 0, 0, 0, outKill) }),
  ])
  setGroupSphereReject(true)

  // the camera turns away — the whole group leaves the frustum
  const camOut = camAimed([5000, 5000], 400, 0.3)
  writeCameraPlanes(views, 0, camOut.planes)
  cullViewsBrute(views, 0, 0)
  cullViewsBrute(views, 0, 1)
  const kOut = callPair(views, 0, 0, 0, N)
  console.log(`\n== S2 OUT-OF-FRUSTUM group (k=${kOut}) ==`)
  report([
    bench('collect out: pre-reject ON (6 dots)', () => { setGroupSphereReject(true); collectGroupMatrices(views, 0, 0, 0, out) }),
    bench('collect out: kill-switch (full scan)', () => { setGroupSphereReject(false); collectGroupMatrices(views, 0, 0, 0, outKill) }),
  ])
  setGroupSphereReject(true)
}

// ── S3: the OUT-SWEEP — 100 groups, ~96 fully outside ───────────────────────
{
  const scene = createScene({ capacity: N, cameraMax: 1, groupMax: 100, maxInstances: N })
  // 100 clusters of 1000: a 10×10 grid of 300-unit cells; the camera (fov
  // 0.5, aimed at cell (0,0)) sees ~4 cells — the other 96 are fully out.
  for (let i = 0; i < N; i++) {
    const cell = (i / 1000) | 0
    const cx = (cell % 10) * 300
    const cy = ((cell / 10) | 0) * 300
    scene.create({
      position: [cx + (i % 40) * 7, cy + ((i / 40) | 0) % 25 * 7, 10],
      sphere: [0, 0, 0, 2],
      group: cell,
    })
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  const views = scene.views
  const cam = camAimed([105, 105], 500, 0.5)
  writeCameraPlanes(views, 0, cam.planes)
  cullViewsBrute(views, 0, 0)
  cullViewsBrute(views, 0, 1)
  // parity over the FULL sweep first
  let visibleGroups = 0
  for (let g = 0; g < 100; g++) {
    const k = callPair(views, 0, 0, g, 1000)
    if (k > 0) visibleGroups++
  }
  console.log(`\n== S3 OUT-SWEEP (100 groups, ${100 - visibleGroups} fully outside) ==`)
  const out = new Float32Array(1000 * 16)
  const outKill = new Float32Array(1000 * 16)
  const before = groupSphereCounters()
  report([
    bench('100-group sweep: pre-reject ON', () => {
      setGroupSphereReject(true)
      for (let g = 0; g < 100; g++) collectGroupMatrices(views, 0, 0, g, out)
    }),
    bench('100-group sweep: kill-switch (scan)', () => {
      setGroupSphereReject(false)
      for (let g = 0; g < 100; g++) collectGroupMatrices(views, 0, 0, g, outKill)
    }),
  ])
  setGroupSphereReject(true)
  const c = groupSphereCounters()
  console.log(`   rejects=${c.rejects - before.rejects} (sweep runs ×3 warm + parity) builds=${c.builds - before.builds}`)
}

// ── S4: the DRONE — the honest rebuild fee ──────────────────────────────────
{
  const scene = createScene({ capacity: N, cameraMax: 1, groupMax: 100, maxInstances: N })
  for (let i = 0; i < N; i++) {
    const cell = (i / 1000) | 0
    const cx = (cell % 10) * 300
    const cy = ((cell / 10) | 0) * 300
    scene.create({
      position: [cx + (i % 40) * 7, cy + ((i / 40) | 0) % 25 * 7, 10],
      sphere: [0, 0, 0, 2],
      group: cell,
    })
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  const views = scene.views
  const cam = camAimed([105, 105], 500, 0.5)
  writeCameraPlanes(views, 0, cam.planes)
  const out = new Float32Array(1000 * 16)
  let mover = views.order[0]
  const droneFrame = (enabled) => {
    setGroupSphereReject(enabled)
    scene.setLocalTR(mover, (Math.random() * 40) * 7, 10, 10, 0, 0, 0, 1, 1, 1, 1)
    scene.updateWorld()
    scene.refitGroupBounds()
    const b = Math.random() > 0.5 ? 0 : 1
    cullViewsBrute(views, 0, b)
    for (let g = 0; g < 100; g++) collectGroupMatrices(views, 0, b, g, out)
  }
  // parity on the first drone frames (the moving group's content must match)
  const a = new Float32Array(1000 * 16)
  const bk = new Float32Array(1000 * 16)
  for (let f = 0; f < 3; f++) {
    scene.setLocalTR(mover, 20 * 7, 10, 10, 0, 0, 0, 1, 1, 1, 1)
    scene.updateWorld()
    scene.refitGroupBounds()
    cullViewsBrute(views, 0, f & 1)
    setGroupSphereReject(true)
    const kA = collectGroupMatrices(views, 0, f & 1, 0, a)
    setGroupSphereReject(false)
    const kB = collectGroupMatrices(views, 0, f & 1, 0, bk)
    setGroupSphereReject(true)
    if (kA !== kB) { console.log(`   ✗ drone parity: ${kA} vs ${kB}`); process.exit(1) }
    for (let i = 0; i < kA * 16; i++) {
      if (a[i] !== bk[i]) { console.log('   ✗ drone parity: bytes'); process.exit(1) }
    }
  }
  console.log('\n== S4 DRONE (one member moves per frame — the rebuild fee) ==')
  const run10 = (enabled) => { for (let f = 0; f < 10; f++) droneFrame(enabled) }
  report([
    bench('10 drone frames: pre-reject ON', () => run10(true)),
    bench('10 drone frames: kill-switch', () => run10(false)),
  ])
  setGroupSphereReject(true)
}

console.log('\nAll parities bit-identical (enclosing argument holds under cull-produced bits).')
