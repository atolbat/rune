/**
 * frameSort.ts — Task 86: sorting frame entries by state key;
 * Task 87 — COMPLETELY ALLOCATION-FREE (removed Array.from().sort(cmp),
 * which sliced the array on every call — 4 calls/frame).
 *
 * "Rendering with fewer internal state switches" is the classic
 * (Funkhouser/Woo, industrial renderers): every draw entry gets a
 * 40-bit sort key, the frame is sorted by it, adjacent entries
 * reuse state.
 *
 * Key (high bits dominate, comparison — by a plain number):
 *
 *   [39..36] pass     — frame composition order: opaque(0) → sky(1) →
 *                       mirror(2) → transparent(3) → overlay(4).
 *                       Transparent — AFTER opaques and strictly back-to-front;
 *                       mirrors — after the sky (the sky is visible in the mirror), but before
 *                       transparents (water over the mirror is blended).
 *   [35..28] pipeline — shader recipe: a program switch is the most expensive
 *                       switch, minimized first.
 *   [27..16] depth    — view depth, bucket 0..4095:
 *                       opaque — ASCENDING (front-to-back, early-Z: near
 *                       objects occlude far ones, their fragments are culled by
 *                       the depth test BEFORE shading); transparent — DESCENDING
 *                       (back-to-front for correct blending; the inversion —
 *                       inside packFrameKey by pass tag).
 *   [15..8]  mesh     — buffer set (VAO): with VAO a geometry switch is one
 *                       bindVertexArray, so depth is ABOVE mesh
 *                       (early-Z is worth more than saving one bind).
 *   [7..0]   sequence — stable bias: equal keys keep insertion
 *                       order.
 *
 * Sorting (Task 87, "no reallocations"):
 *   • n ≤ 64 — binary insertion on Int32Array scratches (demo: 11–20 entries
 *     per surface — this path always);
 *   • n > 64 — LSD radix of 6 digits (8 bits × 5 + 4 bits of pass) with counting
 *     sort over Float64 keys, scratches grow geometrically and live
 *     between frames. Both paths are STABLE (equal keys — insertion order).
 *
 * Depth estimation is the submitter's responsibility (the group's bounding
 * centroid, the unique mesh's center); quantization — quantizeDepth().
 */

/** Frame pass (order = RENDER_PASS_ORDER from @rune/scene). */
export type FramePass = 'opaque' | 'sky' | 'mirror' | 'transparent' | 'overlay'

const PASS_INDEX: Readonly<Record<FramePass, number>> = {
  opaque: 0,
  sky: 1,
  mirror: 2,
  transparent: 3,
  overlay: 4,
}

/** Number of depth buckets (12 bits). */
export const DEPTH_BUCKETS = 4096

/** Quantize view depth (0..maxDepth → bucket 0..4095). */
export function quantizeDepth(viewDepth: number, maxDepth: number): number {
  if (!(viewDepth > 0)) return 0
  const b = Math.round((viewDepth / Math.max(1e-6, maxDepth)) * (DEPTH_BUCKETS - 1))
  return b < 0 ? 0 : b >= DEPTH_BUCKETS ? DEPTH_BUCKETS - 1 : b
}

/** Frame entry: command/capture + state classification. */
export interface FrameEntry<C> {
  readonly cmd: C
  readonly pass: FramePass
  /** Pipeline class (shader recipe): 0..255. */
  readonly pipeline: number
  /** Depth bucket (quantizeDepth): near=0. The inversion for transparent —
   *  inside packFrameKey. */
  readonly depth: number
  /** Mesh class (buffer set/VAO): 0..255. */
  readonly mesh: number
}

/** Pack an entry key (40 bits, safe for number). */
export function packFrameKey(entry: FrameEntry<unknown>, sequence: number): number {
  const depth = entry.pass === 'transparent'
    ? (DEPTH_BUCKETS - 1) - (entry.depth & 0xfff) // back-to-front: far ones first
    : entry.depth & 0xfff
  return (
    ((PASS_INDEX[entry.pass] & 0xf) * 0x10000000000) +
    ((entry.pipeline & 0xff) * 0x100000000) +
    (depth * 0x10000) +
    ((entry.mesh & 0xff) * 0x100) +
    (sequence & 0xff)
  )
}

/** Below this size insertion sort is faster than radix (no passes over
 *  the counters): demo sizes (≤ 20 entries) always land here. */
const INSERTION_THRESHOLD = 64

/**
 * Sort the first count entries into composition order / minimal
 * switching. Stable: equal keys keep insertion order.
 * NO ALLOCATIONS: scratches are reused between frames (geometric
 * growth), entries are read directly (the entry pool is passed with an explicit count —
 * no slice/subarray). out — a reusable command array.
 */
export function sortFrameEntries<C>(
  entries: ReadonlyArray<FrameEntry<C>>,
  out: C[],
  count: number = entries.length,
): C[] {
  const n = count
  if (n <= 0) return out
  const keys = sortKeysScratch(n)
  const order = sortOrderScratch(n)
  for (let i = 0; i < n; i++) {
    keys[i] = packFrameKey(entries[i]!, i)
    order[i] = i
  }
  if (n <= INSERTION_THRESHOLD) insertionSort(keys, order, n)
  else radixSort(keys, order, n)
  for (let i = 0; i < n; i++) out[i] = entries[order[i] as number]!.cmd
  return out
}

// ─── Scratches (no GC churn per frame) ────────────────────────────────────────

let keysScratch = new Float64Array(64)
let orderScratch = new Int32Array(64)
let radixScratch = new Int32Array(64)
const radixCounts = new Int32Array(256)

function sortKeysScratch(n: number): Float64Array {
  if (keysScratch.length < n) keysScratch = new Float64Array(Math.max(64, n * 2))
  return keysScratch
}

function sortOrderScratch(n: number): Int32Array {
  if (orderScratch.length < n) orderScratch = new Int32Array(Math.max(64, n * 2))
  return orderScratch
}

/**
 * Stable binary insertion: (key, index) — the index breaks ties.
 * Works in place on the Int32Array order; keys are compared directly.
 */
function insertionSort(keys: Float64Array, order: Int32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const key = keys[i]!
    const idx = order[i]!
    // insertion position in [0..i] — the first j with keys[j] > key (strict
    // inequality = stability: equals stay in index order)
    let lo = 0
    let hi = i
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (keys[mid]! <= key) lo = mid + 1
      else hi = mid
    }
    for (let j = i; j > lo; j--) {
      keys[j] = keys[j - 1]!
      order[j] = order[j - 1]!
    }
    keys[lo] = key
    order[lo] = idx
  }
}

/** Radix digit divisors: 6×8 bits — covers the whole 40-bit key (the top
 *  digit — only pass bits, key < 2^43). An even number of passes —
 *  the result is returned in the original order without copying. */
const RADIX_DIGITS = [1, 256, 65536, 16777216, 4294967296, 1099511627776] as const

/**
 * Stable LSD radix over the 40-bit key: 6×8-bit digits, counting
 * sort one digit per pass — stable by construction.
 */
function radixSort(keys: Float64Array, order: Int32Array, n: number): void {
  if (radixScratch.length < n) radixScratch = new Int32Array(Math.max(64, n * 2))
  let src: Int32Array = order
  let dst: Int32Array = radixScratch
  for (let d = 0; d < RADIX_DIGITS.length; d++) {
    const div = RADIX_DIGITS[d]!
    radixCounts.fill(0)
    // digit counters
    for (let i = 0; i < n; i++) {
      const digit = Math.floor(keys[src[i] as number]! / div) & 0xff
      radixCounts[digit]++
    }
    // exclusive prefixes
    let sum = 0
    for (let b = 0; b < 256; b++) {
      const c = radixCounts[b]!
      radixCounts[b] = sum
      sum += c
    }
    // stable distribution
    for (let i = 0; i < n; i++) {
      const s = src[i] as number
      const digit = Math.floor(keys[s]! / div) & 0xff
      dst[radixCounts[digit]! as number] = s
      radixCounts[digit] = radixCounts[digit]! + 1
    }
    const t = src
    src = dst
    dst = t
  }
  // after an even number of passes the result is in the original order
  if (src !== order) order.set(src.subarray(0, n))
}
