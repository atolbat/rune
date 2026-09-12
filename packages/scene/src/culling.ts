/**
 * culling.ts — frustum culling (Task 81).
 *
 * The hierarchical variant uses the main corollary of the preorder layout:
 * a node's subtree is a CONTIGUOUS rank range [r, subtreeEnd[slot]),
 * therefore:
 *   • trivial reject  (the sphere is entirely outside) — clearing the bitset's
 *     range of words without visiting the children;
 *   • trivial accept  (the sphere is entirely inside) — filling the range with ones
 *     without a single child test;
 *   • intersection — descend into the children only (each child is again a range).
 *
 * An internal node without bounds (r ≤ 0, an "unknown volume") is never
 * trivially rejected or accepted — descent only (always safe).
 *
 * The bitsets are in rank space; the consumer joins through order[rank].
 * The brute variant (testing every sphere) is the correctness reference and the
 * baseline for small/flat scenes: the benchmark decides what is cheaper.
 */
import type { SceneViews } from './layout.ts'
import { H_CLOCK, H_LAYOUT_EPOCH, H_NODE_COUNT, NF_VISIBLE } from './layout.ts'

// ─── Task 190: the CULL MEMO (the Task-189 N5 theory, production) ───────────
//
// A cull result is a PURE function of (order/subtreeEnd, sphereW, planes,
// node count). Every input mutates through the API, which stamps the shared
// monotonic H_CLOCK (setLocal/setSphereLocal/setVisible/updateWorld) or bumps
// H_LAYOUT_EPOCH (pack — ranks change meaning); Task 190 also makes refit
// bump the clock when it writes spheres. Therefore: clock + epoch + the
// camera's 24 planes unchanged since the last real cull of THIS
// (buffer, camera) ⟹ the bitset in the buffer is EXACTLY what a fresh cull
// would write ⟹ skip the walk, serve the cached stats.
//
// The memo state is keyed by the views object (a WeakMap): module-level
// arrays would COLLIDE across scenes (two scenes with equal clocks and equal
// planes would validate each other's stale bits — an isolated-probe artifact
// that cannot be allowed in production). Thread-local by construction: the
// worker's memo lives in the worker (its own views object over the same SAB),
// validated against the SAME shared clock/epoch — main-thread writes
// invalidate it exactly when they should.
//
// Contract (documented, same family as the Task-85 upload skip): data written
// THROUGH THE SCENE API. A raw `views.sphereW[i] = …` hack bypasses every
// stamp in this file's family — the memo (like groupTouch) will not see it.
//
// The `masks` / `countVisible` flags change the STATS (planeTests / the
// visible tally), so they are part of the memo key — an A/B masks=false call
// never pollutes a default-mode cache slot.
//
// The kill-switch (setCullMemo(false)) restores the always-full behavior
// bit-for-bit: the memo is an ellipsis over the real kernel, nothing else.

/** Task 190 — enable/disable the cull memo (tests, A/B diagnostics). */
let cullMemoEnabled = true
/** Task 190 — honest counters (a hit is a skipped walk). */
let cullMemoHits = 0
let cullMemoMisses = 0

interface CullMemoState {
  /** Per (buffer, camera): the H_CLOCK at the last real cull (−1 — never). */
  readonly clock: Int32Array
  /** Per (buffer, camera): the H_LAYOUT_EPOCH at the last real cull. */
  readonly epoch: Int32Array
  /** Per (buffer, camera): the flag byte (bit0 — masks, bit1 — countVisible). */
  readonly flags: Uint8Array
  /** Per (buffer, camera) × 24: the planes snapshot. */
  readonly planes: Float32Array
  /** Per (buffer, camera) × 5: (tested, visible, trivialRejects, trivialAccepts, planeTests). */
  readonly stats: Int32Array
}

const cullMemos = new WeakMap<SceneViews, CullMemoState>()

function cullMemoFor(views: SceneViews): CullMemoState {
  let memo = cullMemos.get(views)
  if (memo === undefined) {
    const slots = 2 * views.cameraMax
    memo = {
      clock: new Int32Array(slots).fill(-1),
      epoch: new Int32Array(slots).fill(-1),
      flags: new Uint8Array(slots),
      planes: new Float32Array(slots * 24),
      stats: new Int32Array(slots * 5),
    }
    cullMemos.set(views, memo)
  }
  return memo
}

/** Task 190 — the kill-switch: false restores the pre-190 always-full cull. */
export function setCullMemo(enabled: boolean): void {
  cullMemoEnabled = enabled
}

/** Task 190 — the memo's honest counters (diagnostics/tests). */
export function cullMemoCounters(): { hits: number; misses: number } {
  return { hits: cullMemoHits, misses: cullMemoMisses }
}

/** The memo check + serve: returns true when the caller may return early. */
function cullMemoServe(
  views: SceneViews,
  bufferIndex: number,
  cameraIndex: number,
  flagByte: number,
  out: MutableCullStats | undefined,
): boolean {
  const idx = bufferIndex * views.cameraMax + cameraIndex
  const memo = cullMemoFor(views)
  if (memo.clock[idx] !== views.headerU[H_CLOCK]) return false
  if (memo.epoch[idx] !== views.headerI[H_LAYOUT_EPOCH]) return false
  if (memo.flags[idx] !== flagByte) return false
  const src = cameraIndex * 24
  const snap = idx * 24
  const planes = views.planes
  const snapPlanes = memo.planes
  for (let i = 0; i < 24; i++) {
    if (planes[src + i] !== snapPlanes[snap + i]) return false
  }
  // A HIT: the bitset in the buffer is exactly what the kernel would rewrite.
  cullMemoHits++
  const s = idx * 5
  const stats = memo.stats
  if (out !== undefined) {
    out.tested = stats[s]
    out.visible = stats[s + 1]
    out.trivialRejects = stats[s + 2]
    out.trivialAccepts = stats[s + 3]
    out.planeTests = stats[s + 4]
    return true
  }
  return true // the caller builds the result object from the same numbers
}

/** The memo save after a real kernel run (the stats are already final). */
function cullMemoSave(
  views: SceneViews,
  bufferIndex: number,
  cameraIndex: number,
  flagByte: number,
  tested: number,
  visible: number,
  trivialRejects: number,
  trivialAccepts: number,
  planeTests: number,
): void {
  const idx = bufferIndex * views.cameraMax + cameraIndex
  const memo = cullMemoFor(views)
  memo.clock[idx] = views.headerU[H_CLOCK]
  memo.epoch[idx] = views.headerI[H_LAYOUT_EPOCH]
  memo.flags[idx] = flagByte
  memo.planes.set(views.planes.subarray(cameraIndex * 24, cameraIndex * 24 + 24), idx * 24)
  const s = idx * 5
  memo.stats[s] = tested
  memo.stats[s + 1] = visible
  memo.stats[s + 2] = trivialRejects
  memo.stats[s + 3] = trivialAccepts
  memo.stats[s + 4] = planeTests
  cullMemoMisses++
}

/** Reads the memo's cached stats (the hit path's result object). */
function cullMemoStatsOf(views: SceneViews, bufferIndex: number, cameraIndex: number): CullStats {
  const idx = bufferIndex * views.cameraMax + cameraIndex
  const s = idx * 5
  const stats = cullMemoFor(views).stats
  return {
    tested: stats[s],
    visible: stats[s + 1],
    trivialRejects: stats[s + 2],
    trivialAccepts: stats[s + 3],
    planeTests: stats[s + 4],
  }
}

/** Internal mutable statistics (an out record — no per-frame allocations). */
export interface MutableCullStats {
  tested: number
  visible: number
  trivialRejects: number
  trivialAccepts: number
  planeTests: number
}

/** Statistics of a single culling pass. */
export interface CullStats {
  /** Spheres tested. */
  readonly tested: number
  /** Ranks deemed visible (bits set). */
  readonly visible: number
  /** Subtrees rejected wholesale. */
  readonly trivialRejects: number
  /** Subtrees accepted wholesale. */
  readonly trivialAccepts: number
  /** Real "sphere×plane" tests (Task 85: with masks there are fewer than tested×6). */
  readonly planeTests: number
}

/** Scratch stack of ranges (grows geometrically, outside hot calls).
 * Entries are TRIPLES (rankStart, rankEnd, planeMask): Task 85 — plane
 * masks are inherited down through the enclosing spheres. */
let rangeStack = new Int32Array(8192)

function pushRange(s: number, e: number, mask: number, sp: number): number {
  if (sp + 3 > rangeStack.length) {
    const grown = new Int32Array(rangeStack.length * 2)
    grown.set(rangeStack)
    rangeStack = grown
  }
  rangeStack[sp] = s
  rangeStack[sp + 1] = e
  rangeStack[sp + 2] = mask
  return sp + 3
}

/** Fills a bitset over the rank range [s, e). */
export function fillBits(bits: Uint32Array, base: number, s: number, e: number, on: boolean): void {
  if (e <= s) return
  const sWord = s >>> 5
  const eWord = (e - 1) >>> 5
  if (sWord === eWord) {
    const count = e - s
    const mask = (count >= 32 ? 0xffffffff : (1 << count) - 1) << (s & 31)
    if (on) bits[base + sWord] |= mask
    else bits[base + sWord] &= ~mask
    return
  }
  // Head.
  const sOff = s & 31
  if (sOff !== 0) {
    const mask = ((1 << (32 - sOff)) - 1) << sOff // bits sOff..31
    if (on) bits[base + sWord] |= mask
    else bits[base + sWord] &= ~mask
  } else {
    bits[base + sWord] = on ? 0xffffffff : 0
  }
  // Full words in between.
  for (let w = sWord + 1; w < eWord; w++) {
    bits[base + w] = on ? 0xffffffff : 0
  }
  // Tail.
  const eOff = e & 31
  if (eOff !== 0) {
    const mask = (1 << eOff) - 1
    if (on) bits[base + eWord] |= mask
    else bits[base + eWord] &= ~mask
  } else {
    bits[base + eWord] = on ? 0xffffffff : 0
  }
}

/** The bitset population (for statistics).
 * Task 182 — SWAR popcount: ~6 int ops per WORD (a constant), not
 * Kernighan's loop of one iteration PER SET BIT. On a visible-heavy scene
 * (70–100%) this is ~5–10× fewer operations for the same number; zero
 * words cost one load + branch. Exercised once per camera per cull from
 * cullViewsHierarchical — on a 1M-node scene the old form burned ~1M inner
 * iterations per camera per frame. */
export function popcountBits(bits: Uint32Array, base: number, words: number): number {
  let count = 0
  for (let w = 0; w < words; w++) {
    let v = bits[base + w]
    if (v === 0) continue
    v = v - ((v >>> 1) & 0x55555555)
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
    v = (v + (v >>> 4)) & 0x0f0f0f0f
    count += (v * 0x01010101) >>> 24
  }
  return count
}

/** The base of a camera's bitset in buffer b. */
export function bitsBase(views: SceneViews, bufferIndex: number, cameraIndex: number): number {
  return (bufferIndex * views.cameraMax + cameraIndex) * views.bitsWords
}

/** Visibility of a rank (a helper for consumers and tests). */
export function isVisibleRank(
  views: SceneViews,
  bufferIndex: number,
  cameraIndex: number,
  rank: number,
): boolean {
  const base = bitsBase(views, bufferIndex, cameraIndex)
  return (views.bits[base + (rank >>> 5)] & (1 << (rank & 31))) !== 0
}

/** Pushes the child subtree ranges of [s, e) onto the module stack.
 *  A module-level function (not a closure): cull runs per camera per frame —
 *  the old closure was a hidden per-call allocation. */
function splitChildrenOf(order: Int32Array, subtreeEnd: Int32Array, s: number, e: number, mask: number, sp: number): number {
  let r2 = s + 1
  while (r2 < e) {
    const child = order[r2]
    const childEnd = subtreeEnd[child]
    const end = childEnd > r2 ? childEnd : r2 + 1
    sp = pushRange(r2, end, mask, sp)
    r2 = end
  }
  return sp
}

/**
 * Hierarchical culling of camera cameraIndex into buffer bufferIndex (0/1).
 * Requires fresh spheres (updateWorld + refitGroupBounds) and pack().
 *
 * Task 85 — PLANE MASKS (Assarsson–Möller): the mask is the bits of the planes
 * that the node still has to test. A plane DROPS OUT of the children's mask
 * only if the parent's ENCLOSING sphere is entirely inside it — then the whole
 * parent subtree is inside that plane, the children do not need it.
 * Nodes of an "unknown volume" (r ≤ 0) do not narrow the mask (their sphere
 * says nothing about the children) — the mask is inherited by the children
 * as is. On deep trees this turns 6 → ~2 plane tests per node with the same
 * result bitset (parity with brute — property tests in culling.test.ts).
 *
 * Task 182 — countVisible (default true): set false to skip the closing
 * popcount over the whole bitset (the caller does not read `visible`);
 * the field is then -1 ("not counted"). The other stats stay exact.
 */
export function cullViewsHierarchical(
  views: SceneViews,
  cameraIndex: number,
  bufferIndex: number,
  out?: MutableCullStats,
  masks: boolean = true,
  countVisible: boolean = true,
): CullStats {
  // Task 190 — the memo hit: the kernel would rewrite the bitset bit-for-bit;
  // serve the cached numbers instead of walking the tree. Bit2 marks the
  // VARIANT (hierarchical) — the brute's (0) and a masks=false+countVisible=false
  // hierarchical call must never share a slot: identical bits, different stats.
  const flagByte = 4 | (masks ? 1 : 0) | (countVisible ? 2 : 0)
  if (cullMemoEnabled && cullMemoServe(views, bufferIndex, cameraIndex, flagByte, out)) {
    if (out !== undefined) return out
    return cullMemoStatsOf(views, bufferIndex, cameraIndex)
  }
  const n = views.headerI[H_NODE_COUNT]
  const { order, parent, subtreeEnd, sphereW, bits, planes } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const pb = cameraIndex * 24

  // Forest roots: subtree ranges + the full mask (at the top — all 6).
  let sp = 0
  for (let r = 0; r < n; ) {
    const slot = order[r]
    const end = subtreeEnd[slot]
    if (parent[slot] < 0 && end > r) {
      sp = pushRange(r, end, 0x3f, sp)
      r = end
    } else {
      r++
    }
  }

  let tested = 0
  let trivialRejects = 0
  let trivialAccepts = 0
  let planeTests = 0
  while (sp > 0) {
    sp -= 3
    const s = rangeStack[sp]
    const e = rangeStack[sp + 1]
    const mask = rangeStack[sp + 2]
    const slot = order[s]
    const leaf = e === s + 1
    const o4 = slot * 4
    const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2]
    const r = sphereW[o4 + 3]
    // The sphere encloses the subtree: a leaf (itself is the subtree) or r > 0
    // (a user or refit bound). r ≤ 0 on an internal node —
    // an "unknown volume": we always descend, the bit — by the point (like brute).
    const enclosing = leaf || r > 0
    tested++

    let outside = false
    let insideAll = true
    let interMask = 0
    let m = mask
    while (m !== 0) {
      const pbIdx = m & -m
      const i = 31 - Math.clz32(pbIdx) // the plane index from the bit
      m ^= pbIdx
      const o = pb + i * 4
      planeTests++
      const d = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3]
      if (d < -r) {
        outside = true
        break
      }
      if (d < r) {
        interMask |= pbIdx
        insideAll = false
      }
    }

    if (outside) {
      if (enclosing) {
        fillBits(bits, base, s, e, false)
        trivialRejects++
      } else {
        // The node's point is outside, but the children may protrude into view — its own bit only.
        bits[base + (s >>> 5)] &= ~(1 << (s & 31))
        sp = splitChildrenOf(order, subtreeEnd, s, e, mask, sp)
      }
      continue
    }
    if (insideAll && enclosing) {
      // Fully inside: the children too (an enclosing sphere) — fill the range.
      fillBits(bits, base, s, e, true)
      trivialAccepts++
      continue
    }
    // Intersection (or an unknown volume): the node is visible, descend into the children.
    // The children's mask: an enclosing sphere — only the intersected planes;
    // an unknown volume — the mask as is (nothing to narrow with).
    // masks=false — the A/B mode "before Task 85": the mask is not narrowed,
    // nodes below test all 6 planes (the result is identical — only costlier).
    bits[base + (s >>> 5)] |= 1 << (s & 31)
    if (!leaf) sp = splitChildrenOf(order, subtreeEnd, s, e, masks && enclosing ? interMask : mask, sp)
  }

  const visible = countVisible ? popcountBits(bits, base, views.bitsWords) : -1
  if (cullMemoEnabled) {
    cullMemoSave(views, bufferIndex, cameraIndex, flagByte,
      tested, visible, trivialRejects, trivialAccepts, planeTests)
  }
  if (out !== undefined) {
    out.tested = tested
    // Task 182: countVisible=false leaves the number uncounted (-1) — the
    // worker/T0 pipeline (runScenePipeline) never reads the stats; counting
    // was a per-camera-per-frame popcount over the whole bitset for nothing.
    out.visible = visible
    out.trivialRejects = trivialRejects
    out.trivialAccepts = trivialAccepts
    out.planeTests = planeTests
    return out
  }
  return {
    tested,
    visible,
    trivialRejects,
    trivialAccepts,
    planeTests,
  }
}

/**
 * Brute culling: every sphere tested independently (the reference + flat scenes).
 * Correct without group bounds — a node's sphere does not affect the children.
 */
export function cullViewsBrute(
  views: SceneViews,
  cameraIndex: number,
  bufferIndex: number,
  out?: MutableCullStats,
): CullStats {
  // Task 190 — the memo hit (the brute's flag byte is 0; the hierarchical
  // always sets bit2 — the variants never share a slot even at equal bits).
  if (cullMemoEnabled && cullMemoServe(views, bufferIndex, cameraIndex, 0, out)) {
    if (out !== undefined) return out
    return cullMemoStatsOf(views, bufferIndex, cameraIndex)
  }
  const n = views.headerI[H_NODE_COUNT]
  const { order, sphereW, bits, planes } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const pb = cameraIndex * 24
  let visible = 0
  let planeTests = 0

  for (let r = 0; r < n; r++) {
    const slot = order[r]
    const o4 = slot * 4
    const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2]
    const rad = sphereW[o4 + 3]
    let vis = true
    for (let i = 0; i < 6; i++) {
      planeTests++
      const o = pb + i * 4
      if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] < -rad) {
        vis = false
        break
      }
    }
    const w = base + (r >>> 5)
    const m = 1 << (r & 31)
    if (vis) {
      bits[w] |= m
      visible++
    } else {
      bits[w] &= ~m
    }
  }

  if (cullMemoEnabled) {
    cullMemoSave(views, bufferIndex, cameraIndex, 0, n, visible, 0, 0, planeTests)
  }
  if (out !== undefined) {
    out.tested = n
    out.visible = visible
    out.trivialRejects = 0
    out.trivialAccepts = 0
    out.planeTests = planeTests
    return out
  }
  return { tested: n, visible, trivialRejects: 0, trivialAccepts: 0, planeTests }
}

/**
 * The "node hidden" post-filter: a node's visibility bit takes NF_VISIBLE
 * into account. Returns false if the bit is set but the node is turned off
 * (for consumers that need the exact tally without a separate flag check).
 */
export function rankNodeVisible(views: SceneViews, rank: number): boolean {
  const slot = views.order[rank]
  return slot >= 0 && (views.nodeFlags[slot] & NF_VISIBLE) !== 0
}
