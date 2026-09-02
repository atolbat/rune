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

/** Whether a rank is visible (bit + node flag). */
function rankVisible(views: SceneViews, base: number, r: number, slot: number): boolean {
  if ((views.bits[base + (r >>> 5)] & (1 << (r & 31))) === 0) return false
  return (views.nodeFlags[slot] & NF_VISIBLE) !== 0
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
  for (let g = 0; g < groupCount; g++) instCounts[countsBase + g] = 0
  const nodeFlags = views.nodeFlags
  for (let r = 0; r < n; r++) {
    if ((bits[bitsBaseV + (r >>> 5)] & (1 << (r & 31))) === 0) continue
    const slot = order[r]
    const g = group[slot]
    if (g < 0 || g >= groupCount) continue
    if ((nodeFlags[slot] & NF_VISIBLE) !== 0) instCounts[countsBase + g]++
  }

  // 2) Prefix offsets (the group segments go in id order).
  let total = 0
  for (let g = 0; g < groupCount; g++) {
    instOffsets[offsetsBase + g] = total
    cursors[g] = 0
    total += instCounts[countsBase + g]
  }

  // 3) Filling the pool.
  let dropped = 0
  for (let r = 0; r < n; r++) {
    if ((bits[bitsBaseV + (r >>> 5)] & (1 << (r & 31))) === 0) continue
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
    for (let k = 0; k < 16; k++) instPool[o + k] = world[src + k]
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
 */
export function collectGroupMatrices(
  views: SceneViews,
  cameraIndex: number,
  bufferIndex: number,
  groupId: number,
  out: Float32Array,
): number {
  const n = views.headerI[H_NODE_COUNT]
  const { order, group, world } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  let k = 0
  for (let r = 0; r < n; r++) {
    const slot = order[r]
    if (group[slot] !== groupId) continue
    if (!rankVisible(views, base, r, slot)) continue
    if (k * 16 + 16 > out.length) break
    const src = slot * 16
    for (let j = 0; j < 16; j++) out[k * 16 + j] = world[src + j]
    k++
  }
  return k
}
