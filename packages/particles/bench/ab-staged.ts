/**
 * ab-staged.ts — THE STAGED BAKE A/B (Task 177's bench-first probe).
 *
 * The journal's named frontier after Task 176: "the remaining ~11 ms
 * gather physics of the sorted layer at the ceiling". The shipped frame
 * walks the painter's order (the radix output) through the baker — a
 * RANDOM gather over ~14 SoA streams (each 4-byte read its own cache
 * line at 100k: a 5.6 MiB working set, L3 territory) + sequential
 * writes. Measured in situ: the sorted 100k instance layer pays
 * 12.95 ms/frame where its unsorted twin pays 3.22 — the delta 9.73 =
 * the radix (~6.3) + the gather physics (~3.4).
 *
 * THE STAGED SHAPE under test — the permutation moves to the RECORD
 * level, where it is ONE 64-byte line instead of fourteen 4-byte reads:
 *   1. THE STAGE (sequential, slot-DESCENDING — the walk that makes the
 *      stable LSD's tie-break land slot-descending, the comparator's
 *      rule): the frustum gate + the ramp sample + the zero-size skip
 *      run over SoA in perfect streaming order; each SURVIVOR's
 *      16-float record lands sequentially in `records` and its flipped
 *      depth key in `k` (both caller-owned). The sort input shrinks to
 *      the survivors (the shipped shape sorts every live slot, culled
 *      ones included).
 *   2. THE RADIX (over the survivors, payload = the compacted stage
 *      position): pass 0's payload is the loop index itself — no
 *      identity array ever materializes. Digit-width variants measured:
 *      the shipped 4×8-bit, a 2×16-bit (65536 counters, 256 KiB), and a
 *      3×11-bit (2048 counters, 8 KiB, odd pass count → one n×4B
 *      copy-out).
 *   3. THE PLACEMENT: either a GATHER (`out[r] ← records[perm[r]]` —
 *      random full-line reads, sequential writes) or a SCATTER
 *      (`out[inv[j]] ← records[j]` — sequential reads, random full-line
 *      writes; the inverse permutation rides the free ping-pong buffer).
 *
 * PARITY FIRST (the gate): the staged frame's output stream must be
 * BYTE-IDENTICAL to the shipped frame's (the real sortBackToFront +
 * the real packInstances) across sizes × seeds × scenes — plain,
 * tie-heavy, culled, zero-size, atlas-on, ±0-keys. Then the timing.
 *
 * Run: bun packages/particles/bench/ab-staged.ts
 */

import { sortBackToFront, sphereOutsideFrustum } from '@rune/core'
import { packInstances, INSTANCE_STRIDE } from '../src/instances.ts'
import { createRamp } from '../src/index.ts'
import { flatRamp } from '../src/ramp.ts'
import type { ParticleSource } from '../src/system.ts'

// ─── the shared bit machinery (ab-sort's, verbatim) ───────────────────────

const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)
function keyBits(x: number): number {
  F32[0] = x
  return U32[0]
}
function ascFlip(bits: number): number {
  if (bits === 0x80000000) bits = 0
  return (bits & 0x80000000) ? (~bits >>> 0) : (bits | 0x80000000)
}
function descFlip(bits: number): number {
  return (~ascFlip(bits)) >>> 0
}

// ─── the scene (a full 14-field SoA store + the etalon's ramp) ────────────

const RAMP = createRamp([
  { t: 0, size: 0.4, r: 1, g: 0.9, b: 0.7, a: 0 },
  { t: 0.15, size: 1, r: 1, g: 0.95, b: 0.85, a: 1 },
  { t: 1, size: 0.15, r: 0.4, g: 0.6, b: 1, a: 0 },
])
const RAMP_FLAT = flatRamp(RAMP)

function hashRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return ((s >>> 0) % 1000003) / 1000003
  }
}

type Flavor = 'plain' | 'ties' | 'culled' | 'zeros' | 'origin'

function scene(n: number, seed: number, flavor: Flavor): ParticleSource & { fields: Record<string, Float32Array> } {
  const rnd = hashRng(seed)
  const f: Record<string, Float32Array> = {
    px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n),
    vx: new Float32Array(n), vy: new Float32Array(n), vz: new Float32Array(n),
    age: new Float32Array(n), life: new Float32Array(n), size: new Float32Array(n),
    cr: new Float32Array(n), cg: new Float32Array(n), cb: new Float32Array(n), ca: new Float32Array(n),
    seed: new Float32Array(n),
    tx: new Float32Array(n), ty: new Float32Array(n), tz: new Float32Array(n),
  }
  for (let i = 0; i < n; i++) {
    f.px[i] = (rnd() * 2 - 1) * 50
    f.py[i] = (rnd() * 2 - 1) * 30
    f.pz[i] = (rnd() * 2 - 1) * 50
    if (flavor === 'origin') { f.px[i] = 0; f.py[i] = 0; f.pz[i] = 0 }
    if (i > 0 && (i & 15) === 0 && flavor === 'ties') { f.px[i] = f.px[i - 1]; f.py[i] = f.py[i - 1]; f.pz[i] = f.pz[i - 1] }
    f.vx[i] = rnd() * 6 - 3; f.vy[i] = rnd() * 6 - 3; f.vz[i] = rnd() * 6 - 3
    f.life[i] = 1.2 + rnd() * 1.0
    f.age[i] = rnd() * f.life[i]
    f.size[i] = 0.05 + rnd() * 0.07
    if (flavor === 'zeros' && (i % 7) === 3) f.size[i] = 0
    f.cr[i] = rnd(); f.cg[i] = rnd(); f.cb[i] = rnd(); f.ca[i] = 0.5 + rnd() * 0.5
    f.seed[i] = rnd()
    f.tx[i] = f.px[i]; f.ty[i] = f.py[i]; f.tz[i] = f.pz[i]
  }
  return { count: n, fields: f as unknown as ParticleSource['fields'] } as ParticleSource & { fields: Record<string, Float32Array> }
}

// A tight box frustum around the scene center (inward normals —
// sphereOutsideFrustum's convention: outside when dot(n, p) + d <= −r).
function boxFrustum(hx: number, hy: number, hz: number): Float32Array {
  return new Float32Array([
    1, 0, 0, hx, -1, 0, 0, hx,
    0, 1, 0, hy, 0, -1, 0, hy,
    0, 0, 1, hz, 0, 0, -1, hz,
  ])
}
// The culled scene's frustum: a small window — roughly half the cloud.
const CULL_FRUSTUM = boxFrustum(12, 9, 12)

const FWD = [0.26726124, 0.53452248, 0.80178373]
const FWD_NEG = [-0.577, -0.577, -0.577]

interface Opts {
  forward: readonly number[]
  frustum: Float32Array | null
  tiles?: readonly [number, number]
  frameJitter?: number
}

// ─── BODY A — THE SHIPPED FRAME (the real core sort + the real baker) ─────

function shippedFrame(
  sys: ParticleSource, out: Float32Array, scratch: { indices: Int32Array; keys: Float32Array; k: Uint32Array; kAlt: Uint32Array; iAlt: Int32Array },
  o: Opts,
): number {
  const n = sortBackToFront(sys.fields.px, sys.fields.py, sys.fields.pz, sys.count, o.forward, scratch.indices, scratch.keys, scratch)
  const order = n === scratch.indices.length ? scratch.indices : scratch.indices.subarray(0, n)
  return packInstances(sys, out, { ramp: RAMP, order, frustum: o.frustum, tiles: o.tiles, frameJitter: o.frameJitter, cullRadiusK: 0.5 })
}

// ─── BODY B — THE STAGED FRAME (the candidate) ────────────────────────────

type Digits = '8' | '16' | '11'
type Place = 'gather' | 'scatter'

/** The module-level digit-wide histograms (fixed consts, never grow). */
const HIST8 = new Uint32Array(256)
const HIST16 = new Uint32Array(65536)
const HIST11 = new Uint32Array(2048)

function stagedFrame(
  sys: ParticleSource, out: Float32Array,
  s: { records: Float32Array; indices: Int32Array; k: Uint32Array; kAlt: Uint32Array; iAlt: Int32Array },
  o: Opts, digits: Digits, place: Place,
): number {
  const f = sys.fields
  const count = sys.count
  const rampFlat = RAMP_FLAT
  const rampN = rampFlat.length / 7
  const rampLast = (rampN - 1) * 7
  const frustum = o.frustum
  const tiles = o.tiles
  const useAtlas = tiles !== undefined
  const tileU = useAtlas ? tiles![0] : 1
  const tileV = useAtlas ? tiles![1] : 1
  const maxFrame = tileU * tileV - 1
  const frameJitter = o.frameJitter ?? 0
  const fx = o.forward[0], fy = o.forward[1], fz = o.forward[2]
  const records = s.records
  const k = s.k
  const st: Float32Array = STAGE_SCRATCH
  let n = 0

  // 1. THE STAGE — slot-DESCENDING (the tie-break carrier: the stable
  //    LSD keeps this input order within equal keys → slot-desc ties).
  //    The record body is packInstances' verbatim math; the key is
  //    sortBackToFront's verbatim expression (bit-identical floats).
  for (let i = count - 1; i >= 0; i--) {
    if (frustum !== null && sphereOutsideFrustum(frustum, f.px[i], f.py[i], f.pz[i], f.size[i] * 0.5)) continue
    const age = f.age[i]
    const life = f.life[i]
    const t = life > 0 ? age / life : 0
    if (rampN === 1 || t <= rampFlat[0]) {
      st[0] = rampFlat[1]; st[1] = rampFlat[2]; st[2] = rampFlat[3]; st[3] = rampFlat[4]; st[4] = rampFlat[5]; st[5] = rampFlat[6]
    } else if (t >= rampFlat[rampLast]) {
      st[0] = rampFlat[rampLast + 1]; st[1] = rampFlat[rampLast + 2]; st[2] = rampFlat[rampLast + 3]
      st[3] = rampFlat[rampLast + 4]; st[4] = rampFlat[rampLast + 5]; st[5] = rampFlat[rampLast + 6]
    } else {
      let lo = 0, hi = rampN - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (rampFlat[mid * 7] <= t) lo = mid
        else hi = mid
      }
      const a = lo * 7, b = hi * 7
      const span = rampFlat[b] - rampFlat[a]
      const kk = span > 0 ? (t - rampFlat[a]) / span : 0
      st[0] = rampFlat[a + 1] + (rampFlat[b + 1] - rampFlat[a + 1]) * kk
      st[1] = rampFlat[a + 2] + (rampFlat[b + 2] - rampFlat[a + 2]) * kk
      st[2] = rampFlat[a + 3] + (rampFlat[b + 3] - rampFlat[a + 3]) * kk
      st[3] = rampFlat[a + 4] + (rampFlat[b + 4] - rampFlat[a + 4]) * kk
      st[4] = rampFlat[a + 5] + (rampFlat[b + 5] - rampFlat[a + 5]) * kk
      st[5] = rampFlat[a + 6] + (rampFlat[b + 6] - rampFlat[a + 6]) * kk
    }
    const half = f.size[i] * st[0] * 0.5
    if (half <= 0) continue
    let u0 = 0, v0 = 0
    if (useAtlas) {
      let frame = Math.floor(st[5] + (frameJitter > 0 ? f.seed[i] * frameJitter : 0))
      if (!Number.isFinite(frame)) frame = 0
      if (frame < 0) frame = 0
      if (frame > maxFrame) frame = maxFrame
      u0 = (frame % tileU) / tileU
      v0 = Math.floor(frame / tileU) / tileV
    }
    const at = n * INSTANCE_STRIDE
    records[at] = f.px[i]; records[at + 1] = f.py[i]; records[at + 2] = f.pz[i]
    records[at + 3] = f.vx[i]; records[at + 4] = f.vy[i]; records[at + 5] = f.vz[i]
    records[at + 6] = f.cr[i] * st[1]; records[at + 7] = f.cg[i] * st[2]
    records[at + 8] = f.cb[i] * st[3]; records[at + 9] = f.ca[i] * st[4]
    records[at + 10] = half
    records[at + 11] = f.seed[i] * 6.283185307179586
    records[at + 12] = age
    records[at + 13] = f.seed[i]
    records[at + 14] = u0; records[at + 15] = v0
    const d = fx * f.px[i] + fy * f.py[i] + fz * f.pz[i]
    F32[0] = d
    k[n] = descFlip(U32[0])
    n++
  }
  if (n <= 1) {
    if (n === 1) { for (let c = 0; c < INSTANCE_STRIDE; c++) out[c] = records[c] }
    return n
  }

  // 2. THE RADIX — over the survivors; payload = the compacted stage
  //    position. Pass 0's payload is the loop index (no identity array
  //    ever exists). Even pass counts land in (k, indices).
  const kAlt = s.kAlt
  const iAlt = s.iAlt
  const indices = s.indices
  if (digits === '16') {
    // two 16-bit passes
    HIST16.fill(0)
    for (let i = 0; i < n; i++) HIST16[k[i] & 0xffff]++
    let sum = 0
    for (let b = 0; b < 65536; b++) { const h = HIST16[b]; HIST16[b] = sum; sum += h }
    for (let i = 0; i < n; i++) {
      const key = k[i]
      const at = HIST16[key & 0xffff]++
      kAlt[at] = key
      iAlt[at] = i
    }
    HIST16.fill(0)
    for (let i = 0; i < n; i++) HIST16[kAlt[i] >>> 16]++
    sum = 0
    for (let b = 0; b < 65536; b++) { const h = HIST16[b]; HIST16[b] = sum; sum += h }
    for (let i = 0; i < n; i++) {
      const key = kAlt[i]
      const at = HIST16[key >>> 16]++
      k[at] = key
      indices[at] = iAlt[i]
    }
  } else if (digits === '11') {
    // three 11-bit passes (11/11/10 = 32) — odd count: the payload ends
    // in iAlt; one n×4B copy-out returns the contract to `indices`.
    let fromK: Uint32Array = k, toK: Uint32Array = kAlt
    let fromI: Int32Array = iAlt, toI: Int32Array = indices
    // pass 0 — payload from the loop index (iAlt is pass-0's target)
    fromI = iAlt; toI = indices
    HIST11.fill(0)
    for (let i = 0; i < n; i++) HIST11[k[i] & 0x7ff]++
    { let sum = 0; for (let b = 0; b < 2048; b++) { const h = HIST11[b]; HIST11[b] = sum; sum += h } }
    for (let i = 0; i < n; i++) {
      const key = k[i]
      const at = HIST11[key & 0x7ff]++
      kAlt[at] = key
      iAlt[at] = i
    }
    // passes 1..2 — the generic ping-pong
    const shifts = [11, 22], masks = [0x7ff, 0x3ff]
    fromK = kAlt; fromI = iAlt
    toK = k; toI = indices
    for (let p = 0; p < 2; p++) {
      const shift = shifts[p], mask = masks[p]
      HIST11.fill(0)
      for (let i = 0; i < n; i++) HIST11[(fromK[i] >>> shift) & mask]++
      let sum = 0
      for (let b = 0; b < 2048; b++) { const h = HIST11[b]; HIST11[b] = sum; sum += h }
      for (let i = 0; i < n; i++) {
        const key = fromK[i]
        const at = HIST11[(key >>> shift) & mask]++
        toK[at] = key
        toI[at] = fromI[i]
      }
      const swk = fromK; fromK = toK; toK = swk
      const swi = fromI; fromI = toI; toI = swi
    }
    // odd count → the payload sits in `indices` (pass 2's target was
    // indices... track it honestly):
    //   pass 0: (k → kAlt, index → iAlt)
    //   pass 1: (kAlt → k, iAlt → indices)
    //   pass 2: (k → kAlt, indices → iAlt)
    // → final payload in iAlt; copy out.
    indices.set(iAlt.subarray(0, n), 0)
  } else {
    // four 8-bit passes — the shipped body (the tie-break carrier rides
    // the same stability discipline)
    let fromK: Uint32Array = k, toK: Uint32Array = kAlt
    let fromI: Int32Array = iAlt, toI: Int32Array = indices
    // pass 0 — payload from the loop index
    HIST8.fill(0)
    for (let i = 0; i < n; i++) HIST8[k[i] & 0xff]++
    { let sum = 0; for (let b = 0; b < 256; b++) { const h = HIST8[b]; HIST8[b] = sum; sum += h } }
    for (let i = 0; i < n; i++) {
      const key = k[i]
      const at = HIST8[key & 0xff]++
      kAlt[at] = key
      iAlt[at] = i
    }
    fromK = kAlt; fromI = iAlt; toK = k; toI = indices
    for (let pass = 1; pass < 4; pass++) {
      const shift = pass * 8
      HIST8.fill(0)
      for (let i = 0; i < n; i++) HIST8[(fromK[i] >>> shift) & 0xff]++
      let sum = 0
      for (let b = 0; b < 256; b++) { const h = HIST8[b]; HIST8[b] = sum; sum += h }
      for (let i = 0; i < n; i++) {
        const key = fromK[i]
        const at = HIST8[(key >>> shift) & 0xff]++
        toK[at] = key
        toI[at] = fromI[i]
      }
      const swk = fromK; fromK = toK; toK = swk
      const swi = fromI; fromI = toI; toI = swi
    }
    // 4 passes from (k, identity): p0 →(kAlt,iAlt), p1 →(k,indices),
    // p2 →(kAlt,iAlt), p3 →(k,indices) — even: the payload is in
    // `indices` already. No copy.
  }

  // 3. THE PLACEMENT — the record-level permutation (one 64-byte line
  //    per record instead of fourteen 4-byte gathers).
  if (place === 'gather') {
    for (let r = 0; r < n; r++) {
      const src = indices[r] * INSTANCE_STRIDE
      const dst = r * INSTANCE_STRIDE
      out[dst] = records[src]
      out[dst + 1] = records[src + 1]
      out[dst + 2] = records[src + 2]
      out[dst + 3] = records[src + 3]
      out[dst + 4] = records[src + 4]
      out[dst + 5] = records[src + 5]
      out[dst + 6] = records[src + 6]
      out[dst + 7] = records[src + 7]
      out[dst + 8] = records[src + 8]
      out[dst + 9] = records[src + 9]
      out[dst + 10] = records[src + 10]
      out[dst + 11] = records[src + 11]
      out[dst + 12] = records[src + 12]
      out[dst + 13] = records[src + 13]
      out[dst + 14] = records[src + 14]
      out[dst + 15] = records[src + 15]
    }
  } else {
    // the scatter: invert the permutation into the free ping-pong buffer
    const inv = iAlt
    for (let r = 0; r < n; r++) inv[indices[r]] = r
    for (let j = 0; j < n; j++) {
      const dst = inv[j] * INSTANCE_STRIDE
      const src = j * INSTANCE_STRIDE
      out[dst] = records[src]
      out[dst + 1] = records[src + 1]
      out[dst + 2] = records[src + 2]
      out[dst + 3] = records[src + 3]
      out[dst + 4] = records[src + 4]
      out[dst + 5] = records[src + 5]
      out[dst + 6] = records[src + 6]
      out[dst + 7] = records[src + 7]
      out[dst + 8] = records[src + 8]
      out[dst + 9] = records[src + 9]
      out[dst + 10] = records[src + 10]
      out[dst + 11] = records[src + 11]
      out[dst + 12] = records[src + 12]
      out[dst + 13] = records[src + 13]
      out[dst + 14] = records[src + 14]
      out[dst + 15] = records[src + 15]
    }
  }
  return n
}

const STAGE_SCRATCH = new Float32Array(6)

// ─── THE PARITY GATE (exactness before speed) ─────────────────────────────

function parity(): void {
  const sizes = [1, 2, 3, 7, 64, 100, 513, 2048, 10000]
  const flavors: Flavor[] = ['plain', 'ties', 'culled', 'zeros', 'origin']
  const optSets: Opts[] = [
    { forward: FWD, frustum: null },
    { forward: FWD, frustum: CULL_FRUSTUM },
    { forward: FWD, frustum: null, tiles: [4, 4], frameJitter: 1 },
    { forward: FWD_NEG, frustum: null },
  ]
  let cases = 0
  for (const n of sizes) {
    for (const seed of [1, 991, 4242]) {
      for (const flavor of flavors) {
        for (const oi in optSets) {
          const o = optSets[oi]
          const sys = scene(n, seed, flavor)
          const outA = new Float32Array(n * INSTANCE_STRIDE + 16)
          const outB = new Float32Array(n * INSTANCE_STRIDE + 16)
          const sc = {
            indices: new Int32Array(n + 1), keys: new Float32Array(n + 1),
            k: new Uint32Array(n + 1), kAlt: new Uint32Array(n + 1), iAlt: new Int32Array(n + 1),
            records: new Float32Array((n + 1) * INSTANCE_STRIDE),
          }
          const nA = shippedFrame(sys, outA, sc, o)
          for (const digits of ['8', '16', '11'] as Digits[]) {
            for (const place of ['gather', 'scatter'] as Place[]) {
              outB.fill(0)
              const nB = stagedFrame(sys, outB, sc, o, digits, place)
              if (nA !== nB) {
                throw new Error(`PARITY COUNT FAIL n=${n} seed=${seed} ${flavor} opts=${oi} digits=${digits} place=${place}: ${nA} vs ${nB}`)
              }
              for (let i = 0; i < nA * INSTANCE_STRIDE; i++) {
                if (outA[i] !== outB[i]) {
                  throw new Error(`PARITY BYTE FAIL n=${n} seed=${seed} ${flavor} opts=${oi} digits=${digits} place=${place} at=${i}: ${outA[i]} vs ${outB[i]}`)
                }
              }
              cases++
            }
          }
        }
      }
    }
  }
  console.log(`parity: ${cases} cases — the staged frame (3 digit widths × 2 placements) is byte-identical to the shipped frame (incl. ties, culled, zero-size, atlas, ±0)`)
}

// ─── THE TIMING (interleaved rounds, medians) ─────────────────────────────

const med = (xs: number[]) => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)]
function timeIt(reps: number, body: () => void): number {
  const t0 = performance.now()
  for (let r = 0; r < reps; r++) body()
  return performance.now() - t0
}

function bench(): void {
  const sizes = [4096, 16384, 65536, 100000, 200000]
  const rounds = 5
  console.log('── THE FRAME (ms/frame, median of 5 interleaved) ──')
  console.log('n        shipped    staged-8g  staged-16g staged-16s staged-11g (g=gather, s=scatter)')
  for (const n of sizes) {
    const sys = scene(n, 7, 'plain')
    const o: Opts = { forward: FWD, frustum: null }
    const out = new Float32Array(n * INSTANCE_STRIDE)
    const sc = {
      indices: new Int32Array(n), keys: new Float32Array(n),
      k: new Uint32Array(n), kAlt: new Uint32Array(n), iAlt: new Int32Array(n),
      records: new Float32Array(n * INSTANCE_STRIDE),
    }
    const reps = n <= 16384 ? 60 : n <= 65536 ? 25 : 10
    const tA: number[] = [], tB8: number[] = [], tB16g: number[] = [], tB16s: number[] = [], tB11: number[] = []
    for (let r = 0; r < rounds; r++) {
      tA.push(timeIt(reps, () => { shippedFrame(sys, out, sc, o) }))
      tB8.push(timeIt(reps, () => { stagedFrame(sys, out, sc, o, '8', 'gather') }))
      tB16g.push(timeIt(reps, () => { stagedFrame(sys, out, sc, o, '16', 'gather') }))
      tB16s.push(timeIt(reps, () => { stagedFrame(sys, out, sc, o, '16', 'scatter') }))
      tB11.push(timeIt(reps, () => { stagedFrame(sys, out, sc, o, '11', 'gather') }))
    }
    const fmt = (x: number) => (x / reps).toFixed(3).padStart(10)
    console.log(`${String(n).padEnd(8)} ${fmt(med(tA))} ${fmt(med(tB8))} ${fmt(med(tB16g))} ${fmt(med(tB16s))} ${fmt(med(tB11))}`)
  }

  // THE CULLED FRAME — the staged shape sorts survivors only; the
  // shipped shape sorts every live slot. Half the cloud off-screen.
  console.log('── THE CULLED FRAME (half off-screen) ──')
  for (const n of [65536, 100000]) {
    const sys = scene(n, 7, 'culled')
    const o: Opts = { forward: FWD, frustum: CULL_FRUSTUM }
    const out = new Float32Array(n * INSTANCE_STRIDE)
    const sc = {
      indices: new Int32Array(n), keys: new Float32Array(n),
      k: new Uint32Array(n), kAlt: new Uint32Array(n), iAlt: new Int32Array(n),
      records: new Float32Array(n * INSTANCE_STRIDE),
    }
    const reps = 20
    const tA: number[] = [], tB: number[] = []
    for (let r = 0; r < rounds; r++) {
      tA.push(timeIt(reps, () => { shippedFrame(sys, out, sc, o) }))
      tB.push(timeIt(reps, () => { stagedFrame(sys, out, sc, o, '16', 'gather') }))
    }
    console.log(`${String(n).padEnd(8)} shipped ${(med(tA) / reps).toFixed(3).padStart(8)} ms   staged-16g ${(med(tB) / reps).toFixed(3).padStart(8)} ms`)
  }

  // ── THE ATTRIBUTION (100k, the pieces) ──
  console.log('── THE ATTRIBUTION (100k plain, ms/pass) ──')
  {
    const n = 100000
    const sys = scene(n, 7, 'plain')
    const o: Opts = { forward: FWD, frustum: null }
    const out = new Float32Array(n * INSTANCE_STRIDE)
    const sc = {
      indices: new Int32Array(n), keys: new Float32Array(n),
      k: new Uint32Array(n), kAlt: new Uint32Array(n), iAlt: new Int32Array(n),
      records: new Float32Array(n * INSTANCE_STRIDE),
    }
    const reps = 20
    const one = (label: string, body: () => void) => {
      const ts: number[] = []
      for (let r = 0; r < rounds; r++) ts.push(timeIt(reps, body))
      console.log(`  ${label.padEnd(34)} ${(med(ts) / reps).toFixed(3)} ms`)
    }
    // the unsorted twin (the floor)
    one('sequential pack (no order)', () => { packInstances(sys, out, { ramp: RAMP }) })
    // the ordered gather (the shipped bake)
    one('sortBackToFront (radix 4x8)', () => { sortBackToFront(sys.fields.px, sys.fields.py, sys.fields.pz, n, FWD, sc.indices, sc.keys, sc) })
    one('packInstances with order', () => {
      const m = sortBackToFront(sys.fields.px, sys.fields.py, sys.fields.pz, n, FWD, sc.indices, sc.keys, sc)
      packInstances(sys, out, { ramp: RAMP, order: sc.indices.subarray(0, m) })
    })
    one('stagedFrame 8/gather', () => { stagedFrame(sys, out, sc, o, '8', 'gather') })
    one('stagedFrame 16/gather', () => { stagedFrame(sys, out, sc, o, '16', 'gather') })
    one('stagedFrame 16/scatter', () => { stagedFrame(sys, out, sc, o, '16', 'scatter') })
    one('stagedFrame 11/gather', () => { stagedFrame(sys, out, sc, o, '11', 'gather') })
  }
}

parity()
bench()
