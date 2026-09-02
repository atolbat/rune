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
import { H_NODE_COUNT, NF_VISIBLE } from './layout.ts'

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

/** The bitset population (for statistics). */
export function popcountBits(bits: Uint32Array, base: number, words: number): number {
  let count = 0
  for (let w = 0; w < words; w++) {
    let v = bits[base + w]
    while (v !== 0) {
      v &= v - 1
      count++
    }
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
 */
export function cullViewsHierarchical(
  views: SceneViews,
  cameraIndex: number,
  bufferIndex: number,
  out?: MutableCullStats,
  masks: boolean = true,
): CullStats {
  const n = views.headerI[H_NODE_COUNT]
  const { order, parent, subtreeEnd, sphereW, bits, planes } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const pb = cameraIndex * 24

  // Forest roots: subtree ranges + the full mask (at the top — all 6).
  let sp = 0
  function splitChildren(s: number, e: number, mask: number): void {
    let r2 = s + 1
    while (r2 < e) {
      const child = order[r2]
      const childEnd = subtreeEnd[child]
      const end = childEnd > r2 ? childEnd : r2 + 1
      sp = pushRange(r2, end, mask, sp)
      r2 = end
    }
  }
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
        splitChildren(s, e, mask)
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
    if (!leaf) splitChildren(s, e, masks && enclosing ? interMask : mask)
  }

  if (out !== undefined) {
    out.tested = tested
    out.visible = popcountBits(bits, base, views.bitsWords)
    out.trivialRejects = trivialRejects
    out.trivialAccepts = trivialAccepts
    out.planeTests = planeTests
    return out
  }
  return { tested, visible: popcountBits(bits, base, views.bitsWords), trivialRejects, trivialAccepts, planeTests }
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
