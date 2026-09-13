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
  tailLayoutOn,
} from './layout.ts'
import { bitsBase } from './culling.ts'
import { groupSpheresFor, buildGroupSphere, groupSphereBuildCount } from './groupBounds.ts'

// ─── Task 192: the SEGMENT collects (the Task-189 N2+N1 dossier) ──────
//
// pack() keeps every group's leaves in ONE contiguous rank range —
// [gStart[g], gStart[g+1]). The segment collect scans ONLY that range's
// words: no order[], no group[], no per-rank indirection — the visible
// members' matrices are read SEQUENTIALLY from the rank-major world rows,
// and a fully-visible group (gHidden === 0 + all bits set) is ONE block
// copy. The sweep win (the dossier, 100k nodes): the all-groups sweep
// −96.7%, small groups −96%, out-of-frustum groups −99%.
//
// The LEAF-DOMAIN CONTRACT (documented, tested): a tail member is a
// grouped LEAF; a grouped node WITH children keeps its DFS placement and
// is NOT an instance in the ON mode (setTailLayout(false) restores the
// pre-192 full-scan semantics bit-for-bit — the legacy walk below).
//
// Honest counters: segmentScans (the word-bounded walks) / blockCopies
// (the one-call fast paths) / popcounts (the hidden-free counting).

/** Task 192 — honest counters. */
let segmentScans = 0
let blockCopies = 0
let popcounts = 0

/** Task 192 — the segment collect's honest counters (diagnostics/tests). */
export function tailCounters(): { scans: number; blocks: number; popcounts: number } {
  return { scans: segmentScans, blocks: blockCopies, popcounts }
}

/** The SWAR popcount of the bitset words over [s, e) (masked head/tail). */
function popcountRange(bits: Uint32Array, base: number, s: number, e: number): number {
  const sWord = s >>> 5
  const eWord = (e - 1) >>> 5
  const sOff = s & 31
  const eOff = e & 31
  let count = 0
  for (let w = sWord; w <= eWord; w++) {
    let v = bits[base + w]
    if (w === sWord && sOff !== 0) v &= -1 << sOff
    if (w === eWord && eOff !== 0) v &= (1 << eOff) - 1
    if (v === 0) continue
    v = v - ((v >>> 1) & 0x55555555)
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
    v = (v + (v >>> 4)) & 0x0f0f0f0f
    count += (v * 0x01010101) >>> 24
  }
  return count
}

/** True ⟺ every bit of [s, e) is set in the bitset (masked head/tail). */
function allBitsSet(bits: Uint32Array, base: number, s: number, e: number): boolean {
  const sWord = s >>> 5
  const eWord = (e - 1) >>> 5
  const sOff = s & 31
  const eOff = e & 31
  const headMask = sOff === 0 ? -1 : -1 << sOff
  const tailMask = eOff === 0 ? -1 : (1 << eOff) - 1
  for (let w = sWord; w <= eWord; w++) {
    const m = w === sWord ? (sWord === eWord ? headMask & tailMask : headMask) : w === eWord ? tailMask : -1
    if ((bits[base + w] & m) !== m) return false
  }
  return true
}

// ─── Task 190: the POOL MEMO (the Task-189 N3a theory, production) ──────────
//
// The pool pass (counting + prefix + fill) is a PURE function of the bits,
// the worlds, the groups and the node flags — all of which mutate through
// the API, which stamps the shared H_CLOCK. The flip-diff at the top of
// collectInstancesViews already answers "did THIS camera's bits change since
// the previous frame"; the pool memo answers the complementary question:
// "did anything at all change since the LAST FULL COLLECT of THIS
// (buffer, camera)". Both answers "no" ⟹ the counts, the offsets, the pool
// bytes and the return value in the buffer are exactly what the full pass
// would recompute ⟹ serve the cached total and skip counting+prefix+fill.
//
// The check is ONE integer compare: H_CLOCK has not moved since the memo was
// written. Invalidation rides on the existing stamp discipline:
//   • a flip frame — the diff stamps groupFlip (clock+1) → miss;
//   • a pack — the diff's epoch branch stamps ALL groups (clock+1) → miss
//     (it runs BEFORE the memo check, by construction);
//   • setVisible / updateWorld / setLocal — the stamps move the clock → miss;
//   • refit — Task 190 makes it bump the clock when it writes spheres (the
//     collect does not read spheres, but one shared clock means one
//     conservative re-collect on a refit frame — the same frame's
//     updateWorld has already missed the memo anyway);
//   • plane changes that flip bits — the diff catches them → miss. A plane
//     change that flips NOTHING leaves the pool identical — a hit is correct.
//
// The miss price is the flip-diff itself (O(bitsWords) — ~0.002ms on a
// 100k-node scene) + one WeakMap lookup. The memo state is keyed by the
// views object (module-level arrays would collide across scenes — the
// isolated probes had one scene; production has many). Thread-local by
// construction (the worker's pipeline holds its own memo over the same SAB).
//
// The kill-switch (setCollectMemo(false)) restores the always-full behavior
// bit-for-bit; the counters are the honest diagnostics (hits = skipped passes).

/** Task 190 — enable/disable the pool memo (tests, A/B diagnostics). */
let collectMemoEnabled = true
/** Task 190 — honest counters. */
let collectMemoHits = 0
let collectMemoMisses = 0

interface CollectMemoState {
  /** Per (buffer, camera): the H_CLOCK at the last full collect (−1 — never). */
  readonly clock: Int32Array
  /** Per (buffer, camera): the cached return value (total − dropped). */
  readonly total: Int32Array
}

const collectMemos = new WeakMap<SceneViews, CollectMemoState>()

function collectMemoFor(views: SceneViews): CollectMemoState {
  let memo = collectMemos.get(views)
  if (memo === undefined) {
    const slots = 2 * views.cameraMax
    memo = {
      clock: new Int32Array(slots).fill(-1),
      total: new Int32Array(slots),
    }
    collectMemos.set(views, memo)
  }
  return memo
}

/** Task 190 — the kill-switch: false restores the pre-190 always-full collect. */
export function setCollectMemo(enabled: boolean): void {
  collectMemoEnabled = enabled
}

/** Task 190 — the memo's honest counters (diagnostics/tests). */
export function collectMemoCounters(): { hits: number; misses: number } {
  return { hits: collectMemoHits, misses: collectMemoMisses }
}

// ─── Task 191: N4 — the GROUP-SPHERE PRE-REJECT (the Task-189 dossier) ───
//
// THE ENCLOSING ARGUMENT: a group's bounding sphere (the minimal sphere
// enclosing the members' world spheres) that is entirely OUTSIDE one of the
// camera's six planes means every member sphere is outside that plane too —
// the frustum cull left every member's bit at 0 — the whole scan below
// would return 0. Six dot products instead of a word-walk over all ranks.
//
// The SPHERE CACHE lives in groupBounds.ts (Task 193: extracted — the cull's
// TAIL SEGMENT CLASSIFICATION shares the exact state and the exact stamps;
// culling.ts cannot import THIS module — instances imports culling for
// bitsBase, the cycle had to break one level down). The maintenance story
// (the Task-85 stamp discipline: updateWorld / setVisible / setGroup /
// refit-combine) and the soundness domain (bits produced by a real cull
// over the same sphereW/planes — the pipeline contract) are documented
// THERE; this section keeps the COLLECT's consumer: the pre-reject check.
//
// The kill-switch (setGroupSphereReject(false)) restores the pure
// word-blocked scan bit-for-bit.

/** Task 191 — enable/disable the group-sphere pre-reject. */
let groupSphereEnabled = true
/** Task 191 — honest counters. */
let prejectRejects = 0
let prejectChecks = 0


/** Task 191 — the kill-switch: false restores the pure word-blocked scan. */
export function setGroupSphereReject(enabled: boolean): void {
  groupSphereEnabled = enabled
}

/** Task 191 — the pre-reject's honest counters. */
export function groupSphereCounters(): { rejects: number; checks: number; builds: number } {
  return { rejects: prejectRejects, checks: prejectChecks, builds: groupSphereBuildCount() }
}

/** The pre-reject check: true ⟹ the scan below would return 0 (enclosure). */
function groupSphereReject(views: SceneViews, cameraIndex: number, groupId: number): boolean {
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  if (groupId < 0 || groupId >= groupCount) return false
  const { groupTouch, planes } = views
  const state = groupSpheresFor(views)
  if (groupTouch[groupId] > state.built[groupId]) buildGroupSphere(views, groupId)
  prejectChecks++
  const o4 = groupId * 4
  const r = state.spheres[o4 + 3]
  if (r <= 0) return false // empty / unknown — never reject
  const pb = cameraIndex * 24
  const cx = state.spheres[o4], cy = state.spheres[o4 + 1], cz = state.spheres[o4 + 2]
  for (let i = 0; i < 6; i++) {
    const p = pb + i * 4
    if (planes[p] * cx + planes[p + 1] * cy + planes[p + 2] * cz + planes[p + 3] < -r) return true
  }
  return false
}

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
  const { order, group, instPool, instCounts, instOffsets, bits, groupTouch, groupFlip, headerI, headerU } = views
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

  // ── Task 190: the POOL MEMO check — after the flip-diff by construction:
  // a pack already stamped everything (clock moved) inside the diff above,
  // so ONE integer compare decides whether the counting+prefix+fill below
  // would rewrite the very bytes that are already in the buffer.
  const memoIdx = bufferIndex * views.cameraMax + cameraIndex
  const memo: CollectMemoState | undefined = collectMemoEnabled ? collectMemoFor(views) : undefined
  const memoClock = memo !== undefined ? memo.clock[memoIdx] : 0
  if (memo !== undefined && memoClock === headerU[H_CLOCK]) {
    collectMemoHits++
    const cached = memo.total[memoIdx]
    return cached !== undefined ? cached : 0
  }

  // 1) Counting per group (a rank traversal; Task 85 measurements — see the header).
  // Task 192: with the tail layout the members are per-group CONTIGUOUS rank
  // ranges — the counting walks ONLY the segment's words (gHidden === 0 →
  // the SWAR popcount, zero per-member loads; the hidden case → the ctz walk
  // with the nodeFlags test). The legacy word-walk stays for the kill-switch
  // mode (verbatim).
  for (let g = 0; g < groupCount; g++) instCounts[countsBase + g] = 0
  const nodeFlags = views.nodeFlags
  const world = views.world
  let total = 0
  if (tailLayoutOn()) {
    for (let g = 0; g < groupCount; g++) {
      cursors[g] = 0
      const gs = views.gStart[g]
      const ge = views.gStart[g + 1]
      if (gs >= ge) continue
      let count: number
      if (views.gHidden[g] === 0) {
        count = popcountRange(bits, bitsBaseV, gs, ge)
        popcounts++
      } else {
        count = 0
        for (let w = gs >>> 5; w <= (ge - 1) >>> 5; w++) {
          const word = bits[bitsBaseV + w]
          if (word === 0) continue
          const rLo = Math.max(w << 5, gs)
          const rHi = Math.min((w << 5) + 32, ge)
          for (let r = rLo; r < rHi; r++) {
            if ((word & (1 << (r & 31))) === 0) continue
            if ((nodeFlags[views.order[r]] & NF_VISIBLE) !== 0) count++
          }
        }
      }
      instCounts[countsBase + g] = count
      total += count
    }
  } else {
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
    for (let g = 0; g < groupCount; g++) total += instCounts[countsBase + g]
  }

  // 2) Prefix offsets (the group segments go in id order).
  total = 0
  for (let g = 0; g < groupCount; g++) {
    instOffsets[offsetsBase + g] = total
    cursors[g] = 0
    total += instCounts[countsBase + g]
  }

  // 3) Filling the pool.
  // Task 143: the 16-float matrix copy UNROLLED — JSC did not unroll the
  // k-loop itself (measured: the unroll alone is −30% of the fill pass; the
  // sandbox checksums over a 100k-node / 50%-visible walk came out
  // bit-identical).
  // Task 192: the SEGMENT fill — the group's members are contiguous ranks,
  // the source is a SEQUENTIAL world block; a fully-visible group that fits
  // the pool (gHidden === 0 + every bit set) is ONE instPool.set — the
  // block copy. The nodeFlags test runs only when the segment has hidden
  // members. The legacy word-walk (kill-switch mode) is verbatim below.
  let dropped = 0
  if (tailLayoutOn()) {
    for (let g = 0; g < groupCount; g++) {
      const gs = views.gStart[g]
      const ge = views.gStart[g + 1]
      const count = instCounts[countsBase + g]
      if (count === 0) continue
      const off = instOffsets[offsetsBase + g]
      const segLen = ge - gs
      const hidden = views.gHidden[g]
      // The block fast path: no hidden members + every segment bit set +
      // the whole segment fits the pool → one copy.
      if (hidden === 0 && count === segLen && off + segLen <= maxInstances
        && allBitsSet(bits, bitsBaseV, gs, ge)) {
        instPool.set(world.subarray(gs * 16, ge * 16), pool + off * 16)
        cursors[g] = segLen
        blockCopies++
        continue
      }
      for (let w = gs >>> 5; w <= (ge - 1) >>> 5; w++) {
        const word = bits[bitsBaseV + w]
        if (word === 0) continue
        const rLo = Math.max(w << 5, gs)
        const rHi = Math.min((w << 5) + 32, ge)
        for (let r = rLo; r < rHi; r++) {
          if ((word & (1 << (r & 31))) === 0) continue
          if (hidden > 0 && (nodeFlags[views.order[r]] & NF_VISIBLE) === 0) continue
          const dst = off + cursors[g]
          if (dst >= maxInstances) {
            dropped++
            continue
          }
          cursors[g]++
          const src = r * 16 // Task 192 (N1): the rank-major row
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
    }
    segmentScans++
  } else {
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
        const src = r * 16 // Task 192 (N1): the rank-major row
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
  }
  if (dropped > 0) views.headerI[H_DROPPED_INSTANCES] += dropped
  const collected = total - dropped
  // ── Task 190: the memo save — the full pass has just rewritten this
  // (buffer, camera)'s counts/offsets/pool deterministically; the clock NOW
  // is the identity of that content until something stamps it.
  if (collectMemoEnabled && memo !== undefined) {
    memo.clock[memoIdx] = headerU[H_CLOCK]
    memo.total[memoIdx] = collected
    collectMemoMisses++
  }
  return collected
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
 * Task 192 — the SEGMENT path (the default): with the tail layout the group's
 * leaves are ONE contiguous rank range [gStart[g], gStart[g+1]) — the walk is
 * word-bounded to the range (no order[]/group[] loads at all), the matrix
 * source is the rank-major world block (sequential reads), and a fully-visible
 * segment (gHidden === 0 + every bit set) is ONE out.set block copy. The
 * dossier's numbers (100k nodes): the all-groups sweep −96.7%, small groups
 * −96%, out-of-frustum groups −99% (with the Task-191 pre-reject composing).
 *
 * Task 186 — the LEGACY walk (the kill-switch mode and out-of-domain group
 * ids): WORD-BLOCKED, the bit test FIRST — the outer loop loads one
 * visibility word per 32 ranks — a zero word skips the whole block (one load
 * + test instead of 32 rank iterations), a nonzero word enters the rank loop
 * where the register-only bit reject runs BEFORE the order/group loads (an
 * invisible rank touches no memory at all). The measurements
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
  // Task 191 — N4: the group's enclosing sphere against the 6 planes. Outside
  // one ⟹ every member's cull bit is 0 ⟹ the scan would return 0 — six dot
  // products end it here. Sound under the pipeline contract (bits from a
  // real cull over the same sphereW — see the N4 block's header note).
  if (groupSphereEnabled && groupSphereReject(views, cameraIndex, groupId)) {
    prejectRejects++
    return 0
  }
  // Task 192: the SEGMENT path — dense group ids under the tail layout.
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  if (tailLayoutOn() && groupId >= 0 && groupId < groupCount) {
    const gs = views.gStart[groupId]
    const ge = views.gStart[groupId + 1]
    if (gs >= ge) return 0 // no leaf members — the leaf-domain contract
    const hidden = views.gHidden[groupId]
    // The fully-visible fast path: no hidden members + every segment bit set
    // → ONE block copy (the rank-major rows are already contiguous).
    if (hidden === 0 && allBitsSet(bits, base, gs, ge)) {
      const k = Math.min(ge - gs, capacity)
      out.set(world.subarray(gs * 16, (gs + k) * 16))
      blockCopies++
      return k
    }
    // The word-bounded walk: the bit test first; the nodeFlags test only
    // when the segment has hidden members; the source read sequentially.
    let k = 0
    scan: for (let w = gs >>> 5; w <= (ge - 1) >>> 5; w++) {
      const word = bits[base + w]
      if (word === 0) continue // a fully invisible block — 32 ranks skipped
      const rLo = Math.max(w << 5, gs)
      const rHi = Math.min((w << 5) + 32, ge)
      for (let r = rLo; r < rHi; r++) {
        if ((word & (1 << (r & 31))) === 0) continue // register-only reject first
        if (hidden > 0) {
          if ((nodeFlags[order[r]] & NF_VISIBLE) === 0) continue
        }
        if (k >= capacity) break scan
        const src = r * 16 // Task 192 (N1): the rank-major row
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
    segmentScans++
    return k
  }
  // The LEGACY walk: the kill-switch mode + out-of-domain group ids (the
  // pre-192 semantics — a full scan finds any node whose group[slot] matches).
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
      const src = r * 16 // Task 192 (N1): the rank-major row
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

// ─── Task 193 (theory A): the GPU INSTANCE SOURCE (the bit-discard contract) ──
//
// The Task-189 GPU probe proved the semantics (pixel parity: draw ALL n
// instances, the VERTEX shader reads the member's visibility bit from a
// storage buffer and collapses the invisible to clip — the CPU collect pass
// leaves the frame); Task 193 wires the renderer side (the group-2
// read-only storage binding, @rune/webgpu's spec.storage) and this — the
// scene-side SOURCE VIEWS over the exact buffers the shader needs.
//
// THE CONTRACT (the tail layout makes it all contiguous — Task 192):
//   • matrices — the group's rank-major WORLD rows, one 64-byte instance
//     record each (4 vec4 COLUMNS, stride 64, step 'instance'): the vertex
//     attribute source (bindExternalVertexBuffer / writeExternalBuffer —
//     the SAB view is a legal writeBuffer source, the queue snapshots the
//     bytes at call time);
//   • instances — the SEGMENT size |g| (draw n; the shader filters);
//   • bits — the camera's visibility bitset words (rank space — the storage
//     buffer source, u32 words);
//   • rankBase — the segment's first rank (the uniform): the shader's
//     instance_index maps to rank = rankBase + ii, word = rank >> 5,
//     bit = 1 << (rank & 31);
//   • gHidden — the NF_VISIBLE-off members of the segment. The snippet
//     below is gHidden === 0-ONLY (the bits are FRUSTUM-only by design —
//     the CPU collect folds NF_VISIBLE in; a segment with hidden members
//     falls back to the CPU collect path, honestly).
//
// The kill-switch family does not apply here: the source is a pure view
// over the live buffers — nothing is computed, nothing can be turned off.

/** The GPU-side draw source of one instance group's segment (Task 193). */
export interface GpuInstanceSource {
  /** The segment's world matrices — rank-major rows [gStart*16, gEnd*16):
   *  one instance record (4 vec4 columns, stride 64). A VIEW — no copy. */
  readonly matrices: Float32Array
  /** The segment size: the DRAW's instance count (all of it — the shader
   *  filters; the CPU compaction is what this replaces). */
  readonly instances: number
  /** The camera's bitset words (rank space — the storage source). A VIEW. */
  readonly bits: Uint32Array
  /** The segment's first rank — the shader's uniform (rank = rankBase + ii). */
  readonly rankBase: number
  /** The segment's NF_VISIBLE-off members. The filter snippet is valid only
   *  for gHidden === 0 — fall back to the CPU collect otherwise. */
  readonly gHidden: number
}

/** The GPU source views of group g's segment for one camera/buffer (Task
 *  193, theory A). Valid until the next pack (the ranks move — repack
 *  changes rankBase/matrices; the bits double-buffer per epoch). The
 *  tail-layout kill-switch (setTailLayout(false)) leaves the segments
 *  empty — the caller checks `instances === 0` (the legacy layout has no
 *  contiguous segments; the bit-discard path needs the Task-192 layout). */
export function gpuInstanceSource(
  views: SceneViews,
  cameraIndex: number,
  bufferIndex: number,
  groupId: number,
): GpuInstanceSource {
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  const base = bitsBase(views, bufferIndex, cameraIndex)
  if (groupId < 0 || groupId >= groupCount || !tailLayoutOn()) {
    return {
      matrices: views.world.subarray(0, 0),
      instances: 0,
      bits: views.bits.subarray(base, base),
      rankBase: 0,
      gHidden: 0,
    }
  }
  const gs = views.gStart[groupId]
  const ge = views.gStart[groupId + 1]
  return {
    matrices: views.world.subarray(gs * 16, ge * 16),
    instances: ge - gs,
    bits: views.bits.subarray(base, base + views.bitsWords),
    rankBase: gs,
    gHidden: views.gHidden[groupId],
  }
}

/** Task 193 — the WGSL bit-filter helper (the documented contract shape).
 *  The COMMAND's shader declares the storage itself:
 *    `@group(2) @binding(0) var<storage, read> sceneBits: array<u32>;`
 *  and passes u_rank0 (the source's rankBase) as a uniform. The contract:
 *  gHidden === 0 segments only (the bits are frustum-only — a segment with
 *  hidden members belongs to the CPU collect path). */
export const INSTANCE_BIT_FILTER_WGSL = `
/** rune: the visibility bit filter (Task 193 theory A — bit-discard).
 * ii = @builtin(instance_index); u_rank0 = the segment's first rank.
 * false -> collapse the instance to clip in the vertex shader. */
fn runeInstanceVisible(u_rank0: u32, ii: u32) -> bool {
  let rank = u_rank0 + ii
  let word = sceneBits[rank >> 5u]
  return (word & (1u << (rank & 31u))) != 0u
}`
