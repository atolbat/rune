/**
 * sort.ts — the painter's order as a pure SoA function (Task 141).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY HERE: the back-to-front depth sort was @rune/particles' sort.ts over
 * its own ParticleFields — but the painter's algorithm is the property of
 * every alpha-blended, depth-less renderer: sprites, instanced quads,
 * transparent batches, impostors. The abstraction is the SoA form (three
 * position arrays + the camera forward), not the particle store — the
 * consumer wrapper stays with its consumer (@rune/particles'
 * sortDepthBackToFront delegates here).
 *
 * THE KEY: depth = dot(forward, position) — the camera basis's forward
 * (the unit direction the camera LOOKS). The dot product grows
 * monotonically with the view-axis depth, so a camera-consistent ordering
 * needs no eye position, no matrices, and no per-element sqrt.
 *
 * THE ORDER: BACK TO FRONT — the key DESCENDING (the farthest element
 * first). The sorted index list feeds the consumer's draw order.
 *
 * DETERMINISM: the comparator breaks ties by the slot index (a total
 * order), so the sequence is engine-independent — the same arrays and
 * camera basis produce the same draw order on every backend, every
 * engine, every run (the parity contract). Both tiers below are exact
 * realizations of that total order (byte-identical outputs — pinned).
 *
 * ─── Task 176 — THE RADIX TIER (the 100k+ alpha layer) ────────────────────
 * The classic body was `indices.subarray().sort(cmp)` — a JS comparator
 * call per comparison, ~1.7M calls at 100k, measured at 32 ms/frame on
 * the bench core (the etalon set never saw it — the sort was invisible
 * to every scenario). The radix tier replaces it with a stable LSD over
 * the IEEE-754 bit-flip of the f32 key (Task 176: four 8-bit passes;
 * Task 177 — THE DIGIT TIER: the pass COUNT is the cost driver, so the
 * digit width buys passes — two 16-bit passes at RADIX_16BIT_MIN and
 * up, three 11-bit passes below):
 *
 *   • THE FLIP: the float's bits are mapped to a uint32 whose ascending
 *     order is the float's DESCENDING order (the painter's order — so
 *     the LSD's ascending scatter IS the answer). −0 is canonicalized
 *     to +0 first: JS compares them EQUAL, so a ±0-key tie must SURVIVE
 *     as a tie and fall to the slot rule (the classic tier does).
 *   • THE TIE-BREAK: the LSD is stable, so equal keys keep the input
 *     order — the input is walked slot-DESCENDING, and ties come out
 *     slot-descending, the comparator's exact rule.
 *   • THE SCRATCH: the ping-pong (k/kAlt, the caller's indices + iAlt)
 *     is CALLER-OWNED (the frustumScratch precedent) — pass `aux` and
 *     the radix runs; omit it and the classic comparator tier runs
 *     verbatim (the zero-dependency path, byte-identical output, just
 *     slower at scale — every pre-176 caller keeps working unchanged).
 *     The even pass counts land the answer back in the caller's
 *     `indices`; the odd 3-pass branch pays one count×4B copy-out. The
 *     histograms (65536 and 2048 counters) are fixed module consts.
 *
 * MEASURED (bench/ab-sort.ts, interleaved, medians): radix wins at EVERY
 * size — 0.015 vs 0.023 ms at 256, 1.05 vs 4.34 at 16k, 6.66 vs 32.2 at
 * 100k (−79%), 13.4 vs 69.4 at 200k. The composite single-sort shape
 * (one Float64Array.sort() over packed 53-bit keys) was measured between
 * the two and REJECTED — radix dominated it at every size too.
 * Task 177 (bench/ab-digits.ts, the radix isolated): the digit tier took
 * the radix's own 7.2 → 3.9 ms at 100k and 14.6 → 7.9 at 200k.
 *
 * NaN (out of contract — spawn validation rejects non-finite): the
 * comparator's NaN is an inconsistent comparator (engine-defined
 * garbage); the radix is deterministic (NaN keys land just before +Inf).
 *
 * DOM-free by construction — like all of @rune/core.
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * The radix tier's scratch (Task 176) — caller-owned ping-pong buffers,
 * allocated once at capacity and reused every frame (the
 * zero-per-frame-allocation contract). Pass to `sortBackToFront`'s `aux`.
 * All three must be at least `count` long; the classic tier runs if they
 * are not (or if `aux` is omitted).
 */
export interface SortScratch {
  /** The pass-0 key-bits source; also where the even pass counts land
   *  back (with `indices`) after the ping-pong. */
  readonly k: Uint32Array
  /** The scatter target for the key bits (odd passes). */
  readonly kAlt: Uint32Array
  /** The scatter target for the indices (odd passes; the even passes
   *  scatter into the caller's `indices` itself). */
  readonly iAlt: Int32Array
}

/** The digit tier's auto-selection threshold (Task 177) — at/above
 *  this count the 2×16-bit passes run (the 65536-counter histogram's
 *  ~0.1 ms fixed fill+scan has amortized); below it the 3×11-bit passes
 *  (2048 counters, an 8 KiB L1 span, ~10 µs fixed). Measured crossover
 *  in bench/ab-digits: 16-bit wins clearly from 8192 up, 11-bit wins
 *  below 4096. The choice is PERF-ONLY — both digit splits are stable
 *  LSDs over the same flipped words, so the total order (and the output
 *  bytes) cannot differ (pinned across the boundary in sort177). */
export const RADIX_16BIT_MIN = 8192

/** The digit tier's histograms — module consts, never grow, never
 *  allocate. HIST16 (65536 × 4 B = 256 KiB) serves the wide passes;
 *  HIST11 (2048 × 4 B = 8 KiB) the narrow ones. The Task-176 8-bit
 *  body (256 counters, four passes) is RETIRED: every pass is a full
 *  sequential read + random-write scatter over the ping-pong, so the
 *  pass COUNT is the cost driver — 2 or 3 passes beat 4 at every size
 *  (measured, ab-digits: 7.2 → 3.9 ms at 100k, 14.6 → 7.9 at 200k). */
const HIST16 = new Uint32Array(65536)
const HIST11 = new Uint32Array(2048)

/** The single-word bit-cast view pair (float ↔ its IEEE-754 bits). */
const BIT_F32 = new Float32Array(1)
const BIT_U32 = new Uint32Array(BIT_F32.buffer)

/** Sorts the live [0, count) elements BACK TO FRONT (far first) by the
 *  camera-basis forward axis, over SoA position arrays. Writes the
 *  descending-depth index sequence into `indices[0..count)` (caller-owned,
 *  at least `count` long) and the raw f32 depth keys into `keys[0..count)`
 *  (slot-indexed — `keys[slot] = dot(forward, position)`) and returns
 *  `count`. Deterministic, zero allocations per frame (the radix tier's
 *  ping-pong is the caller's `aux`; without `aux` the classic comparator
 *  tier runs — identical output, slower at 100k+). */
export function sortBackToFront(
  px: Float32Array,
  py: Float32Array,
  pz: Float32Array,
  count: number,
  forward: readonly number[],
  indices: Int32Array,
  keys: Float32Array,
  aux?: SortScratch,
): number {
  if (count <= 0) return 0
  const fx = forward[0], fy = forward[1], fz = forward[2]
  if (count === 1) {
    // The trivial frame — both tiers' output, computed once: the key
    // contract (keys[0] = the dot) binds even here.
    keys[0] = fx * px[0] + fy * py[0] + fz * pz[0]
    indices[0] = 0
    return 1
  }
  if (aux !== undefined && aux.k.length >= count && aux.kAlt.length >= count && aux.iAlt.length >= count) {
    // ── THE RADIX TIER (Task 176) ────────────────────────────────────────
    const k = aux.k
    const kAlt = aux.kAlt
    const iAlt = aux.iAlt
    // Walk 1 — the keys (slot-indexed, the caller contract) and the
    // pass-0 source in SLOT-DESCENDING order (the LSD's stability turns
    // that input order into the tie-break rule). The caller's `indices`
    // doubles as the pass-0 index source: the even pass count lands the
    // final answer right back into it.
    for (let i = count - 1, j = 0; i >= 0; i--, j++) {
      const t = fx * px[i] + fy * py[i] + fz * pz[i]
      keys[i] = t
      BIT_F32[0] = t
      let bits = BIT_U32[0]
      if (bits === 0x80000000) bits = 0 // −0 → +0: JS compares them equal — the tie survives
      // The descending-order flip: negatives (~bits, ascending toward −0)
      // map BELOW the positives (bits | sign, ascending toward +Inf) — so
      // ASCENDING on this word is the key DESCENDING (far first).
      bits = (bits & 0x80000000) !== 0 ? ~bits : (bits | 0x80000000)
      k[j] = ~bits >>> 0
      indices[j] = i
    }
    // Four passes of 8-bit stable LSD over the flipped key bits →
    // THE DIGIT TIER (Task 177): the pass count is the radix's cost
    // driver (each pass = a full sequential read + a random-write
    // scatter over the ping-pong); the digit width buys passes with
    // histogram span. The 8-bit body's four passes are retired in
    // favor of two 16-bit passes (large counts) / three 11-bit passes
    // (small counts — the 256 KiB wide histogram's fixed fill+scan
    // would dominate under ~8k). Digit split cannot change a stable
    // LSD's total order — the parity vs the classic comparator holds
    // on both sides of the threshold (sort177).
    if (count >= RADIX_16BIT_MIN) {
      // TWO 16-bit passes — even: (k, indices) hold the answer, no
      // copy-out.
      HIST16.fill(0)
      for (let i = 0; i < count; i++) HIST16[k[i] & 0xffff]++
      let sum = 0
      for (let b = 0; b < 65536; b++) { const h = HIST16[b]; HIST16[b] = sum; sum += h }
      for (let i = 0; i < count; i++) {
        const key = k[i]
        const at = HIST16[key & 0xffff]++
        kAlt[at] = key
        iAlt[at] = indices[i]
      }
      HIST16.fill(0)
      for (let i = 0; i < count; i++) HIST16[kAlt[i] >>> 16]++
      sum = 0
      for (let b = 0; b < 65536; b++) { const h = HIST16[b]; HIST16[b] = sum; sum += h }
      for (let i = 0; i < count; i++) {
        const key = kAlt[i]
        const at = HIST16[key >>> 16]++
        k[at] = key
        indices[at] = iAlt[i]
      }
      return count
    }
    // THREE 11-bit passes (11/11/10 = 32) — odd: the payload's last
    // scatter target is iAlt; one count×4B copy-out restores the
    // caller's `indices` contract (~20 µs at 100k — under the small
    // counts this branch serves, it is noise).
    {
      let fromK: Uint32Array = k
      let toK: Uint32Array = kAlt
      let fromI: Int32Array = indices
      let toI: Int32Array = iAlt
      for (let pass = 0; pass < 3; pass++) {
        const shift = pass === 0 ? 0 : pass === 1 ? 11 : 22
        const mask = pass === 2 ? 0x3ff : 0x7ff
        HIST11.fill(0)
        for (let i = 0; i < count; i++) HIST11[(fromK[i] >>> shift) & mask]++
        let sum = 0
        for (let b = 0; b < 2048; b++) { const h = HIST11[b]; HIST11[b] = sum; sum += h }
        // The stable scatter — the histogram's running cursor keeps the
        // source order within each bucket (the tie-break's carrier).
        for (let i = 0; i < count; i++) {
          const key = fromK[i]
          const at = HIST11[(key >>> shift) & mask]++
          toK[at] = key
          toI[at] = fromI[i]
        }
        const swapK = fromK; fromK = toK; toK = swapK
        const swapI = fromI; fromI = toI; toI = swapI
      }
      // 3 passes: p0 (k,indices)→(kAlt,iAlt), p1 →(k,indices),
      // p2 →(kAlt,iAlt) — the payload sits in iAlt; copy it out.
      if (fromI !== indices) indices.set(fromI.subarray(0, count), 0)
      return count
    }
  }
  // ── THE CLASSIC TIER (the fallback: no aux — byte-identical output) ────
  for (let i = 0; i < count; i++) {
    indices[i] = i
    keys[i] = fx * px[i] + fy * py[i] + fz * pz[i]
  }
  // Back to front = the key DESCENDING (dot(forward, p) grows with the
  // view-axis depth). The tie-break (b − a) makes the comparator a TOTAL
  // order: equal depths resolve to the higher slot first, the same bytes
  // on every engine — the parity contract.
  indices.subarray(0, count).sort((a, b) => keys[b] - keys[a] || b - a)
  return count
}
