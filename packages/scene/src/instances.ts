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

// ─── Task 191: N4 — the GROUP-SPHERE PRE-REJECT (the Task-189 dossier) ──────
//
// THE ENCLOSING ARGUMENT: a group's bounding sphere (the minimal sphere
// enclosing the members' world spheres) that is entirely OUTSIDE one of the
// camera's six planes means every member sphere is outside that plane too —
// the frustum cull left every member's bit at 0 — the whole scan below
// would return 0. Six dot products instead of a word-walk over all ranks.
//
// The spheres live per scene (a WeakMap keyed by the views object — the
// Task-190 lesson: module-level arrays collide across scenes) and are
// maintained INCREMENTALLY through the Task-85 stamp discipline:
//   • a member's sphereW changes — updateWorld already stamped groupTouch
//     of that member's group;
//   • a composition change — Task 191 makes setGroup stamp the OLD and the
//     NEW group (it stamped NOTHING before — a hole in the Task-85 upload
//     skip AND the Task-190 pool memo: a member moving between groups left
//     both instance buffers stale);
//   • a grouped INTERNAL node's auto-bound changes — Task 191 makes the
//     refit stamp that group (the combine rewrites sphereW).
// A rebuild is one O(n) rank walk over the group's members (AABB pass +
// radius pass — the Task-189 probe's shape, without the N2 tail segments:
// the segments make it O(|g|); until N2 lands the walk pays O(n) per dirty
// group, honestly documented — static groups never rebuild).
//
// SOUNDNESS DOMAIN (the documented contract): the pre-reject reasons about
// bits PRODUCED BY A REAL CULL over the same sphereW/planes — the pipeline
// contract. Raw `views.bits[i] = …` hacks desynchronize the bits from the
// spheres and fall outside every stamp family (the Task-186 property
// fixture writes bits directly — it runs under the kill-switch).
//
// The kill-switch (setGroupSphereReject(false)) restores the pure
// word-blocked scan bit-for-bit.

/** Task 191 — enable/disable the group-sphere pre-reject. */
let groupSphereEnabled = true
/** Task 191 — honest counters. */
let prejectRejects = 0
let prejectChecks = 0
let sphereBuilds = 0

interface GroupSphereState {
  /** groupMax × 4: (cx, cy, cz, r); r ≤ 0 — empty/unknown, never reject. */
  readonly spheres: Float32Array
  /** Per group: the groupTouch stamp the sphere covers (−1 — never built). */
  readonly built: Int32Array
}

const groupSpheres = new WeakMap<SceneViews, GroupSphereState>()

function groupSpheresFor(views: SceneViews): GroupSphereState {
  let state = groupSpheres.get(views)
  if (state === undefined) {
    state = {
      spheres: new Float32Array(views.groupMax * 4),
      built: new Int32Array(views.groupMax).fill(-1),
    }
    groupSpheres.set(views, state)
  }
  return state
}

/** Builds group g's sphere: one rank walk — the AABB pass, then the
 *  minimal enclosing radius of the members (the Task-189 probe's shape). */
function buildGroupSphere(views: SceneViews, g: number): void {
  const n = views.headerI[H_NODE_COUNT]
  const { order, group, sphereW, groupTouch } = views
  const state = groupSpheresFor(views)
  const o4g = g * 4
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  let count = 0
  for (let r = 0; r < n; r++) {
    const slot = order[r]
    if (group[slot] !== g) continue
    const o4 = slot * 4
    const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2], rad = sphereW[o4 + 3]
    const x0 = cx - rad, x1 = cx + rad, y0 = cy - rad, y1 = cy + rad, z0 = cz - rad, z1 = cz + rad
    if (x0 < minX) minX = x0
    if (x1 > maxX) maxX = x1
    if (y0 < minY) minY = y0
    if (y1 > maxY) maxY = y1
    if (z0 < minZ) minZ = z0
    if (z1 > maxZ) maxZ = z1
    count++
  }
  if (count === 0) {
    state.spheres[o4g + 3] = -1 // empty — never reject (the scan is cheap)
  } else {
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5
    let radius = 0
    for (let r = 0; r < n; r++) {
      const slot = order[r]
      if (group[slot] !== g) continue
      const o4 = slot * 4
      const dx = sphereW[o4] - cx, dy = sphereW[o4 + 1] - cy, dz = sphereW[o4 + 2] - cz
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + sphereW[o4 + 3]
      if (d > radius) radius = d
    }
    state.spheres[o4g] = cx
    state.spheres[o4g + 1] = cy
    state.spheres[o4g + 2] = cz
    state.spheres[o4g + 3] = radius
  }
  state.built[g] = groupTouch[g]
  sphereBuilds++
}

/** Task 191 — the kill-switch: false restores the pure word-blocked scan. */
export function setGroupSphereReject(enabled: boolean): void {
  groupSphereEnabled = enabled
}

/** Task 191 — the pre-reject's honest counters. */
export function groupSphereCounters(): { rejects: number; checks: number; builds: number } {
  return { rejects: prejectRejects, checks: prejectChecks, builds: sphereBuilds }
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
  // Task 191 — N4: the group's enclosing sphere against the 6 planes. Outside
  // one ⟹ every member's cull bit is 0 ⟹ the scan would return 0 — six dot
  // products end it here. Sound under the pipeline contract (bits from a
  // real cull over the same sphereW — see the N4 block's header note).
  if (groupSphereEnabled && groupSphereReject(views, cameraIndex, groupId)) {
    prejectRejects++
    return 0
  }
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
