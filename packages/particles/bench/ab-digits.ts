/**
 * ab-digits.ts — THE RADIX DIGIT STUDY (Task 177, isolated).
 *
 * ab-staged measured the frame; this isolates THE RADIX alone over
 * pre-staged (flipped) key arrays — the digit-width crossover curve
 * that fixes the auto-selection threshold, plus the gather-vs-scatter
 * placement with tight reps. Parity is trivial here (a stable LSD's
 * digit split cannot change the total order — pinned in task177's core
 * gate anyway); this is pure timing.
 *
 * Run: bun packages/particles/bench/ab-digits.ts
 */

const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)
function ascFlip(bits: number): number {
  if (bits === 0x80000000) bits = 0
  return (bits & 0x80000000) ? (~bits >>> 0) : (bits | 0x80000000)
}
function descFlip(bits: number): number { return (~ascFlip(bits)) >>> 0 }

function hashRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return ((s >>> 0) % 1000003) / 1000003
  }
}
const FWD = [0.26726124, 0.53452248, 0.80178373]

/** Pre-stage: n flipped keys + the identity payload, slot-descending
 *  input (the staged walk's exact output shape). */
function stagedKeys(n: number, seed: number): { k: Uint32Array; id: Int32Array } {
  const rnd = hashRng(seed)
  const k = new Uint32Array(n), id = new Int32Array(n)
  const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    px[i] = (rnd() * 2 - 1) * 50; py[i] = (rnd() * 2 - 1) * 30; pz[i] = (rnd() * 2 - 1) * 50
  }
  for (let i = n - 1, j = 0; i >= 0; i--, j++) {
    const d = FWD[0] * px[i] + FWD[1] * py[i] + FWD[2] * pz[i]
    F32[0] = d
    k[j] = descFlip(U32[0])
    id[j] = i
  }
  return { k, id }
}

const HIST8 = new Uint32Array(256)
const HIST16 = new Uint32Array(65536)
const HIST11 = new Uint32Array(2048)

/** A generic stable LSD over (srcK, srcI) → (dstK, dstI) with the given
 *  shift/mask list. Pass 0's payload may come from the loop index
 *  (payloadIsIndex) — the identity never materializes. */
function lsd(
  n: number, shifts: number[], masks: number[], hist: Uint32Array, histN: number,
  srcK: Uint32Array, srcI: Int32Array, dstK: Uint32Array, dstI: Int32Array,
  payloadIsIndex: boolean,
): void {
  let fromK = srcK, toK = dstK
  let fromI = srcI, toI = dstI
  for (let p = 0; p < shifts.length; p++) {
    const shift = shifts[p], mask = masks[p]
    hist.fill(0)
    for (let i = 0; i < n; i++) hist[(fromK[i] >>> shift) & mask]++
    let sum = 0
    for (let b = 0; b < histN; b++) { const h = hist[b]; hist[b] = sum; sum += h }
    for (let i = 0; i < n; i++) {
      const key = fromK[i]
      const at = hist[(key >>> shift) & mask]++
      toK[at] = key
      toI[at] = payloadIsIndex && p === 0 ? i : fromI[i]
    }
    const swk = fromK; fromK = toK; toK = swk
    const swi = fromI; fromI = toI; toI = swi
  }
  // odd pass counts land the payload in dstI's ping partner — copy out
  if (fromI !== dstI) dstI.set(fromI.subarray(0, n), 0)
}

const med = (xs: number[]) => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)]
function timeIt(reps: number, body: () => void): number {
  const t0 = performance.now()
  for (let r = 0; r < reps; r++) body()
  return performance.now() - t0
}

console.log('── THE RADIX ALONE (ms, median of 7 interleaved) ──')
console.log('n        4x8-bit    3x11-bit   2x16-bit')
const sizes = [256, 1024, 4096, 8192, 16384, 32768, 65536, 100000, 200000]
for (const n of sizes) {
  const { k, id } = stagedKeys(n, 7)
  const kAlt = new Uint32Array(n), iAlt = new Int32Array(n)
  const kDst = new Uint32Array(n), iDst = new Int32Array(n)
  const reps = n <= 4096 ? 400 : n <= 16384 ? 150 : n <= 65536 ? 50 : 20
  const rounds = 7
  const t8: number[] = [], t11: number[] = [], t16: number[] = []
  for (let r = 0; r < rounds; r++) {
    t8.push(timeIt(reps, () => lsd(n, [0, 8, 16, 24], [0xff, 0xff, 0xff, 0xff], HIST8, 256, k, id, kAlt, iAlt, false)))
    t11.push(timeIt(reps, () => lsd(n, [0, 11, 22], [0x7ff, 0x7ff, 0x3ff], HIST11, 2048, k, id, kAlt, iAlt, false)))
    t16.push(timeIt(reps, () => lsd(n, [0, 16], [0xffff, 0xffff], HIST16, 65536, k, id, kDst, iDst, false)))
  }
  const fmt = (x: number) => (x / reps).toFixed(4).padStart(10)
  console.log(`${String(n).padEnd(8)} ${fmt(med(t8))} ${fmt(med(t11))} ${fmt(med(t16))}`)
}

console.log('── THE PLACEMENT ALONE (100k / 200k records, ms, median of 7) ──')
for (const n of [100000, 200000]) {
  const records = new Float32Array(n * 16)
  const out = new Float32Array(n * 16)
  const perm = new Int32Array(n)
  const inv = new Int32Array(n)
  for (let i = 0; i < n; i++) perm[i] = i
  // a painter-like permutation: sort perm by a shuffled key
  const rnd = hashRng(9)
  const kk = new Float64Array(n)
  for (let i = 0; i < n; i++) kk[i] = rnd()
  const order = Array.from(perm).sort((a, b) => kk[a] - kk[b])
  for (let r = 0; r < n; r++) perm[order[r]] = r
  const reps = 30, rounds = 7
  const tg: number[] = [], ts: number[] = []
  for (let r = 0; r < rounds; r++) {
    tg.push(timeIt(reps, () => {
      for (let r2 = 0; r2 < n; r2++) {
        const src = perm[r2] * 16, dst = r2 * 16
        for (let c = 0; c < 16; c++) out[dst + c] = records[src + c]
      }
    }))
    ts.push(timeIt(reps, () => {
      for (let r2 = 0; r2 < n; r2++) inv[perm[r2]] = r2
      for (let j = 0; j < n; j++) {
        const dst = inv[j] * 16, src = j * 16
        for (let c = 0; c < 16; c++) out[dst + c] = records[src + c]
      }
    }))
  }
  console.log(`n=${n}: gather ${(med(tg) / reps).toFixed(3)} ms   scatter(+inv) ${(med(ts) / reps).toFixed(3)} ms`)
}
