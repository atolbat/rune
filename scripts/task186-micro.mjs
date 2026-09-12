/**
 * task186-micro.mjs — Task 186 probe: the T0 direct path (collectGroupMatrices).
 *
 * The pool path got its word-wise walk + unrolled copy in Task 143 (−30% on the
 * fill pass); the T0 direct path still runs the naive shape: a function call per
 * candidate rank (rankVisible), a j-loop matrix copy, and `k*16+16 > out.length`
 * arithmetic EVERY iteration. This probe measures four walk shapes on REAL
 * culled bitsets (same scene, same bits — checksums must be bit-identical):
 *
 *   real   — the CURRENT implementation imported from src (the reference);
 *   v1     — rank loop, inlined bit/flag tests, HOISTED capacity, UNROLLED copy;
 *   v2     — Task 143 word-wise walk (zero-word skip + ctz extraction) + unroll;
 *   v3     — rank loop blocked by words (zero word → skip 32 ranks) + unroll.
 *
 * Scenarios (100k nodes, ~50% visibility — the demo's real band):
 *   large  — one group ≈ 50% of all nodes (the stress case for the walk);
 *   small  — one group ≈ 1% of nodes (100 groups — the per-group filter case);
 *   sweep  — all 100 groups collected back to back (the T0 asymptotic case:
 *            the pool path exists exactly for this — documented, not fixed here).
 */
import { createScene, createCamera, cullViewsBrute, writeCameraPlanes, collectGroupMatrices } from '../packages/scene/src/index.ts'

const NF_VISIBLE = 1
const H_NODE_COUNT = 2

function bitsBaseOf(views, bufferIndex, cameraIndex) {
  return (bufferIndex * views.cameraMax + cameraIndex) * views.bitsWords
}

// ── the variants (all must be bit-identical to `real`) ──────────────────────
function v1(views, cameraIndex, bufferIndex, groupId, out) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, group, world, bits, nodeFlags } = views
  const base = bitsBaseOf(views, bufferIndex, cameraIndex)
  const capacity = out.length >>> 4 // full 16-float matrices that fit
  let k = 0
  for (let r = 0; r < n; r++) {
    const slot = order[r]
    if (group[slot] !== groupId) continue
    if ((bits[base + (r >>> 5)] & (1 << (r & 31))) === 0) continue
    if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
    if (k >= capacity) break
    const src = slot * 16
    const dst = k * 16
    out[dst] = world[src]
    out[dst + 1] = world[src + 1]
    out[dst + 2] = world[src + 2]
    out[dst + 3] = world[src + 3]
    out[dst + 4] = world[src + 4]
    out[dst + 5] = world[src + 5]
    out[dst + 6] = world[src + 6]
    out[dst + 7] = world[src + 7]
    out[dst + 8] = world[src + 8]
    out[dst + 9] = world[src + 9]
    out[dst + 10] = world[src + 10]
    out[dst + 11] = world[src + 11]
    out[dst + 12] = world[src + 12]
    out[dst + 13] = world[src + 13]
    out[dst + 14] = world[src + 14]
    out[dst + 15] = world[src + 15]
    k++
  }
  return k
}

function v2(views, cameraIndex, bufferIndex, groupId, out) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, group, world, bits, nodeFlags } = views
  const base = bitsBaseOf(views, bufferIndex, cameraIndex)
  const words = views.bitsWords
  const capacity = out.length >>> 4
  let k = 0
  for (let w = 0; w < words; w++) {
    let word = bits[base + w]
    if (word === 0) continue
    const rBase = w << 5
    while (word !== 0) {
      const lb = word & -word
      word ^= lb
      const r = rBase + 31 - Math.clz32(lb)
      if (r >= n) break
      const slot = order[r]
      if (group[slot] !== groupId) continue
      if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
      if (k >= capacity) break
      const src = slot * 16
      const dst = k * 16
      out[dst] = world[src]
      out[dst + 1] = world[src + 1]
      out[dst + 2] = world[src + 2]
      out[dst + 3] = world[src + 3]
      out[dst + 4] = world[src + 4]
      out[dst + 5] = world[src + 5]
      out[dst + 6] = world[src + 6]
      out[dst + 7] = world[src + 7]
      out[dst + 8] = world[src + 8]
      out[dst + 9] = world[src + 9]
      out[dst + 10] = world[src + 10]
      out[dst + 11] = world[src + 11]
      out[dst + 12] = world[src + 12]
      out[dst + 13] = world[src + 13]
      out[dst + 14] = world[src + 14]
      out[dst + 15] = world[src + 15]
      k++
    }
  }
  return k
}

function v3(views, cameraIndex, bufferIndex, groupId, out) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, group, world, bits, nodeFlags } = views
  const base = bitsBaseOf(views, bufferIndex, cameraIndex)
  const words = views.bitsWords
  const capacity = out.length >>> 4
  let k = 0
  for (let w = 0; w < words; w++) {
    if (bits[base + w] === 0) continue // a fully invisible block — 32 ranks skipped
    const rEnd = Math.min((w << 5) + 32, n)
    for (let r = w << 5; r < rEnd; r++) {
      const slot = order[r]
      if (group[slot] !== groupId) continue
      if ((bits[base + w] & (1 << (r & 31))) === 0) continue
      if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
      if (k >= capacity) break
      const src = slot * 16
      const dst = k * 16
      out[dst] = world[src]
      out[dst + 1] = world[src + 1]
      out[dst + 2] = world[src + 2]
      out[dst + 3] = world[src + 3]
      out[dst + 4] = world[src + 4]
      out[dst + 5] = world[src + 5]
      out[dst + 6] = world[src + 6]
      out[dst + 7] = world[src + 7]
      out[dst + 8] = world[src + 8]
      out[dst + 9] = world[src + 9]
      out[dst + 10] = world[src + 10]
      out[dst + 11] = world[src + 11]
      out[dst + 12] = world[src + 12]
      out[dst + 13] = world[src + 13]
      out[dst + 14] = world[src + 14]
      out[dst + 15] = world[src + 15]
      k++
    }
  }
  return k
}

// ── the scene ───────────────────────────────────────────────────────────────
function buildScene(N, groups, groupOfNode) {
  const scene = createScene({ capacity: N, cameraMax: 1, groupMax: groups, maxInstances: N })
  for (let i = 0; i < N; i++) {
    const x = (i % 100) * 6 - 300
    const y = ((i / 100) | 0) % 100 * 6 - 300
    const z = ((i / 10000) | 0) * 8
    scene.create({ position: [x, y, z], sphere: [0, 0, 0, 2], group: groupOfNode(i) })
  }
  scene.updateWorld()
  const cam = createCamera().setPerspective(1.0, 1, 0.1, 900)
  cam.setViewLookAt(0, 0, 400, 0, 0, 0, 0, 1, 0)
  writeCameraPlanes(scene.views, 0, cam.planes)
  cullViewsBrute(scene.views, 0, 0)
  let visible = 0
  const bits = scene.views.bits
  const words = scene.views.bitsWords
  for (let w = 0; w < words; w++) visible += popcount(bits[w])
  console.log(`   nodes=${N} groups=${groups} visible=${visible} (${(100 * visible / N).toFixed(1)}%)`)
  return scene
}

function popcount(x) {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

function checksum(out, k) {
  let h = 2166136261
  for (let i = 0; i < k * 16; i++) {
    h ^= out[i] === out[i] ? Math.round(out[i] * 1024) : 0x7fffffff
    h = Math.imul(h, 16777619)
  }
  return h ^ k
}

function bench(name, fn, runs = 40) {
  for (let i = 0; i < 5; i++) fn() // warmup
  const times = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const med = times[(times.length >> 1)]
  return { name, med, min: times[0] }
}

// v4 — rank loop blocked by words, HOISTED word, BIT-TEST FIRST (register-only
// reject: an invisible rank never loads order/group), unrolled copy.
function v4(views, cameraIndex, bufferIndex, groupId, out) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, group, world, bits, nodeFlags } = views
  const base = bitsBaseOf(views, bufferIndex, cameraIndex)
  const words = views.bitsWords
  const capacity = out.length >>> 4
  let k = 0
  for (let w = 0; w < words; w++) {
    const word = bits[base + w]
    if (word === 0) continue
    const rEnd = Math.min((w << 5) + 32, n)
    for (let r = w << 5; r < rEnd; r++) {
      if ((word & (1 << (r & 31))) === 0) continue
      const slot = order[r]
      if (group[slot] !== groupId) continue
      if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
      if (k >= capacity) break
      const src = slot * 16
      const dst = k * 16
      out[dst] = world[src]
      out[dst + 1] = world[src + 1]
      out[dst + 2] = world[src + 2]
      out[dst + 3] = world[src + 3]
      out[dst + 4] = world[src + 4]
      out[dst + 5] = world[src + 5]
      out[dst + 6] = world[src + 6]
      out[dst + 7] = world[src + 7]
      out[dst + 8] = world[src + 8]
      out[dst + 9] = world[src + 9]
      out[dst + 10] = world[src + 10]
      out[dst + 11] = world[src + 11]
      out[dst + 12] = world[src + 12]
      out[dst + 13] = world[src + 13]
      out[dst + 14] = world[src + 14]
      out[dst + 15] = world[src + 15]
      k++
    }
  }
  return k
}

// v5 — v4 + the trivial-accept fast path (a full word: no per-rank bit test at
// all — 32 rank tests collapse to order/group loads only).
function v5(views, cameraIndex, bufferIndex, groupId, out) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, group, world, bits, nodeFlags } = views
  const base = bitsBaseOf(views, bufferIndex, cameraIndex)
  const words = views.bitsWords
  const capacity = out.length >>> 4
  let k = 0
  for (let w = 0; w < words; w++) {
    const word = bits[base + w]
    if (word === 0) continue
    const full = word === -1
    const rEnd = Math.min((w << 5) + 32, n)
    for (let r = w << 5; r < rEnd; r++) {
      if (!full && (word & (1 << (r & 31))) === 0) continue
      const slot = order[r]
      if (group[slot] !== groupId) continue
      if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
      if (k >= capacity) break
      const src = slot * 16
      const dst = k * 16
      out[dst] = world[src]
      out[dst + 1] = world[src + 1]
      out[dst + 2] = world[src + 2]
      out[dst + 3] = world[src + 3]
      out[dst + 4] = world[src + 4]
      out[dst + 5] = world[src + 5]
      out[dst + 6] = world[src + 6]
      out[dst + 7] = world[src + 7]
      out[dst + 8] = world[src + 8]
      out[dst + 9] = world[src + 9]
      out[dst + 10] = world[src + 10]
      out[dst + 11] = world[src + 11]
      out[dst + 12] = world[src + 12]
      out[dst + 13] = world[src + 13]
      out[dst + 14] = world[src + 14]
      out[dst + 15] = world[src + 15]
      k++
    }
  }
  return k
}

function runScenario(title, scene, groupId, out) {
  console.log(`\n== ${title} ==`)
  const views = scene.views
  const args = [views, 0, 0, groupId, out]
  // correctness first: every variant bit-identical to the current real one
  const kReal = collectGroupMatrices(...args)
  const ref = out.slice()
  for (const [name, fn] of [['v1', v1], ['v2', v2], ['v3', v3], ['v4', v4], ['v5', v5]]) {
    out.fill(0)
    const k = fn(views, 0, 0, groupId, out)
    if (k !== kReal || checksum(out, k) !== checksum(ref, kReal)) {
      console.log(`   ✗ ${name}: MISMATCH (k=${k} vs ${kReal})`)
      process.exit(1)
    }
  }
  console.log(`   all variants bit-identical (k=${kReal})`)
  const real = () => { collectGroupMatrices(views, 0, 0, groupId, out) }
  const b1 = () => { v1(views, 0, 0, groupId, out) }
  const b2 = () => { v2(views, 0, 0, groupId, out) }
  const b3 = () => { v3(views, 0, 0, groupId, out) }
  const b4 = () => { v4(views, 0, 0, groupId, out) }
  const b5 = () => { v5(views, 0, 0, groupId, out) }
  const rows = [bench('real (current)', real), bench('v1 rank+unroll', b1), bench('v2 wordwise+unroll', b2), bench('v3 rank-blocked', b3), bench('v4 word-block+bitfirst', b4), bench('v5 +trivial-accept', b5)]
  const base = rows[0].med
  for (const r of rows) console.log(`   ${r.name.padEnd(20)} ${r.med.toFixed(3)}ms  min ${r.min.toFixed(3)}ms  ${r === rows[0] ? '—' : ((100 * (r.med - base) / base).toFixed(1) + '%')}`)
  return { kReal, rows }
}

const N = 100_000
// large: group 0 = every 2nd node (50%); the rest spread over 7 groups
const sceneLarge = buildScene(N, 8, (i) => (i % 2 === 0 ? 0 : 1 + (i % 7)))
runScenario('LARGE group (≈50% of nodes in one group)', sceneLarge, 0, new Float32Array(50_000 * 16))

// small: 100 groups, ~1% each — pick a group that actually HAS visible members
const sceneSmall = buildScene(N, 100, (i) => i % 100)
{
  const counts = new Int32Array(100)
  const { order, group, bits, nodeFlags } = sceneSmall.views
  const n = N
  for (let r = 0; r < n; r++) {
    const slot = order[r]
    if ((bits[(r >>> 5)] & (1 << (r & 31))) === 0) continue
    if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
    const g = group[slot]
    if (g >= 0) counts[g]++
  }
  let bestG = 0, bestC = -1
  for (let g = 0; g < 100; g++) if (counts[g] > bestC) { bestC = counts[g]; bestG = g }
  console.log(`   small-group pick: group ${bestG} with ${bestC} visible members`)
  runScenario('SMALL group (≈1% of nodes, 100 groups)', sceneSmall, bestG, new Float32Array(4_000 * 16))
}

// sweep: all 100 groups back to back (T0 asymptotics — the pool path's turf)
{
  const views = sceneSmall.views
  const out = new Float32Array(4_000 * 16)
  const realSweep = () => { for (let g = 0; g < 100; g++) collectGroupMatrices(views, 0, 0, g, out) }
  const v1Sweep = () => { for (let g = 0; g < 100; g++) v1(views, 0, 0, g, out) }
  const v2Sweep = () => { for (let g = 0; g < 100; g++) v2(views, 0, 0, g, out) }
  const v3Sweep = () => { for (let g = 0; g < 100; g++) v3(views, 0, 0, g, out) }
  const v4Sweep = () => { for (let g = 0; g < 100; g++) v4(views, 0, 0, g, out) }
  const v5Sweep = () => { for (let g = 0; g < 100; g++) v5(views, 0, 0, g, out) }
  console.log('\n== SWEEP all 100 groups (T0 asymptotics) ==')
  const rows = [bench('real (current)', realSweep, 10), bench('v1 rank+unroll', v1Sweep, 10), bench('v2 wordwise+unroll', v2Sweep, 10), bench('v3 rank-blocked', v3Sweep, 10), bench('v4 word-block+bitfirst', v4Sweep, 10), bench('v5 +trivial-accept', v5Sweep, 10)]
  const base = rows[0].med
  for (const r of rows) console.log(`   ${r.name.padEnd(20)} ${r.med.toFixed(3)}ms  min ${r.min.toFixed(3)}ms  ${r === rows[0] ? '—' : ((100 * (r.med - base) / base).toFixed(1) + '%')}`)
}
