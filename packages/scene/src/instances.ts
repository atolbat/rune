/**
 * instances.ts — compaction of visible instances (Task 81; Task 85 — group stamps).
 *
 * An instance group is a dense id ≥ 0 in slot.group (−1 — the node is not instanced).
 * A pass over the ranks with the camera's visibility bit collects the WORLD matrices
 * of the group's visible nodes into a contiguous pool segment → one draw-instanced
 * per group (the matrices are a ready float32×16 instance attribute: stride 64,
 * divisor 1 — the rendererFeed / batchCommand wiring of the @rune/gl world).
 *
 * Task 85 — GROUP STAMPS for upload skipping: an instance buffer (group × camera)
 * stays valid while (a) the group's counter has not changed, (b) no node of the
 * group has changed visibility FOR THIS camera, (c) no node of the group has
 * recomputed its world/composition. (c) is stamped by updateWorld/setVisible →
 * groupTouch (shared); (b) — by this pass: a diff of the current and the
 * PREVIOUS epoch's bitsets (double bitsets — exactly for this) → a PER-CAMERA
 * groupFlip — a drone flip does not re-upload the minimap's statics. Ranks
 * between epochs are comparable only with an unchanged layout — otherwise
 * (pack!) we touch all groups of all cameras.
 *
 * Honest engineering: a word-skip bitset traversal (ctz bit extraction) was TRIED
 * and REJECTED — on the demo's real visibility (40–70%) it is consistently slower
 * than the rank loop with an early bit test (measurements: scripts/micro-collect.ts,
 * Task 85 probe runs); it pulls ahead only below <10% visibility, where the
 * compaction is nearly free anyway. The simple rank traversal stays.
 */
import type { SceneViews } from './layout.ts'
import {
  H_CLOCK,
  H_COLLECT_LAYOUT_EPOCH,
  H_DROPPED_INSTANCES,
  H_GROUP_COUNT,
  H_LAYOUT_EPOCH,
  H_MAX_INSTANCES,
  H_NODE_COUNT,
  NF_VISIBLE,
} from './layout.ts'
import { bitsBase } from './culling.ts'

/** Scratch cursors per group. */
let cursors = new Int32Array(64)

/** The base of a camera's instance counters in buffer b (in the Int32Array instCounts). */
function instBase(views: SceneViews, bufferIndex: number, cameraIndex: number): number {
  return (bufferIndex * views.cameraMax + cameraIndex) * views.groupMax
}

/** The base of a camera's matrix pool in buffer b (in the Float32Array instPool).
 * Task 87 — an export for allocation-free consumers: reading a group's matrices
 * directly from views.instPool by numbers (base + offset×16), bypassing
 * instanceMatricesView with its per-group subarray view every frame. */
export function instancePoolBase(views: SceneViews, bufferIndex: number, cameraIndex: number): number {
  return (bufferIndex * views.cameraMax + cameraIndex) * views.headerI[H_MAX_INSTANCES] * 16
}

/**
 * Collects the instances of all groups for camera cameraIndex from buffer bufferIndex.
 * Returns the total number of collected matrices.
 */
export function collectInstancesViews(
  views: SceneViews,
  cameraIndex: number,
  bufferIndex: number,
): number {
  const n = views.headerI[H_NODE_COUNT]
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  const maxInstances = views.headerI[H_MAX_INSTANCES]
  const { order, group, world, instPool, instCounts, instOffsets, bits, groupTouch, groupFlip, headerI, headerU } = views
  const bitsBaseV = bitsBase(views, bufferIndex, cameraIndex)
  const countsBase = instBase(views, bufferIndex, cameraIndex)
  const offsetsBase = countsBase
  const pool = instancePoolBase(views, bufferIndex, cameraIndex)
  const words = views.bitsWords

  if (cursors.length < groupCount) cursors = new Int32Array(groupCount)

  // ── Task 85: a visibility diff against the previous epoch → per-camera stamps ──
  const flipBase = cameraIndex * views.groupMax
  if (headerI[H_COLLECT_LAYOUT_EPOCH] !== headerI[H_LAYOUT_EPOCH]) {
    // The ranks were reshuffled by pack — a diff over ranks is meaningless: we touch
    // all groups of ALL cameras (conservatively — an extra upload, not a skipped one).
    headerI[H_COLLECT_LAYOUT_EPOCH] = headerI[H_LAYOUT_EPOCH]
    const stamp = headerU[H_CLOCK] + 1
    for (let c = 0; c < views.cameraMax; c++) {
      const fb = c * views.groupMax
      for (let g = 0; g < groupCount; g++) groupFlip[fb + g] = stamp
    }
    for (let g = 0; g < groupCount; g++) groupTouch[g] = stamp
    headerU[H_CLOCK] = stamp
  } else {
    const prevBase = bitsBase(views, bufferIndex ^ 1, cameraIndex)
    const stamp = headerU[H_CLOCK] + 1
    let touched = false
    for (let w = 0; w < words; w++) {
      const cur = bits[bitsBaseV + w]
      const prev = bits[prevBase + w]
      if (cur === prev) continue
      let flips = cur ^ prev
      const rBase = w << 5
      while (flips !== 0) {
        const lb = flips & -flips
        flips ^= lb
        const r = rBase + 31 - Math.clz32(lb)
        if (r >= n) break // the last word's padding — not nodes
        const g = group[order[r]]
        if (g >= 0 && g < groupCount) {
          groupFlip[flipBase + g] = stamp
          touched = true
        }
      }
    }
    if (touched) headerU[H_CLOCK] = stamp
  }

  // 1) Counting per group (a rank traversal; Task 85 measurements — see the header).
  // Task 143: the walk is WORD-WISE (the diff walk's own shape — a zero word
  // costs one load + test instead of 32 rank iterations, the per-rank mask
  // `1 << (r & 31)` and the per-rank word reload die; ranks are visited in
  // the SAME ascending order: lowest set bit first, words ascending).
  for (let g = 0; g < groupCount; g++) instCounts[countsBase + g] = 0
  const nodeFlags = views.nodeFlags
  for (let w = 0; w < words; w++) {
    let word = bits[bitsBaseV + w]
    if (word === 0) continue
    const rBase = w << 5
    while (word !== 0) {
      const lb = word & -word
      word ^= lb
      const r = rBase + 31 - Math.clz32(lb)
      if (r >= n) break // the last word's padding — not nodes
      const slot = order[r]
      const g = group[slot]
      if (g < 0 || g >= groupCount) continue
      if ((nodeFlags[slot] & NF_VISIBLE) !== 0) instCounts[countsBase + g]++
    }
  }

  // 2) Prefix offsets (the group segments go in id order).
  let total = 0
  for (let g = 0; g < groupCount; g++) {
    instOffsets[offsetsBase + g] = total
    cursors[g] = 0
    total += instCounts[countsBase + g]
  }

  // 3) Filling the pool.
  // Task 143: word-wise walk (the counting pass's shape) + the 16-float
  // matrix copy UNROLLED — JSC did not unroll the k-loop (measured: the
  // unroll alone is −30% of the fill pass; the sandbox checksums over a
  // 100k-node / 50%-visible synthetic walk came out bit-identical).
  let dropped = 0
  for (let w = 0; w < words; w++) {
    let word = bits[bitsBaseV + w]
    if (word === 0) continue
    const rBase = w << 5
    while (word !== 0) {
      const lb = word & -word
      word ^= lb
      const r = rBase + 31 - Math.clz32(lb)
      if (r >= n) break
      const slot = order[r]
      const g = group[slot]
      if (g < 0 || g >= groupCount) continue
      if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
      const dst = instOffsets[offsetsBase + g] + cursors[g]
      if (dst >= maxInstances) {
        dropped++
        continue
      }
      cursors[g]++
      const src = slot * 16
      const o = pool + dst * 16
      instPool[o] = world[src]
      instPool[o + 1] = world[src + 1]
      instPool[o + 2] = world[src + 2]
      instPool[o + 3] = world[src + 3]
      instPool[o + 4] = world[src + 4]
      instPool[o + 5] = world[src + 5]
      instPool[o + 6] = world[src + 6]
      instPool[o + 7] = world[src + 7]
      instPool[o + 8] = world[src + 8]
      instPool[o + 9] = world[src + 9]
      instPool[o + 10] = world[src + 10]
      instPool[o + 11] = world[src + 11]
      instPool[o + 12] = world[src + 12]
      instPool[o + 13] = world[src + 13]
      instPool[o + 14] = world[src + 14]
      instPool[o + 15] = world[src + 15]
    }
  }
  if (dropped > 0) views.headerI[H_DROPPED_INSTANCES] += dropped
  return total - dropped
}

/** The matrix segment of group g of a camera in buffer b (a view — no copies). */
export function instanceMatricesView(
  views: SceneViews,
  bufferIndex: number,
  cameraIndex: number,
  group: number,
): { matrices: Float32Array; count: number } {
  const base = instBase(views, bufferIndex, cameraIndex)
  const count = Math.max(0, views.instCounts[base + group])
  const offset = views.instOffsets[base + group]
  const pool = instancePoolBase(views, bufferIndex, cameraIndex)
  return {
    matrices: views.instPool.subarray(pool + offset * 16, pool + (offset + count) * 16),
    count,
  }
}

/**
 * Simple instance collection into a user array (the T0 path without a pool):
 * the matrices of the group's visible nodes, back to back. Returns the number written.
 *
 * Task 186 — the walk is WORD-BLOCKED, the bit test is FIRST: the outer loop
 * loads one visibility word per 32 ranks — a zero word skips the whole block
 * (one load + test instead of 32 rank iterations), a nonzero word enters the
 * rank loop where the register-only bit reject runs BEFORE the order/group
 * loads (an invisible rank touches no memory at all). The measurements
 * (scripts/task186-micro.mjs, 100k nodes / 45% visibility — the demo's band):
 * −46% on a large group (~50% of nodes), −20% on a small group (~1%, 100
 * groups), vs the old flat rank loop. The ctz-extraction walk (Task 143's
 * pool-pass shape) was TRIED here and REJECTED: it pays bit-extraction for
 * every VISIBLE rank of OTHER groups too — +15% on a small group, +33% on an
 * all-groups sweep; it only wins when the group ≈ all visible nodes, and even
 * there the word-blocked shape is within 4%. The 16-float copy is UNROLLED
 * (Task 143's fill-pass measurement: JSC does not unroll the k-loop itself,
 * the unroll alone was −30% there) and the capacity is hoisted: `out.length >>> 4`
 * full matrices, one compare per written matrix instead of `k*16+16 > length`
 * arithmetic per rank.
 */
export function collectGroupMatrices(
  views: SceneViews,
  cameraIndex: number,
  bufferIndex: number,
  groupId: number,
  out: Float32Array,
): number {
  const n = views.headerI[H_NODE_COUNT]
  const { order, group, world, bits, nodeFlags } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const capacity = out.length >>> 4 // full 16-float matrices that fit in out
  const wEnd = Math.min(views.bitsWords, (n + 31) >>> 5) // words carrying nodes
  let k = 0
  scan: for (let w = 0; w < wEnd; w++) {
    const word = bits[base + w]
    if (word === 0) continue // a fully invisible block — 32 ranks skipped
    const rEnd = Math.min((w << 5) + 32, n)
    for (let r = w << 5; r < rEnd; r++) {
      if ((word & (1 << (r & 31))) === 0) continue // register-only reject first
      const slot = order[r]
      if (group[slot] !== groupId) continue
      if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
      if (k >= capacity) break scan
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
