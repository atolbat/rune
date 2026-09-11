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
 * to every scenario). The radix tier replaces it with FOUR passes of
 * 8-bit stable LSD over the IEEE-754 bit-flip of the f32 key:
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
 *     Four passes (even) land the answer back in the caller's `indices`
 *     — no copy-out. The 256-counter histogram is a fixed module const.
 *
 * MEASURED (bench/ab-sort.ts, interleaved, medians): radix wins at EVERY
 * size — 0.015 vs 0.023 ms at 256, 1.05 vs 4.34 at 16k, 6.66 vs 32.2 at
 * 100k (−79%), 13.4 vs 69.4 at 200k. The composite single-sort shape
 * (one Float64Array.sort() over packed 53-bit keys) was measured between
 * the two and REJECTED — radix dominated it at every size too.
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
  /** The pass-0 key-bits source; also where passes land back (with
   *  `indices`) after the even four-pass ping-pong. */
  readonly k: Uint32Array
  /** The scatter target for the key bits (odd passes). */
  readonly kAlt: Uint32Array
  /** The scatter target for the indices (odd passes; the even passes
   *  scatter into the caller's `indices` itself). */
  readonly iAlt: Int32Array
}

/** The fixed-size radix histogram (256 byte-buckets) — module const,
 *  never grows, never allocates. */
const HIST = new Uint32Array(256)

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
    // Four passes of 8-bit stable LSD over the flipped key bits. Even
    // pass count → the ping-pong ends holding (k, indices) — the caller's
    // buffers are the answer, no copy-out.
    let fromK: Uint32Array = k
    let toK: Uint32Array = kAlt
    let fromI: Int32Array = indices
    let toI: Int32Array = iAlt
    for (let pass = 0; pass < 4; pass++) {
      const shift = pass * 8
      HIST.fill(0)
      for (let i = 0; i < count; i++) HIST[(fromK[i] >>> shift) & 0xff]++
      let sum = 0
      for (let b = 0; b < 256; b++) {
        const h = HIST[b]
        HIST[b] = sum
        sum += h
      }
      // The stable scatter — the histogram's running cursor keeps the
      // source order within each bucket (the tie-break's carrier).
      for (let i = 0; i < count; i++) {
        const key = fromK[i]
        const at = HIST[(key >>> shift) & 0xff]++
        toK[at] = key
        toI[at] = fromI[i]
      }
      const swapK = fromK; fromK = toK; toK = swapK
      const swapI = fromI; fromI = toI; toI = swapI
    }
    return count
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
