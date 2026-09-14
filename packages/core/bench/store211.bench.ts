/**
 * store211.bench.ts — Task 211: THE UNIFIED DATA SURFACE, measured.
 *
 * The store's own laws, benched on the DEMO'S OWN corpus (the Task-210
 * discipline — the same city, the same shapes, checksum-gated so a win
 * that changes an answer is no win):
 *
 *   A. THE READ SWEEP — the adopted store's column view vs the
 *      SpatialBox[] object array (the Task-210 H-group law, now on the
 *      store's own surface): all six AABB fields of all 16407 records.
 *   B. THE EDIT SWEEP — 64 drones rewriting their centers, store vs
 *      objects (the write lane + the dirty bookkeeping).
 *   C. THE UPLOAD MATH — the dirty ranges' bytes vs the full buffer
 *      (the partial-upload win the demo's HUD shows live).
 *   D. THE GROWTH LADDER — store 'rab' vs store 'copy' vs plain
 *      Array.push (the C2 law on the store's surface).
 *   E. THE SPARSE WALK — MarkSet word-walk vs the array filter+push
 *      (the E law: 15–22× on sparse survivor sets).
 *   F. THE DENSE DELETE — swapRemove vs Array.splice (O(1) vs O(n)).
 *   G. THE BULK COPY — copyRecords (one set() per column) vs the
 *      per-element loop (the memcpy-class law).
 */
import { createStore, adoptStore, createMarkSet } from '../src/index.ts'
import type { SoAStore } from '../src/index.ts'
import { createScene } from '../../../demo/occlusion/scene.js'

const OCCL = 16384
const scene = createScene(OCCL)
const N = scene.N

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

function fmt(ms: number): string {
  return ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(1)} µs`
}

let allOk = true
function fail(why: string): void {
  allOk = false
  console.error(`   FAIL: ${why}`)
}

// ── the corpus: the SAME data, three shapes ────────────────────────────────
// 1. The store ADOPTING a copy of the scene's records region (the
//    production path — the demo's scene buffer rides adoptStore).
const sceneWords = new Uint32Array(scene.sceneWords.length)
sceneWords.set(scene.sceneWords)
const store = adoptStore(sceneWords.buffer, [{ name: 'rec', kind: 'f32', width: 12 }], N, scene.INST_OFF * 4)
const rec = store.column('rec') as Float32Array
// 2. The object array (the Task-210 H-group baseline — the demo's own
//    pre-211 spatialBoxes shape).
interface Box { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number }
const boxes: Box[] = []
for (let i = 0; i < N; i++) {
  const w = i * 12
  boxes.push({ cx: rec[w], cy: rec[w + 1], cz: rec[w + 2], hx: rec[w + 3], hy: rec[w + 4], hz: rec[w + 5] })
}
// 3. The plain Float32Array twin (the raw-view control — the store's
//    view must never LOSE to a hand-rolled view).
const flat = new Float32Array(N * 12)
flat.set(rec)

// ── A. the read sweep ──────────────────────────────────────────────────────
{
  let cs = 0, cb = 0, cf = 0
  const tS = bench('store-read', () => {
    cs = 0
    for (let i = 0; i < N; i++) {
      const w = i * 12
      cs += rec[w] + rec[w + 1] * 2 + rec[w + 2] * 3 + rec[w + 3] + rec[w + 4] + rec[w + 5]
    }
  }, 40)
  const tB = bench('object-read', () => {
    cb = 0
    for (let i = 0; i < N; i++) {
      const b = boxes[i]
      cb += b.cx + b.cy * 2 + b.cz * 3 + b.hx + b.hy + b.hz
    }
  }, 40)
  const tF = bench('flat-read', () => {
    cf = 0
    for (let i = 0; i < N; i++) {
      const w = i * 12
      cf += flat[w] + flat[w + 1] * 2 + flat[w + 2] * 3 + flat[w + 3] + flat[w + 4] + flat[w + 5]
    }
  }, 40)
  if (cs !== cb || cb !== cf) fail(`read checksums differ (${cs} vs ${cb} vs ${cf})`)
  console.log(`\nA. THE READ SWEEP (${N} records × 6 fields, checksum-gated)`)
  console.log(`   store view:   ${fmt(tS)}`)
  console.log(`   object array: ${fmt(tB)} → SoA ${x(tB / tS)}×`)
  console.log(`   raw flat view (control): ${fmt(tF)} (the store's view must ride this lane)`)
  if (tS > tF * 1.35) fail('the store view lost to the raw flat view by >35% (the JIT-order noise band is real — the lanes are the same shape)')
}

function x(ratio: number): string {
  return ratio >= 1 ? ratio.toFixed(2) : `1/${(1 / ratio).toFixed(2)}`
}

// ── B. the edit sweep (64 drones) ─────────────────────────────────────────
{
  const DRONES = 64
  const ids = new Uint32Array(DRONES)
  for (let d = 0; d < DRONES; d++) ids[d] = ((d * 2654435761) >>> 0) % N
  let csS = 0, csB = 0
  const tS = bench('store-edit', () => {
    csS = 0
    for (let d = 0; d < DRONES; d++) {
      const i = ids[d], w = i * 12
      rec[w] += 0.125
      rec[w + 2] -= 0.0625
      store.markRecordDirty(i)
      csS += rec[w] + rec[w + 2]
    }
    store.clearDirty()
  }, 200)
  const tB = bench('object-edit', () => {
    csB = 0
    for (let d = 0; d < DRONES; d++) {
      const b = boxes[ids[d]]
      // fround: the object lane must match the store's f32 STORAGE
      // semantics — a Float32Array += stores the ROUNDED sum, a plain
      // object field would accumulate in f64 and "win" a checksum it
      // never earned (the 211 bench lesson: compare semantics, not
      // just numbers)
      b.cx = Math.fround(b.cx + 0.125)
      b.cz = Math.fround(b.cz - 0.0625)
      csB += b.cx + b.cz
    }
  }, 200)
  if (csS !== csB) fail(`edit checksums differ (${csS} vs ${csB})`)
  console.log(`\nB. THE EDIT SWEEP (${DRONES} drones — write + dirty bookkeeping)`)
  console.log(`   store (write + markDirty): ${fmt(tS)}`)
  console.log(`   objects (write only):      ${fmt(tB)} → the dirty lane costs ${x(tS / tB)}× of an object write`)
  console.log(`   (the objects lane pays the FULL re-upload later — see C)`)
}

// ── C. the upload math ─────────────────────────────────────────────────────
{
  const DRONES = 64
  store.clearDirty()
  for (let d = 0; d < DRONES; d++) {
    store.markRecordDirty(((d * 2654435761) >>> 0) % N)
  }
  const tR = bench('take-ranges', () => {
    void store.takeUploadRanges()
  }, 200)
  const ranges = store.takeUploadRanges()
  let dirty = 0
  for (const r of ranges) dirty += r.end - r.start
  const full = sceneWords.byteLength
  console.log(`\nC. THE UPLOAD MATH (${DRONES} scattered drones)`)
  console.log(`   takeUploadRanges: ${fmt(tR)} → ${ranges.length} ranges, ${dirty} B`)
  console.log(`   full re-upload:   ${(full / 1024).toFixed(0)} KB → the partial upload is ${(full / Math.max(1, dirty)).toFixed(0)}× smaller`)
  store.clearDirty()
  if (dirty >= full) fail('the partial upload is not smaller')
  if (ranges.length === 0) fail('no ranges from 64 dirty records')
}

// ── D. the growth ladder ───────────────────────────────────────────────────
{
  const APPENDS = 100_000
  const COLS = [{ name: 'v', kind: 'f32' as const, width: 4 }]
  const tRab = bench('grow-rab', () => {
    const st = createStore(COLS, { capacity: 16, growth: 'rab' })
    for (let i = 0; i < APPENDS; i++) st.append()
  }, 5)
  const tCopy = bench('grow-copy', () => {
    const st = createStore(COLS, { capacity: 16, growth: 'copy' })
    for (let i = 0; i < APPENDS; i++) st.append()
  }, 5)
  const tArr = bench('grow-array', () => {
    const arr: number[] = []
    for (let i = 0; i < APPENDS; i++) arr.push(i)
  }, 5)
  // the append path is the common denominator — the ladder must be sound
  const check = createStore(COLS, { capacity: 4, growth: 'copy' })
  for (let i = 0; i < 100; i++) {
    const r = check.append()
    ;(check.column('v') as Float32Array)[r * 4] = i
  }
  const v = check.column('v') as Float32Array
  for (let i = 0; i < 100; i++) if (v[i * 4] !== i) { fail('growth lost data'); break }
  console.log(`\nD. THE GROWTH LADDER (${APPENDS.toLocaleString('en-US')} appends, width-4 records)`)
  console.log(`   store rab:   ${fmt(tRab)}`)
  console.log(`   store copy:  ${fmt(tCopy)} → rab ${x(tCopy / tRab)}×`)
  console.log(`   Array.push:  ${fmt(tArr)} (the JS-array control — PACKED_SMI lane)`)
}

// ── E. the sparse walk ─────────────────────────────────────────────────────
{
  // 2% survivors of N — the compaction shape (Task 210, group E)
  const SURV = Math.max(1, (N * 0.02) | 0)
  const ms = createMarkSet(N)
  const ids: number[] = []
  for (let i = 0; i < SURV; i++) {
    const id = ((i * 2654435761 + 1) >>> 0) % N
    if (!ms.has(id)) { ms.add(id); ids.push(id) }
  }
  let csW = 0, csF = 0
  const tW = bench('mark-walk', () => {
    csW = 0
    ms.forEachSparse(i => { csW += i })
  }, 60)
  const all = new Uint32Array(N)
  for (const id of ids) all[id] = 1
  const tF = bench('filter-push', () => {
    csF = 0
    const out: number[] = []
    for (let i = 0; i < N; i++) if (all[i] === 1) out.push(i)
    for (const i of out) csF += i
  }, 60)
  if (csW !== csF) fail(`sparse checksums differ (${csW} vs ${csF})`)
  console.log(`\nE. THE SPARSE WALK (${ids.length} survivors of ${N} — ${(100 * ids.length / N).toFixed(1)}%)`)
  console.log(`   MarkSet word-walk: ${fmt(tW)}`)
  console.log(`   array filter+push: ${fmt(tF)} → ${x(tF / tW)}×`)
}

// ── F. the dense delete ────────────────────────────────────────────────────
{
  const K = 2000
  const st = createStore([{ name: 'v', kind: 'u32' as const, width: 1 }], { capacity: N, growth: 'none' })
  st.resize(N)
  const sv = st.column('v') as Uint32Array
  for (let i = 0; i < N; i++) sv[i] = i
  const snapshot = new Uint32Array(N)
  snapshot.set(sv)
  const source: number[] = []
  for (let i = 0; i < N; i++) source.push(i)
  // Both lanes carry a MEMCPY-CLASS refill inside the timer (the bench
  // runs many passes; the records must come back) — the DELTA between
  // the lanes is the removal law itself: the O(1) move vs the O(n)
  // splice shifts.
  const tS = bench('swap-remove', () => {
    sv.set(snapshot)
    st.resize(N)
    for (let k = 0; k < K; k++) st.swapRemove((k * 97) % st.count)
  }, 20)
  const tA = bench('array-splice', () => {
    const arr = source.slice()
    for (let k = 0; k < K; k++) arr.splice((k * 97) % arr.length, 1)
  }, 20)
  console.log(`\nF. THE DENSE DELETE (${K} removals from ${N}, both lanes refill memcpy-class)`)
  console.log(`   store swapRemove: ${fmt(tS)}`)
  console.log(`   Array.splice:     ${fmt(tA)} → ${x(tA / tS)}× (order not preserved, by contract)`)
  // the multiset survives: after the bench's removal passes the store
  // holds a PERMUTATION of a subset — no id twice, the count honest
  st.swapRemove(0)
  const seen = new Uint32Array(N)
  let dup = false
  for (let i = 0; i < st.count; i++) if (++seen[sv[i]] > 1) { dup = true; break }
  if (dup) fail('swapRemove broke the multiset (an id survived twice)')
  if (st.count !== N - K - 1) fail(`count drift: ${st.count} ≠ ${N - K - 1}`)
}

// ── G. the bulk copy ───────────────────────────────────────────────────────
{
  const M = 4096
  const st = createStore([{ name: 'rec', kind: 'f32' as const, width: 12 }], { capacity: N, growth: 'none' })
  st.resize(N)
  const sv = st.column('rec') as Float32Array
  sv.set(rec)
  const tSet = bench('copy-records', () => {
    st.copyRecords(0, N - M, M)
  }, 40)
  const tLoop = bench('copy-loop', () => {
    for (let i = 0; i < M; i++) {
      const src = (N - M + i) * 12, dst = i * 12
      for (let k = 0; k < 12; k++) sv[dst + k] = rec[src + k]
    }
  }, 40)
  // checksum gate: both lanes carry the same bytes
  let csS = 0, csL = 0
  for (let i = 0; i < M; i++) {
    for (let k = 0; k < 12; k++) { csS += sv[i * 12 + k]; csL += rec[(N - M + i) * 12 + k] }
  }
  if (csS !== csL) fail(`bulk copy checksums differ (${csS} vs ${csL})`)
  console.log(`\nG. THE BULK COPY (${M} records × 48 B, checksum-gated)`)
  console.log(`   copyRecords (one set()): ${fmt(tSet)}`)
  console.log(`   per-element loop:        ${fmt(tLoop)} → ${x(tLoop / tSet)}×`)
}

console.log(`\n${allOk ? 'VERDICT: PASS — every lane measured, every checksum held' : 'VERDICT: FAIL — a gate broke'}`)
if (!allOk) process.exit(1)
