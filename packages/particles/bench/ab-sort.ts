/**
 * ab-sort.ts — THE SORT A/B (Task 176's bench-first probe).
 *
 * The roadmap's remaining CPU item: the painter's order at 100k+ alpha
 * layers. The current body is `indices.subarray().sort(cmp)` — a JS
 * comparator call per comparison (~1.7M calls at 100k) plus the facade's
 * per-frame copy loop into a JS array (the bakers' `order` is typed
 * `readonly number[]`). This bench measures three bodies over the SAME
 * seeded scenes, interleaved, medians:
 *
 *   A — CLASSIC: the shipped comparator subarray sort (the baseline).
 *   B — COMPOSITE: ONE Float64Array.sort() (no comparator — V8's CSA
 *       TimSort) over the packed 53-bit key: descFlip(f32 key) * 2^21 +
 *       (2^21−1 − slot). Distinct by construction → a total order, the
 *       SAME sequence as the comparator, exactly (ties land slot-desc).
 *   C — RADIX: 4 passes of 8-bit stable LSD over the descFlip bits,
 *       parallel index shuffle, input slot-descending.
 *
 * EXACTNESS is asserted first (the parity gate): all three bodies must
 * emit byte-identical index sequences on every size, including the
 * ±0-key and tie-heavy scenes. Then the timing.
 *
 * Run: bun packages/particles/bench/ab-sort.ts
 */

// ─── the shared bit machinery ─────────────────────────────────────────────

const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)
function keyBits(x: number): number {
  F32[0] = x
  return U32[0]
}
/** ascending-float-order flip → uint32; −0 canonicalized to +0 (the JS
 *  comparator treats them EQUAL — the tie must survive as a tie). */
function ascFlip(bits: number): number {
  if (bits === 0x80000000) bits = 0 // −0 → +0 (equal in JS compare)
  return (bits & 0x80000000) ? (~bits >>> 0) : (bits | 0x80000000)
}
/** descending-float-order flip: radix/sort ASCENDING on this = the key
 *  DESCENDING (the painter's order). NaN lands last (bits above +Inf →
 *  flip near zero) — deterministic, where the comparator's NaN is
 *  engine-defined garbage. */
function descFlip(bits: number): number {
  return (~ascFlip(bits)) >>> 0
}

// ─── the three bodies (each fills indices[0..count), keys[0..count)) ──────

function sortClassic(
  px: Float32Array, py: Float32Array, pz: Float32Array, count: number,
  fx: number, fy: number, fz: number,
  indices: Int32Array, keys: Float32Array,
): void {
  for (let i = 0; i < count; i++) {
    indices[i] = i
    keys[i] = fx * px[i] + fy * py[i] + fz * pz[i]
  }
  indices.subarray(0, count).sort((a, b) => keys[b] - keys[a] || b - a)
}

// module-level growable scratch for B/C (grows on demand, retained — the
// facade will own its own; the bench just needs the shape)
let compB = new Float64Array(1024)
function sortComposite(
  px: Float32Array, py: Float32Array, pz: Float32Array, count: number,
  fx: number, fy: number, fz: number,
  indices: Int32Array, keys: Float32Array,
): void {
  if (compB.length < count) compB = new Float64Array(count)
  const SHIFT = 2097152 // 2^21 — the slot low bits (count ≤ 2^21)
  const MASK = 2097151
  for (let i = 0; i < count; i++) {
    const k = fx * px[i] + fy * py[i] + fz * pz[i]
    keys[i] = k
    compB[i] = descFlip(keyBits(k)) * SHIFT + (MASK - i)
  }
  compB.subarray(0, count).sort() // no comparator — V8's native path
  for (let r = 0; r < count; r++) {
    const c = compB[r]
    indices[r] = MASK - (c % SHIFT)
  }
}

let k32C = new Uint32Array(1024)
let srcC = new Int32Array(1024)
let dstC = new Int32Array(1024)
let histC = new Uint32Array(256)
function sortRadix(
  px: Float32Array, py: Float32Array, pz: Float32Array, count: number,
  fx: number, fy: number, fz: number,
  indices: Int32Array, keys: Float32Array,
): void {
  if (k32C.length < count) { k32C = new Uint32Array(count); srcC = new Int32Array(count); dstC = new Int32Array(count) }
  // input slot-DESCENDING (ties must preserve it — the stable LSD keeps
  // input order within equal keys)
  for (let i = count - 1, j = 0; i >= 0; i--, j++) {
    const k = fx * px[i] + fy * py[i] + fz * pz[i]
    keys[i] = k
    k32C[j] = descFlip(keyBits(k))
    srcC[j] = i
  }
  let from = srcC, fromK = k32C
  let to = dstC, toK = new Uint32Array(count) // bench-local; prod reuses
  for (let pass = 0; pass < 4; pass++) {
    histC.fill(0)
    const shift = pass * 8
    for (let i = 0; i < count; i++) histC[(fromK[i] >>> shift) & 0xff]++
    let sum = 0
    for (let b = 0; b < 256; b++) { const h = histC[b]; histC[b] = sum; sum += h }
    for (let i = 0; i < count; i++) {
      const k = fromK[i]
      const bucket = (k >>> shift) & 0xff
      const at = histC[bucket]++
      to[at] = from[i]
      toK[at] = k
    }
    const ti = from; from = to; to = ti
    const tk = fromK; fromK = toK; toK = tk
  }
  // after 4 (even) passes the data is back in srcC/k32C — but the bench
  // must not depend on that: copy from `from`
  for (let r = 0; r < count; r++) indices[r] = from[r]
}

// ─── the parity gate (exactness before speed) ─────────────────────────────

function hashRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return ((s >>> 0) % 1000003) / 1000003
  }
}

function scene(n: number, seed: number): { px: Float32Array; py: Float32Array; pz: Float32Array } {
  const rnd = hashRng(seed)
  const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    px[i] = (rnd() * 2 - 1) * 50
    py[i] = (rnd() * 2 - 1) * 30
    pz[i] = (rnd() * 2 - 1) * 50
    if (i > 0 && (i & 15) === 0) { px[i] = px[i - 1]; py[i] = py[i - 1]; pz[i] = pz[i - 1] } // exact ties
  }
  return { px, py, pz }
}

const FWD = [0.26726124, 0.53452248, 0.80178373] // a realistic normalized camera forward

function parity(): void {
  const sizes = [1, 2, 3, 7, 100, 513, 2048, 10000]
  let cases = 0
  for (const n of sizes) {
    for (const seed of [1, 991, 4242]) {
      const { px, py, pz } = scene(n, seed)
      const a = new Int32Array(n), ka = new Float32Array(n)
      const b = new Int32Array(n), kb = new Float32Array(n)
      const c = new Int32Array(n), kc = new Float32Array(n)
      sortClassic(px, py, pz, n, FWD[0], FWD[1], FWD[2], a, ka)
      sortComposite(px, py, pz, n, FWD[0], FWD[1], FWD[2], b, kb)
      sortRadix(px, py, pz, n, FWD[0], FWD[1], FWD[2], c, kc)
      for (let i = 0; i < n; i++) {
        if (a[i] !== b[i] || a[i] !== c[i]) {
          throw new Error(`PARITY FAIL at n=${n} seed=${seed} rank=${i}: classic=${a[i]} composite=${b[i]} radix=${c[i]}`)
        }
        if (ka[i] !== kb[i] || ka[i] !== kc[i]) throw new Error(`KEY PARITY FAIL at n=${n} seed=${seed} slot=${i}`)
      }
      cases++
    }
  }
  // THE ±0 SCENE: forward all-negative, every particle at the origin →
  // every key is ±0 (JS compares them EQUAL — ties must break by slot).
  {
    const n = 64
    const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n)
    const fwdNeg = [-0.577, -0.577, -0.577]
    const a = new Int32Array(n), ka = new Float32Array(n)
    const b = new Int32Array(n), kb = new Float32Array(n)
    const c = new Int32Array(n), kc = new Float32Array(n)
    sortClassic(px, py, pz, n, fwdNeg[0], fwdNeg[1], fwdNeg[2], a, ka)
    sortComposite(px, py, pz, n, fwdNeg[0], fwdNeg[1], fwdNeg[2], b, kb)
    sortRadix(px, py, pz, n, fwdNeg[0], fwdNeg[1], fwdNeg[2], c, kc)
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i] || a[i] !== c[i]) throw new Error(`±0 PARITY FAIL rank=${i}: classic=${a[i]} composite=${b[i]} radix=${c[i]}`)
    }
    cases++
  }
  console.log(`parity: ${cases} cases — all three bodies byte-identical (incl. ±0 ties)`)
}

// ─── the timing (interleaved rounds, medians) ─────────────────────────────

const med = (xs: number[]) => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)]
function timeIt(reps: number, body: () => void): number {
  const t0 = performance.now()
  for (let r = 0; r < reps; r++) body()
  return performance.now() - t0
}

function bench(): void {
  const sizes = [256, 512, 1024, 2048, 4096, 16384, 65536, 100000, 200000]
  const rounds = 5
  console.log('n        classic    composite   radix     (ms/frame, median of 5 interleaved rounds)')
  for (const n of sizes) {
    const { px, py, pz } = scene(n, 7)
    const reps = n <= 4096 ? 200 : n <= 65536 ? 40 : 10
    const idx = new Int32Array(n), keys = new Float32Array(n)
    const tc: number[] = [], tb: number[] = [], tr: number[] = []
    for (let r = 0; r < rounds; r++) {
      tc.push(timeIt(reps, () => sortClassic(px, py, pz, n, FWD[0], FWD[1], FWD[2], idx, keys)))
      tb.push(timeIt(reps, () => sortComposite(px, py, pz, n, FWD[0], FWD[1], FWD[2], idx, keys)))
      tr.push(timeIt(reps, () => sortRadix(px, py, pz, n, FWD[0], FWD[1], FWD[2], idx, keys)))
    }
    const fmt = (x: number) => (x / reps).toFixed(3).padStart(8)
    console.log(`${String(n).padEnd(8)} ${fmt(med(tc))} ${fmt(med(tb))} ${fmt(med(tr))}`)
  }

  // THE FACADE COPY LOOP — what the per-frame sortOrder JS-array copy
  // costs at scale (the thing the ArrayLike order pass removes).
  for (const n of [16384, 100000]) {
    const src = new Int32Array(n)
    for (let i = 0; i < n; i++) src[i] = i
    const dst = new Array<number>(n).fill(0)
    const reps = 40
    const times: number[] = []
    for (let r = 0; r < 3; r++) {
      times.push(timeIt(reps, () => {
        for (let i = 0; i < n; i++) dst[i] = src[i]
        dst.length = n
      }))
    }
    console.log(`copy loop n=${n}: ${(med(times) / reps).toFixed(3)} ms/frame (the ArrayLike pass deletes this)`)
  }
}

parity()
bench()
