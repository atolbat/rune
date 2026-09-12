/**
 * task189-theories.mjs — Task 189: MORE isolated theories (the user asked to
 * "check the other theories and ideas too") — beyond Task 188's P1/P2/P3.
 * NOTHING here touches packages/ — every variant is a standalone function;
 * `real` is the CURRENT implementation imported from src. All variants are
 * bit-identical to `real` (sentinel-poisoned outs, truncated capacities,
 * stale tail bits, randomized property scenes).
 *
 * THEORY N1 — RANK-MAJOR MATRICES ("worldR"):
 *   The world matrices live by SLOT today (world[slot*16]); the collect pays
 *   order[r] indirection + a RANDOM 64-byte stride per visible node. Proposal:
 *   store the matrices by RANK (worldR[rank*16]) — updateWorld's walk IS by
 *   rank (the destination rank is the loop counter — free), the PARENT read
 *   becomes near-sequential (DFS locality: the parent's rank is close to the
 *   child's), pack permutes worldR on a reshuffle (amortized). Collect drops
 *   the order[] load for the matrix source entirely and reads SEQUENTIALLY.
 *   Measured: the walk + the matrix source pattern, the pack permutation fee,
 *   and the recompute-loop write-pattern delta (math excluded, honest label).
 *
 * THEORY N2 — GROUP-TAIL PACK ("instance leaves at the tail"):
 *   pack() emits TREE nodes first (DFS, grouped leaves EXCLUDED from the
 *   ranges), then the grouped leaves grouped-by-id in contiguous segments
 *   (a stable counting sort over the old ranks — member order preserved).
 *   Contract: grouped nodes are leaves (the demo pattern; a grouped parent
 *   keeps its DFS placement, just no tail segment). Effects:
 *   (a) a group = a CONTIGUOUS rank range [gStart[g], gStart[g+1)) — the
 *       collect word-scans ONLY the range's words: the group[slot] check
 *       DIES (the range IS the group), the walk is cache-local;
 *   (b) hierarchical culling covers [0, treeN) — the root loop's ranges
 *       exclude the tail by construction; the tail [treeN, n) is brute-culled
 *       (leaves — the hierarchical machinery adds nothing for them anyway;
 *       same bits, different cost profile — both measured);
 *   (c) composes with the P2 fold (nodeFlags dies) and with N1 (the matrix
 *       source becomes a CONTIGUOUS worldR block);
 *   (d) FULL-VISIBLE FAST PATH: when every bit of the range is set, the
 *       collect degenerates to ONE out.set(worldR.subarray(...)) block copy.
 *
 * THEORY N3 — COLLECT MEMO ("skip when nothing changed"):
 *   (a) POOL form: collectInstancesViews already diffs the epochs' bitsets
 *       (Task 85's groupFlip machinery) — the diff runs BEFORE the counting.
 *       Proposal: if the diff found NO flips AND H_CLOCK did not advance
 *       since the last pass (no updateWorld/setVisible stamps either), the
 *       pool is still valid → return the cached total, skip counting+fill.
 *       Fee: two compares (the diff itself is the existing fee — measured).
 *   (b) T0 form: per-frame attribution (the same word-diff shape, once per
 *       frame) marks dirty groups (bit flips + groupTouch stamps); a sweep
 *       skips clean groups ENTIRELY (their out buffer is contractually
 *       stable per group — the pool view / the feed's per-group buffer).
 *
 * THEORY N4 — GROUP-BOUNDS PRE-REJECT ("one sphere vs the frustum"):
 *   refit maintains a per-group bounding sphere (enclosing the members'
 *       world spheres). The sweep tests it against the camera's 6 planes
 *       BEFORE walking the group's segment: a fully-out group costs 6 dot
 *       products instead of |g| bit tests. Soundness: member spheres ⊂ the
 *       group sphere ⟹ outside the group sphere ⇒ every member's bit is 0
 *       ⇒ the walk would collect nothing (parity proves it anyway).
 *
 * THEORY N5 — CULL MEMO (reported with N3a): a static frame (planes
 *   unchanged + H_CLOCK unchanged) can skip culling too — the endgame for
 *   static scenes is a near-zero-CPU frame; the memo check is 24 float
 *   compares + 1 int compare.
 *
 * Variants (the dense-id domain, Task 188's narrowing):
 *   real  — the current src implementation (the reference);
 *   vR    — N1 alone: the current word-blocked walk, matrix source = worldR;
 *   vT    — N2 alone: the range word-scan (order/nodeFlags kept, slot-major);
 *   vTR   — N2+P2+N1: the range scan over the folded bits, worldR source;
 *   vTRfast — vTR + the all-visible block-copy fast path;
 *   vTRpre  — N4 + vTR: the group-sphere pre-reject;
 *   poolMemo / t0Collect — N3a / N3b.
 */
import {
  createScene, createCamera, cullViewsBrute, cullViewsHierarchical, writeCameraPlanes,
  collectGroupMatrices, collectInstancesViews, instancePoolBase, updateWorldViews,
  popcountBits,
} from '../packages/scene/src/index.ts'
import { bitsBase } from '../packages/scene/src/culling.ts'
import {
  H_NODE_COUNT, H_GROUP_COUNT, H_MAX_INSTANCES, H_DROPPED_INSTANCES, H_CLOCK,
  H_COLLECT_LAYOUT_EPOCH, H_LAYOUT_EPOCH, NF_VISIBLE,
} from '../packages/scene/src/layout.ts'

// ── the proposed derived structures ────────────────────────────────────────
let rankOf = new Int32Array(1024)      // N1: slot → rank
let worldR = new Float32Array(1024 * 16) // N1: rank-major matrices
let rankFlags = new Uint32Array(32)    // P2: rank-space NF_VISIBLE mirror
let effScratch = new Uint32Array(32)   // the folded bits
let gStart = new Int32Array(66)        // N2: tail segment starts (end = gStart[g+1])
let gCursor = new Int32Array(66)       // build scratch
let groupSpheres = new Float32Array(64 * 4) // N4: per-group bounding spheres
let groupCountNow = 0                  // the dense-id domain width
let tailStartNow = 0                   // N2: [tailStart, n) is the brute-culled tail

// N3b state
let snapBits = new Uint32Array(32)     // the bits the T0 memo last validated
let memoClockG = new Int32Array(64)    // per-group: the clock at the last collect
let memoKG = new Int32Array(64)        // per-group: the cached count
let dirtyG = new Uint8Array(64)        // per-group: this frame's dirt

// N3a state (per buffer×camera; cameraMax=1 in every fixture → 2 slots)
const poolMemoClock = new Int32Array(8).fill(-1)
const poolMemoTotal = new Int32Array(8)

function ensureInt32(arr, min, grow) { return arr.length < min ? new Int32Array(grow) : arr }

function buildRankOf(views) {
  const n = views.headerI[H_NODE_COUNT]
  rankOf = ensureInt32(rankOf, views.capacity, views.capacity * 2)
  const { order } = views
  for (let r = 0; r < n; r++) rankOf[order[r]] = r
}

/** N1: the pack-time permutation — world[slot] → worldR[rank] (the fee itself). */
function buildWorldR(views) {
  const n = views.headerI[H_NODE_COUNT]
  if (worldR.length < n * 16) worldR = new Float32Array(n * 32)
  const { order, world } = views
  for (let r = 0; r < n; r++) {
    const src = order[r] * 16
    const dst = r * 16
    for (let k = 0; k < 16; k++) worldR[dst + k] = world[src + k]
  }
}

/** P2 (Task 188, verbatim): the rank-space NF_VISIBLE mirror. */
function buildRankFlags(views) {
  const n = views.headerI[H_NODE_COUNT]
  const words = views.bitsWords
  if (rankFlags.length < words) { rankFlags = new Uint32Array(words * 2); effScratch = new Uint32Array(words * 2) }
  rankFlags.fill(0, 0, words)
  const { order, nodeFlags } = views
  for (let r = 0; r < n; r++) {
    if ((nodeFlags[order[r]] & NF_VISIBLE) !== 0) rankFlags[r >>> 5] |= 1 << (r & 31)
  }
}

/** P2 (verbatim): bits ∩ rankFlags → effScratch. */
function foldEff(views, base) {
  const words = views.bitsWords
  const bits = views.bits
  for (let w = 0; w < words; w++) effScratch[w] = bits[base + w] & rankFlags[w]
}

/**
 * N2: THE TAIL REPACK — tree nodes first (old-rank order, grouped leaves
 * filtered out), then the grouped leaves in per-group contiguous segments
 * (a stable counting scatter over the old ranks: the member order is
 * preserved). Rebuilds subtreeEnd for the new layout (the packInternal
 * shape) and bumps H_LAYOUT_EPOCH. The grouped nodes are LEAVES here (the
 * documented contract); nodes with g outside the dense ids stay in the tree
 * region (never in a tail segment, never collectable — the dense domain).
 */
function tailRepack(views) {
  const n = views.headerI[H_NODE_COUNT]
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  groupCountNow = groupCount
  const size = groupCount + 1
  if (gStart.length < size) { gStart = new Int32Array(size * 2); gCursor = new Int32Array(size * 2) }
  if (groupSpheres.length < groupCount * 4) groupSpheres = new Float32Array(groupCount * 8)
  const { order, group, parent, subtreeEnd } = views
  // 1) count the tail members per group; the tree nodes keep their order.
  gCursor.fill(0, 0, size)
  let treeN = 0
  for (let r = 0; r < n; r++) {
    const g = group[order[r]]
    if (g >= 0 && g < groupCount) gCursor[g]++
    else treeN++
  }
  let acc = treeN
  for (let g = 0; g < groupCount; g++) { gStart[g] = acc; acc += gCursor[g] }
  gStart[groupCount] = acc
  // 2) the stable scatter: tree nodes in old-rank order, then the segments.
  for (let g = 0; g < groupCount; g++) gCursor[g] = gStart[g]
  const order2 = new Int32Array(n)
  let t = 0
  for (let r = 0; r < n; r++) {
    const slot = order[r]
    const g = group[slot]
    if (g >= 0 && g < groupCount) order2[gCursor[g]++] = slot
    else order2[t++] = slot
  }
  views.order.set(order2)
  // 3) subtreeEnd for the new layout (packInternal's two passes, verbatim —
  // EXCEPT the reverse aggregation must SKIP the tail nodes: a grouped leaf's
  // parent must NOT absorb its rank (the tail is outside every tree range;
  // absorbing it was caught by the tree-fixture popcount probe).
  for (let r = 0; r < n; r++) subtreeEnd[order2[r]] = r + 1
  for (let r = n - 1; r >= 0; r--) {
    const slot = order2[r]
    const g = group[slot]
    if (g >= 0 && g < groupCount) continue // a TAIL node — not inside any tree range
    const p = parent[slot]
    if (p >= 0 && subtreeEnd[slot] > subtreeEnd[p]) subtreeEnd[p] = subtreeEnd[slot]
  }
  views.headerI[H_LAYOUT_EPOCH] = (views.headerI[H_LAYOUT_EPOCH] + 1) | 0
  tailStartNow = treeN
  return treeN
}

/** N2: the brute cull of the tail range [from, to) (cullViewsBrute's loop). */
function cullTailBrute(views, cameraIndex, bufferIndex, from, to) {
  const { order, sphereW, bits, planes } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const pb = cameraIndex * 24
  for (let r = from; r < to; r++) {
    const slot = order[r]
    const o4 = slot * 4
    const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2]
    const rad = sphereW[o4 + 3]
    let vis = true
    for (let i = 0; i < 6; i++) {
      const o = pb + i * 4
      if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] < -rad) { vis = false; break }
    }
    const w = base + (r >>> 5)
    const m = 1 << (r & 31)
    if (vis) bits[w] |= m
    else bits[w] &= ~m
  }
}

/** N4: the per-group bounding spheres (AABB of the member spheres → the
 * minimal enclosing sphere of the corners; two passes — the fee itself). */
function buildGroupSpheres(views) {
  const groupCount = groupCountNow
  const { order, sphereW } = views
  for (let g = 0; g < groupCount; g++) {
    const s = gStart[g], e = gStart[g + 1]
    const o4g = g * 4
    if (s >= e) { groupSpheres[o4g + 3] = -1; continue }
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let j = s; j < e; j++) {
      const o4 = order[j] * 4
      const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2], r = sphereW[o4 + 3]
      const x0 = cx - r, x1 = cx + r, y0 = cy - r, y1 = cy + r, z0 = cz - r, z1 = cz + r
      if (x0 < minX) minX = x0; if (x1 > maxX) maxX = x1
      if (y0 < minY) minY = y0; if (y1 > maxY) maxY = y1
      if (z0 < minZ) minZ = z0; if (z1 > maxZ) maxZ = z1
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2
    let rad = 0
    for (let j = s; j < e; j++) {
      const o4 = order[j] * 4
      const dx = sphereW[o4] - cx, dy = sphereW[o4 + 1] - cy, dz = sphereW[o4 + 2] - cz
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + sphereW[o4 + 3]
      if (d > rad) rad = d
    }
    groupSpheres[o4g] = cx; groupSpheres[o4g + 1] = cy; groupSpheres[o4g + 2] = cz
    groupSpheres[o4g + 3] = rad
  }
}

/** N4: is the group's sphere fully outside the camera's frustum? */
function groupSphereOut(views, cameraIndex, g) {
  const o = g * 4
  const r = groupSpheres[o + 3]
  if (r <= 0) return false // empty / unknown — never reject
  const pb = cameraIndex * 24
  const { planes } = views
  const cx = groupSpheres[o], cy = groupSpheres[o + 1], cz = groupSpheres[o + 2]
  for (let i = 0; i < 6; i++) {
    const p = pb + i * 4
    if (planes[p] * cx + planes[p + 1] * cy + planes[p + 2] * cz + planes[p + 3] < -r) return true
  }
  return false
}

// ── the collect variants ───────────────────────────────────────────────────
/** vR — N1 alone: the current walk, the matrix source = worldR[rank*16]. */
function vR(views, cameraIndex, bufferIndex, groupId, out) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, group, bits, nodeFlags } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const capacity = out.length >>> 4
  const wEnd = Math.min(views.bitsWords, (n + 31) >>> 5)
  let k = 0
  scan: for (let w = 0; w < wEnd; w++) {
    const word = bits[base + w]
    if (word === 0) continue
    const rEnd = Math.min((w << 5) + 32, n)
    for (let r = w << 5; r < rEnd; r++) {
      if ((word & (1 << (r & 31))) === 0) continue
      const slot = order[r]
      if (group[slot] !== groupId) continue
      if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
      if (k >= capacity) break scan
      const src = r * 16 // ← N1: the rank-major source
      const dst = k * 16
      out[dst] = worldR[src]; out[dst + 1] = worldR[src + 1]; out[dst + 2] = worldR[src + 2]; out[dst + 3] = worldR[src + 3]
      out[dst + 4] = worldR[src + 4]; out[dst + 5] = worldR[src + 5]; out[dst + 6] = worldR[src + 6]; out[dst + 7] = worldR[src + 7]
      out[dst + 8] = worldR[src + 8]; out[dst + 9] = worldR[src + 9]; out[dst + 10] = worldR[src + 10]; out[dst + 11] = worldR[src + 11]
      out[dst + 12] = worldR[src + 12]; out[dst + 13] = worldR[src + 13]; out[dst + 14] = worldR[src + 14]; out[dst + 15] = worldR[src + 15]
      k++
    }
  }
  return k
}

/** vT — N2 alone: the range word-scan (order/nodeFlags kept, slot-major matrices). */
function vT(views, cameraIndex, bufferIndex, groupId, out) {
  if (groupId < 0 || groupId >= groupCountNow) return 0
  const n = views.headerI[H_NODE_COUNT]
  const { order, world, bits, nodeFlags } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const capacity = out.length >>> 4
  const gs = gStart[groupId], ge = gStart[groupId + 1]
  if (gs >= ge) return 0
  let k = 0
  scan: for (let w = gs >>> 5; w <= (ge - 1) >>> 5; w++) {
    const word = bits[base + w]
    if (word === 0) continue
    const rLo = Math.max(w << 5, gs)
    const rHi = Math.min((w << 5) + 32, ge)
    for (let r = rLo; r < rHi; r++) {
      if ((word & (1 << (r & 31))) === 0) continue
      const slot = order[r]
      if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
      if (k >= capacity) break scan
      const src = slot * 16
      const dst = k * 16
      out[dst] = world[src]; out[dst + 1] = world[src + 1]; out[dst + 2] = world[src + 2]; out[dst + 3] = world[src + 3]
      out[dst + 4] = world[src + 4]; out[dst + 5] = world[src + 5]; out[dst + 6] = world[src + 6]; out[dst + 7] = world[src + 7]
      out[dst + 8] = world[src + 8]; out[dst + 9] = world[src + 9]; out[dst + 10] = world[src + 10]; out[dst + 11] = world[src + 11]
      out[dst + 12] = world[src + 12]; out[dst + 13] = world[src + 13]; out[dst + 14] = world[src + 14]; out[dst + 15] = world[src + 15]
      k++
    }
  }
  return k
}

/** vTR — N2+P2+N1: the range scan over the FOLDED bits, worldR source.
 * The caller may fold once per frame (the *s* forms) or pass fold=true. */
function vTR(views, cameraIndex, bufferIndex, groupId, out, fold = true) {
  if (groupId < 0 || groupId >= groupCountNow) return 0
  if (fold) foldEff(views, bitsBase(views, bufferIndex, cameraIndex))
  const capacity = out.length >>> 4
  const gs = gStart[groupId], ge = gStart[groupId + 1]
  if (gs >= ge) return 0
  let k = 0
  scan: for (let w = gs >>> 5; w <= (ge - 1) >>> 5; w++) {
    const word = effScratch[w]
    if (word === 0) continue
    const rLo = Math.max(w << 5, gs)
    const rHi = Math.min((w << 5) + 32, ge)
    for (let r = rLo; r < rHi; r++) {
      if ((word & (1 << (r & 31))) === 0) continue
      if (k >= capacity) break scan
      const src = r * 16
      const dst = k * 16
      out[dst] = worldR[src]; out[dst + 1] = worldR[src + 1]; out[dst + 2] = worldR[src + 2]; out[dst + 3] = worldR[src + 3]
      out[dst + 4] = worldR[src + 4]; out[dst + 5] = worldR[src + 5]; out[dst + 6] = worldR[src + 6]; out[dst + 7] = worldR[src + 7]
      out[dst + 8] = worldR[src + 8]; out[dst + 9] = worldR[src + 9]; out[dst + 10] = worldR[src + 10]; out[dst + 11] = worldR[src + 11]
      out[dst + 12] = worldR[src + 12]; out[dst + 13] = worldR[src + 13]; out[dst + 14] = worldR[src + 14]; out[dst + 15] = worldR[src + 15]
      k++
    }
  }
  return k
}

/** vTRfast — vTR + the all-visible block-copy fast path (one out.set). */
function vTRfast(views, cameraIndex, bufferIndex, groupId, out, fold = true) {
  if (groupId < 0 || groupId >= groupCountNow) return 0
  if (fold) foldEff(views, bitsBase(views, bufferIndex, cameraIndex))
  const capacity = out.length >>> 4
  const gs = gStart[groupId], ge = gStart[groupId + 1]
  if (gs >= ge) return 0
  const ws = gs >>> 5, we = (ge - 1) >>> 5
  const sOff = gs & 31, eOff = ge & 31
  const headMask = sOff === 0 ? -1 : (-1 << sOff)
  const tailMask = eOff === 0 ? -1 : ((1 << eOff) - 1)
  let all = true
  for (let w = ws; w <= we; w++) {
    const m = w === ws ? (ws === we ? headMask & tailMask : headMask) : w === we ? tailMask : -1
    if ((effScratch[w] & m) !== m) { all = false; break }
  }
  if (all) {
    const k = Math.min(ge - gs, capacity)
    out.set(worldR.subarray(gs * 16, (gs + k) * 16)) // ONE block copy
    return k
  }
  return vTR(views, cameraIndex, bufferIndex, groupId, out, false)
}

/** vTRpre — N4 + vTR: the group-sphere pre-reject before the walk. */
function vTRpre(views, cameraIndex, bufferIndex, groupId, out, fold = true) {
  if (groupId < 0 || groupId >= groupCountNow) return 0
  if (groupSphereOut(views, cameraIndex, groupId)) return 0
  return vTR(views, cameraIndex, bufferIndex, groupId, out, fold)
}

// ── N3a: the pool collect with the memo (src verbatim + the early-out) ──────
function poolMemo(views, cameraIndex, bufferIndex) {
  const n = views.headerI[H_NODE_COUNT]
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  const maxInstances = views.headerI[H_MAX_INSTANCES]
  const { order, group, world, instPool, instCounts, instOffsets, bits, groupTouch, groupFlip, headerI, headerU } = views
  const bitsBaseV = bitsBase(views, bufferIndex, cameraIndex)
  const countsBase = (bufferIndex * views.cameraMax + cameraIndex) * views.groupMax
  const offsetsBase = countsBase
  const pool = instancePoolBase(views, bufferIndex, cameraIndex)
  const words = views.bitsWords
  const cursors = t0cursorsFor(groupCount)

  // ── the flip-diff (Task 85) — VERBATIM ──
  const flipBase = cameraIndex * views.groupMax
  if (headerI[H_COLLECT_LAYOUT_EPOCH] !== headerI[H_LAYOUT_EPOCH]) {
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
        if (r >= n) break
        const g = group[order[r]]
        if (g >= 0 && g < groupCount) {
          groupFlip[flipBase + g] = stamp
          touched = true
        }
      }
    }
    if (touched) headerU[H_CLOCK] = stamp
  }

  // ── N3a: no flips (the diff above found nothing AND the clock did not
  // advance — no layout touch-all, no updateWorld/setVisible stamps) ⟹ the
  // pool of THIS (camera, buffer) is still valid ⟹ skip counting+fill.
  const memoIdx = bufferIndex * views.cameraMax + cameraIndex
  if (headerU[H_CLOCK] === poolMemoClock[memoIdx]) {
    poolMemoHits++
    return poolMemoTotal[memoIdx]
  }

  // ── counting / prefix / fill — VERBATIM (word-wise, Task 143) ──
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
      if (r >= n) break
      const slot = order[r]
      const g = group[slot]
      if (g < 0 || g >= groupCount) continue
      if ((nodeFlags[slot] & NF_VISIBLE) !== 0) instCounts[countsBase + g]++
    }
  }
  let total = 0
  for (let g = 0; g < groupCount; g++) {
    instOffsets[offsetsBase + g] = total
    cursors[g] = 0
    total += instCounts[countsBase + g]
  }
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
      if (dst >= maxInstances) { dropped++; continue }
      cursors[g]++
      const src = slot * 16
      const o = pool + dst * 16
      instPool[o] = world[src]; instPool[o + 1] = world[src + 1]; instPool[o + 2] = world[src + 2]; instPool[o + 3] = world[src + 3]
      instPool[o + 4] = world[src + 4]; instPool[o + 5] = world[src + 5]; instPool[o + 6] = world[src + 6]; instPool[o + 7] = world[src + 7]
      instPool[o + 8] = world[src + 8]; instPool[o + 9] = world[src + 9]; instPool[o + 10] = world[src + 10]; instPool[o + 11] = world[src + 11]
      instPool[o + 12] = world[src + 12]; instPool[o + 13] = world[src + 13]; instPool[o + 14] = world[src + 14]; instPool[o + 15] = world[src + 15]
    }
  }
  if (dropped > 0) views.headerI[H_DROPPED_INSTANCES] += dropped
  poolMemoClock[memoIdx] = headerU[H_CLOCK]
  poolMemoTotal[memoIdx] = total - dropped
  poolMemoMisses++
  return total - dropped
}

let poolCursors = new Int32Array(64)
function t0cursorsFor(groupCount) {
  if (poolCursors.length < groupCount) poolCursors = new Int32Array(groupCount * 2)
  return poolCursors
}
let poolMemoHits = 0
let poolMemoMisses = 0

// ── N3b: the T0 memo (per-frame attribution + per-group skip) ──────────────
function t0Reset() {
  poolMemoClock.fill(-1); poolMemoTotal.fill(0)
  poolMemoHits = 0; poolMemoMisses = 0
  snapBits.fill(0); memoClockG.fill(-1); memoKG.fill(0); dirtyG.fill(0)
}
function t0Ensure(views) {
  const words = views.bitsWords
  if (snapBits.length < words) snapBits = new Uint32Array(words * 2)
  const gm = views.groupMax
  if (memoClockG.length < gm) { memoClockG = new Int32Array(gm * 2); memoKG = new Int32Array(gm * 2); dirtyG = new Uint8Array(gm * 2) }
}

/** The per-frame attribution: bit flips (vs the snapshot) + content stamps. */
function t0Attribute(views, cameraIndex, bufferIndex) {
  t0Ensure(views)
  const n = views.headerI[H_NODE_COUNT]
  const groupCount = groupCountNow
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const { order, group, bits, groupTouch, headerU } = views
  dirtyG.fill(0, 0, groupCount)
  for (let w = 0; w < views.bitsWords; w++) {
    const cur = bits[base + w]
    const prev = snapBits[w]
    if (cur === prev) continue
    let flips = cur ^ prev
    const rBase = w << 5
    while (flips !== 0) {
      const lb = flips & -flips
      flips ^= lb
      const r = rBase + 31 - Math.clz32(lb)
      if (r >= n) break
      const g = group[order[r]]
      if (g >= 0 && g < groupCount) dirtyG[g] = 1
    }
  }
  snapBits.set(bits.subarray(base, base + views.bitsWords))
  const now = headerU[H_CLOCK]
  for (let g = 0; g < groupCount; g++) if (groupTouch[g] > memoClockG[g]) dirtyG[g] = 1
}

/** N3b: the memoized per-group collect — a clean group returns the cached
 * count and leaves `out` untouched (CONTRACT: the out buffer is STABLE per
 * group — the pool view / the feed's per-group buffer). */
function t0Collect(views, cameraIndex, bufferIndex, groupId, out) {
  if (groupId < 0 || groupId >= groupCountNow) return 0
  if (!dirtyG[groupId]) { t0Hits++; return memoKG[groupId] }
  t0Misses++
  const k = vTRfast(views, cameraIndex, bufferIndex, groupId, out, false) // shared fold
  memoKG[groupId] = k
  memoClockG[groupId] = views.headerU[H_CLOCK]
  return k
}
let t0Hits = 0
let t0Misses = 0

// ── harness (the task-186/188 canon) ───────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildScene(N, groups, groupOfNode, fov = 1.0, seed = 1) {
  const rng = mulberry32(seed)
  const scene = createScene({ capacity: N, cameraMax: 1, groupMax: groups, maxInstances: N })
  for (let i = 0; i < N; i++) {
    const x = (i % 100) * 6 - 300
    const y = ((i / 100) | 0) % 100 * 6 - 300
    const z = ((i / 10000) | 0) * 8
    scene.create({ position: [x, y, z], sphere: [0, 0, 0, 2], group: groupOfNode(i) })
    if (rng() > 0.9) scene.setVisible(i, false) // ~10% hidden nodes — the NF_VISIBLE band
  }
  scene.updateWorld()
  const cam = createCamera().setPerspective(fov, 1, 0.1, 900)
  cam.setViewLookAt(0, 0, 400, 0, 0, 0, 0, 1, 0)
  writeCameraPlanes(scene.views, 0, cam.planes)
  cullViewsBrute(scene.views, 0, 0)
  let visible = popcountBits(scene.views.bits, 0, scene.views.bitsWords)
  return { scene, visible }
}

/** A twin scene builder: the SAME rng draws → IDENTICAL content (for the
 * memo parity sequences: scene A runs `real` every frame, scene B the memo). */
function buildTwin(builder) {
  const a = builder(mulberry32(4242))
  const b = builder(mulberry32(4242))
  return [a, b]
}

function bench(name, fn, runs = 40) {
  for (let i = 0; i < 5; i++) fn()
  const times = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return { name, med: times[times.length >> 1], min: times[0] }
}

function report(rows) {
  const base = rows[0].med
  for (const r of rows) {
    console.log(`   ${r.name.padEnd(30)} ${r.med.toFixed(3)}ms  min ${r.min.toFixed(3)}ms  ${r === rows[0] ? '—' : ((100 * (r.med - base) / base).toFixed(1) + '%')}`)
  }
}

function arraysEqual(a, b, len) {
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return false
  return true
}

/** The scenario driver: refs from `real` BEFORE the tail repack; the variants
 * run AFTER (repacked + re-culled) and must reproduce the refs bit-exactly. */
function runScenario(title, scene, groupId, out, runs = 40) {
  console.log(`\n== ${title} ==`)
  const views = scene.views
  const n = views.headerI[H_NODE_COUNT]
  groupCountNow = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)

  // ── phase 1: the ORIGINAL layout — refs + real/vR benches ──
  buildRankOf(views); buildWorldR(views); buildRankFlags(views)
  out.fill(7.77)
  const kReal = collectGroupMatrices(views, 0, 0, groupId, out)
  const ref = out.slice()
  let kR
  { out.fill(7.77); kR = vR(views, 0, 0, groupId, out) }
  if (kR !== kReal || !arraysEqual(out, ref, out.length)) { console.log('   ✗ vR MISMATCH'); process.exit(1) }
  const rowsA = [
    bench('real (current)', () => { collectGroupMatrices(views, 0, 0, groupId, out) }, runs),
    bench('vR rank-major (N1)', () => { vR(views, 0, 0, groupId, out) }, runs),
  ]
  report(rowsA)

  // ── phase 2: THE TAIL REPACK — the variants ──
  tailRepack(views)
  cullViewsBrute(views, 0, 0) // bits in the NEW rank space (same visible set)
  buildRankOf(views); buildWorldR(views); buildRankFlags(views); buildGroupSpheres(views)
  // sanity: real itself must reproduce the ref after the repack (the stable
  // counting sort preserves the member order)
  {
    out.fill(7.77)
    const k2 = collectGroupMatrices(views, 0, 0, groupId, out)
    if (k2 !== kReal || !arraysEqual(out, ref, out.length)) { console.log('   ✗ real-after-repack MISMATCH (the tail repack is not order-preserving)'); process.exit(1) }
  }
  for (const [name, fn] of [
    ['vT range (N2)', (v) => vT(v, 0, 0, groupId, out)],
    ['vTR range+fold+worldR', (v) => vTR(v, 0, 0, groupId, out)],
    ['vTRfast (+block copy)', (v) => vTRfast(v, 0, 0, groupId, out)],
    ['vTRpre (+sphere reject)', (v) => vTRpre(v, 0, 0, groupId, out)],
  ]) {
    out.fill(7.77)
    const k = fn(views)
    if (k !== kReal || !arraysEqual(out, ref, out.length)) { console.log(`   ✗ ${name}: MISMATCH (k=${k} vs ${kReal})`); process.exit(1) }
  }
  console.log(`   all variants bit-identical to the pre-repack real (k=${kReal})`)
  const rowsB = [
    bench('vT range (N2)', () => { vT(views, 0, 0, groupId, out) }, runs),
    bench('vTR range+fold+worldR', () => { vTR(views, 0, 0, groupId, out) }, runs),
    bench('vTRfast (+block copy)', () => { vTRfast(views, 0, 0, groupId, out) }, runs),
    bench('vTRpre (+sphere reject)', () => { vTRpre(views, 0, 0, groupId, out) }, runs),
  ]
  report(rowsB)
  return { rowsA, rowsB, kReal }
}

// ── the updateWorld write-pattern fee (the math EXCLUDED — honest label) ──
function writePatternFee(views, rng, dirtyCount, rounds = 30) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, parent } = views
  // a random dirty set of RANKS (ascending — the recompute walk's shape)
  const dirty = new Int32Array(dirtyCount)
  let di = 0
  while (di < dirtyCount) { const r = Math.floor(rng() * n); dirty[di++] = r }
  dirty.sort()
  const { world } = views
  const A = () => { // slot-major: parent read world[p*16], write world[slot*16]
    for (let i = 0; i < dirtyCount; i++) {
      const r = dirty[i]
      const slot = order[r]
      const p = parent[slot]
      const dst = slot * 16
      if (p >= 0) {
        const src = p * 16
        for (let k = 0; k < 16; k++) world[dst + k] = world[src + k]
      } else {
        for (let k = 0; k < 16; k++) world[dst + k] = 1
      }
    }
  }
  const B = () => { // rank-major: parent read worldR[rankOf[p]*16], write worldR[r*16]
    for (let i = 0; i < dirtyCount; i++) {
      const r = dirty[i]
      const slot = order[r]
      const p = parent[slot]
      const dst = r * 16
      if (p >= 0) {
        const src = rankOf[p] * 16
        for (let k = 0; k < 16; k++) worldR[dst + k] = worldR[src + k]
      } else {
        for (let k = 0; k < 16; k++) worldR[dst + k] = 1
      }
    }
  }
  return [bench('recompute A slot-major (fee)', A, rounds), bench('recompute B rank-major (fee)', B, rounds)]
}

// ── main ───────────────────────────────────────────────────────────────────
const N = 100_000

const { scene: sceneSingle, visible: visSingle } = buildScene(N, 4, () => 0)
console.log(`single: nodes=${N} visible=${visSingle} (${(100 * visSingle / N).toFixed(1)}%)`)
runScenario('S1 SINGLE group (100% of nodes)', sceneSingle, 0, new Float32Array(visSingle * 16 + 64))

const { scene: sceneLarge, visible: visLarge } = buildScene(N, 8, (i) => (i % 2 === 0 ? 0 : 1 + (i % 7)))
console.log(`\nlarge: nodes=${N} visible=${visLarge} (${(100 * visLarge / N).toFixed(1)}%)`)
runScenario('S2 LARGE group (≈50% of nodes, 8 groups)', sceneLarge, 0, new Float32Array(60_000 * 16))

const { scene: sceneSmall, visible: visSmall } = buildScene(N, 100, (i) => i % 100)
console.log(`\nsmall: nodes=${N} visible=${visSmall} (${(100 * visSmall / N).toFixed(1)}%)`)
{
  const counts = new Int32Array(100)
  const { order, group, bits, nodeFlags } = sceneSmall.views
  for (let r = 0; r < N; r++) {
    const slot = order[r]
    if ((bits[r >>> 5] & (1 << (r & 31))) === 0) continue
    if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
    counts[group[slot]]++
  }
  let bestG = 0, bestC = -1
  for (let g = 0; g < 100; g++) if (counts[g] > bestC) { bestC = counts[g]; bestG = g }
  console.log(`   small-group pick: group ${bestG} with ${bestC} visible members`)
  runScenario('S3 SMALL group (≈1% of nodes, 100 groups)', sceneSmall, bestG, new Float32Array(4_000 * 16))
}

const { scene: sceneSparse, visible: visSparse } = buildScene(N, 100, (i) => i % 100, 0.28)
console.log(`\nsparse: nodes=${N} visible=${visSparse} (${(100 * visSparse / N).toFixed(1)}%) — the word-scan home turf`)
{
  const counts = new Int32Array(100)
  const { order, group, bits, nodeFlags } = sceneSparse.views
  for (let r = 0; r < N; r++) {
    const slot = order[r]
    if ((bits[r >>> 5] & (1 << (r & 31))) === 0) continue
    if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
    counts[group[slot]]++
  }
  let bestG = 0, bestC = -1
  for (let g = 0; g < 100; g++) if (counts[g] > bestC) { bestC = counts[g]; bestG = g }
  console.log(`   sparse-group pick: group ${bestG} with ${bestC} visible members`)
  runScenario('S4 SPARSE visibility (100 groups)', sceneSparse, bestG, new Float32Array(2000 * 16))
}

// ── S5: the SWEEP (all 100 groups) + the T0 memo loops ─────────────────────
{
  console.log('\n== S5 SWEEP all 100 groups (T0 asymptotics, tail layout) ==')
  const views = sceneSmall.views
  groupCountNow = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  // refs BEFORE the repack (a per-group sweep checksum)
  const out = new Float32Array(4_000 * 16)
  const sweepHash = (fn) => {
    let h = 2166136261
    for (let g = 0; g < 100; g++) {
      out.fill(7.77)
      const k = fn(views, 0, 0, g, out)
      h = Math.imul(h ^ k, 16777619)
      for (let i = 0; i < k * 16; i++) h = Math.imul(h ^ Math.round(out[i] * 1024), 16777619)
    }
    return h >>> 0
  }
  const hRef = sweepHash(collectGroupMatrices)
  const benchSweep = (name, fn) => bench(name, () => { for (let g = 0; g < 100; g++) fn(views, 0, 0, g, out) }, 10)

  // phase 1: vR on the original layout
  buildRankOf(views); buildWorldR(views); buildRankFlags(views)
  const rowsA = [
    benchSweep('real sweep (current)', collectGroupMatrices),
    benchSweep('vR sweep (N1)', vR),
  ]
  // phase 2: the tail repack
  tailRepack(views)
  cullViewsBrute(views, 0, 0)
  buildRankOf(views); buildWorldR(views); buildRankFlags(views); buildGroupSpheres(views)
  const hT = sweepHash((v, c, b, g, o) => vTR(v, c, b, g, o))
  const hF = sweepHash((v, c, b, g, o) => vTRfast(v, c, b, g, o))
  const hP = sweepHash((v, c, b, g, o) => vTRpre(v, c, b, g, o))
  if (hRef !== hT || hRef !== hF || hRef !== hP) { console.log(`   ✗ sweep parity MISMATCH (${hRef} vs ${hT}/${hF}/${hP})`); process.exit(1) }
  console.log('   sweep parity OK (per-group k + prefix checksums match the pre-repack real)')
  const rowsB = [
    benchSweep('vTR sweep (fold/call)', (v, c, b, g, o) => vTR(v, c, b, g, o)),
    benchSweep('vTRfast sweep (fold/call)', (v, c, b, g, o) => vTRfast(v, c, b, g, o)),
    benchSweep('vTRpre sweep (fold/call)', (v, c, b, g, o) => vTRpre(v, c, b, g, o)),
    bench('vTRfast sweep (SHARED fold)', () => { foldEff(views, bitsBase(views, 0, 0)); for (let g = 0; g < 100; g++) vTRfast(views, 0, 0, g, out, false) }, 10),
    bench('vTRpre sweep (SHARED fold)', () => { foldEff(views, bitsBase(views, 0, 0)); for (let g = 0; g < 100; g++) vTRpre(views, 0, 0, g, out, false) }, 10),
  ]
  console.log('   — original layout —'); report(rowsA)
  console.log('   — tail layout —'); report(rowsB)

  // ── S5b/S5c: the T0 MEMO loops on TWIN scenes ──
  const twinBuilder = (rng) => {
    const scene = createScene({ capacity: N, cameraMax: 1, groupMax: 100, maxInstances: N })
    for (let i = 0; i < N; i++) {
      const x = (i % 100) * 6 - 300
      const y = ((i / 100) | 0) % 100 * 6 - 300
      const z = ((i / 10000) | 0) * 8
      scene.create({ position: [x, y, z], sphere: [0, 0, 0, 2], group: i % 100 })
      if (rng() > 0.9) scene.setVisible(i, false)
    }
    scene.updateWorld()
    const cam = createCamera().setPerspective(1.0, 1, 0.1, 900)
    cam.setViewLookAt(0, 0, 400, 0, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    return scene
  }
  const [sceneA, sceneB] = buildTwin(twinBuilder)
  const viewsA = sceneA.views, viewsB = sceneB.views
  for (const v of [viewsA, viewsB]) {
    tailRepack(v); cullViewsBrute(v, 0, 0)
    buildRankOf(v); buildWorldR(v); buildRankFlags(v); buildGroupSpheres(v)
  }
  const outsA = []; const outsB = []
  for (let g = 0; g < 100; g++) { outsA.push(new Float32Array(4_000 * 16)); outsB.push(new Float32Array(4_000 * 16)) }
  t0Reset(); t0Ensure(viewsB)
  const rngM = mulberry32(777)

  // S5b — STATIC camera: 40 frames; the memo must skip almost everything
  console.log('\n== S5b T0 sweep × 40 frames, STATIC camera (the memo home turf) ==')
  {
    let checks = 0
    for (let f = 0; f < 40; f++) {
      for (const [v, outs] of [[viewsA, outsA], [viewsB, outsB]]) { cullViewsBrute(v, 0, 0) }
      // B: the memo frame
      t0Attribute(viewsB, 0, 0)
      foldEff(viewsB, bitsBase(viewsB, 0, 0))
      for (let g = 0; g < 100; g++) t0Collect(viewsB, 0, 0, g, outsB[g])
      // A: the real reference sweep
      for (let g = 0; g < 100; g++) { outsA[g].fill(7.77); const k = collectGroupMatrices(viewsA, 0, 0, g, outsA[g]); if (k !== memoKG[g] || !arraysEqual(outsA[g], outsB[g], k * 16)) { console.log(`   ✗ frame ${f} group ${g}: memo drift`); process.exit(1) }; checks += k }
    }
    console.log(`   parity OK over 40 frames (${checks} matrices); memo hits=${t0Hits} misses=${t0Misses}`)
    const frameReal = () => { cullViewsBrute(viewsA, 0, 0); for (let g = 0; g < 100; g++) collectGroupMatrices(viewsA, 0, 0, g, outsA[g]) }
    const frameMemo = () => { cullViewsBrute(viewsB, 0, 0); t0Attribute(viewsB, 0, 0); foldEff(viewsB, bitsBase(viewsB, 0, 0)); for (let g = 0; g < 100; g++) t0Collect(viewsB, 0, 0, g, outsB[g]) }
    report([
      bench('frame: cull + real sweep', frameReal, 20),
      bench('frame: cull + MEMO sweep', frameMemo, 20),
      bench('frame: MEMO sweep only', () => { t0Attribute(viewsB, 0, 0); foldEff(viewsB, bitsBase(viewsB, 0, 0)); for (let g = 0; g < 100; g++) t0Collect(viewsB, 0, 0, g, outsB[g]) }, 20),
    ])
  }

  // S5c — ONE group flipping (the "drone" frame): 40 frames
  console.log('\n== S5c T0 sweep × 40 frames, ONE group flipping (drone regime) ==')
  {
    t0Reset()
    // the group-7 members on BOTH scenes (identical twins)
    const members = []
    for (let r = tailStartNow; r < N; r++) { const s = viewsA.order[r]; if (viewsA.group[s] === 7) members.push(s) }
    let checks = 0
    for (let f = 0; f < 40; f++) {
      const vis = (f & 1) === 0
      for (const s of members) { sceneA.setVisible(s, vis); sceneB.setVisible(s, vis) }
      sceneA.updateWorld(); sceneB.updateWorld()
      cullViewsBrute(viewsA, 0, 0); cullViewsBrute(viewsB, 0, 0)
      buildRankFlags(viewsB) // the mirror must track the setVisible flips
      t0Attribute(viewsB, 0, 0)
      foldEff(viewsB, bitsBase(viewsB, 0, 0))
      for (let g = 0; g < 100; g++) t0Collect(viewsB, 0, 0, g, outsB[g])
      for (let g = 0; g < 100; g++) { outsA[g].fill(7.77); const k = collectGroupMatrices(viewsA, 0, 0, g, outsA[g]); if (k !== memoKG[g] || !arraysEqual(outsA[g], outsB[g], k * 16)) { console.log(`   ✗ frame ${f} group ${g}: memo drift`); process.exit(1) }; checks += k }
    }
    console.log(`   parity OK over 40 frames (${checks} matrices); memo hits=${t0Hits} misses=${t0Misses} (1 dirty group/frame expected)`)
    const membersArr = Int32Array.from(members)
    const frameReal = () => { for (const s of membersArr) sceneA.setVisible(s, true); sceneA.updateWorld(); cullViewsBrute(viewsA, 0, 0); for (let g = 0; g < 100; g++) collectGroupMatrices(viewsA, 0, 0, g, outsA[g]) }
    const frameMemo = () => { for (const s of membersArr) sceneB.setVisible(s, true); sceneB.updateWorld(); cullViewsBrute(viewsB, 0, 0); buildRankFlags(viewsB); t0Attribute(viewsB, 0, 0); foldEff(viewsB, bitsBase(viewsB, 0, 0)); for (let g = 0; g < 100; g++) t0Collect(viewsB, 0, 0, g, outsB[g]) }
    report([
      bench('frame: real sweep', frameReal, 20),
      bench('frame: MEMO sweep', frameMemo, 20),
    ])
  }
}

// ── S6: the OUT-SWEEP (≈50% of the groups fully outside the frustum) ───────
{
  console.log('\n== S6 OUT-SWEEP: groups spatially split, the camera sees one half ==')
  const groups = 100
  const groupOfNode = (i) => (i % 100 < 50 ? i % 50 : 50 + (i % 50))
  const { scene, visible } = buildScene(N, groups, groupOfNode, 0.5)
  const cam = createCamera().setPerspective(0.42, 1, 0.1, 900)
  cam.setViewLookAt(-350, 0, 320, -350, 0, 0, 0, 1, 0)
  writeCameraPlanes(scene.views, 0, cam.planes)
  cullViewsBrute(scene.views, 0, 0)
  const views = scene.views
  groupCountNow = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  // how many groups are FULLY out (every member bit clear)?
  const outCount = new Int32Array(groups)
  const { order, group, bits, nodeFlags } = views
  for (let r = 0; r < N; r++) {
    const slot = order[r]
    if ((bits[r >>> 5] & (1 << (r & 31))) === 0) continue
    if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
    outCount[group[slot]]++
  }
  const fullyOut = groups - outCount.filter(c => c > 0).length
  console.log(`   visible=${(100 * visible / N).toFixed(1)}%; fully-out groups: ${fullyOut}/${groups}`)
  const out = new Float32Array(4_000 * 16)
  const sweepHash = (fn) => {
    let h = 2166136261
    for (let g = 0; g < groups; g++) {
      out.fill(7.77)
      const k = fn(views, 0, 0, g, out)
      h = Math.imul(h ^ k, 16777619)
      for (let i = 0; i < k * 16; i++) h = Math.imul(h ^ Math.round(out[i] * 1024), 16777619)
    }
    return h >>> 0
  }
  const hRef = sweepHash(collectGroupMatrices)
  buildRankOf(views); buildWorldR(views); buildRankFlags(views)
  const rowsA = [bench('real sweep (current)', () => { for (let g = 0; g < groups; g++) collectGroupMatrices(views, 0, 0, g, out) }, 10)]
  tailRepack(views)
  cullViewsBrute(views, 0, 0)
  buildRankOf(views); buildWorldR(views); buildRankFlags(views); buildGroupSpheres(views)
  const hT = sweepHash((v, c, b, g, o) => vTR(v, c, b, g, o))
  const hP = sweepHash((v, c, b, g, o) => vTRpre(v, c, b, g, o))
  const hF = sweepHash((v, c, b, g, o) => vTRfast(v, c, b, g, o))
  if (hRef !== hT || hRef !== hP || hRef !== hF) { console.log(`   ✗ out-sweep parity MISMATCH (${hRef} vs ${hT}/${hP}/${hF})`); process.exit(1) }
  console.log('   parity OK — the pre-reject never skips a group with members (soundness proven)')
  const rowsB = [
    bench('vTR sweep (fold/call)', () => { for (let g = 0; g < groups; g++) vTR(views, 0, 0, g, out) }, 10),
    bench('vTRpre sweep (fold/call)', () => { for (let g = 0; g < groups; g++) vTRpre(views, 0, 0, g, out) }, 10),
    bench('vTRpre sweep (SHARED fold)', () => { foldEff(views, bitsBase(views, 0, 0)); for (let g = 0; g < groups; g++) vTRpre(views, 0, 0, g, out, false) }, 10),
  ]
  console.log('   — original layout —'); report(rowsA)
  console.log('   — tail layout —'); report(rowsB)
}

// ── S7: the POOL pass + N3a/N5 (static and flipping frames) ───────────────
{
  console.log('\n== S7 POOL pass: collectInstancesViews + the memo (N3a) + the cull memo (N5) ==')
  const twinBuilder = (rng) => {
    const scene = createScene({ capacity: N, cameraMax: 1, groupMax: 100, maxInstances: N })
    for (let i = 0; i < N; i++) {
      const x = (i % 100) * 6 - 300
      const y = ((i / 100) | 0) % 100 * 6 - 300
      const z = ((i / 10000) | 0) * 8
      scene.create({ position: [x, y, z], sphere: [0, 0, 0, 2], group: i % 100 })
      if (rng() > 0.9) scene.setVisible(i, false)
    }
    scene.updateWorld()
    const cam = createCamera().setPerspective(1.0, 1, 0.1, 900)
    cam.setViewLookAt(0, 0, 400, 0, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    return scene
  }
  const [sceneA, sceneB] = buildTwin(twinBuilder)
  const viewsA = sceneA.views, viewsB = sceneB.views

  // parity first: a 30-frame STATIC sequence + a 30-frame FLIPPING sequence —
  // every frame, real (A) and memo (B) must agree on ret/counts/offsets/pool.
  const frames = []
  const rngM = mulberry32(999)
  for (let f = 0; f < 30; f++) frames.push({ mutate: false })
  for (let f = 0; f < 30; f++) frames.push({ mutate: true })
  const flipMembers = []
  { // group 7 members (same on both twins)
    const { order, group } = viewsA
    for (let r = 0; r < N; r++) { const s = order[r]; if (group[s] === 7) flipMembers.push(s) }
  }
  const flipArr = Int32Array.from(flipMembers)
  t0Reset()
  let poolParity = 0
  for (let f = 0; f < frames.length; f++) {
    const b = f & 1
    if (frames[f].mutate) {
      const vis = (f & 2) === 0
      for (const s of flipArr) { sceneA.setVisible(s, vis); sceneB.setVisible(s, vis) }
      sceneA.updateWorld(); sceneB.updateWorld()
    }
    cullViewsBrute(viewsA, 0, b); cullViewsBrute(viewsB, 0, b)
    const retA = collectInstancesViews(viewsA, 0, b)
    const retB = poolMemo(viewsB, 0, b)
    if (retA !== retB) { console.log(`   ✗ pool memo parity frame ${f}: ret ${retB} vs ${retA}`); process.exit(1) }
    const baseA = (b * 1 + 0) * 100, baseB = baseA
    for (let g = 0; g < 100; g++) {
      if (viewsA.instCounts[baseA + g] !== viewsB.instCounts[baseB + g] || viewsA.instOffsets[baseA + g] !== viewsB.instOffsets[baseB + g]) {
        console.log(`   ✗ pool memo parity frame ${f} group ${g}: counts/offsets`); process.exit(1)
      }
    }
    const pA = instancePoolBase(viewsA, b, 0), pB = instancePoolBase(viewsB, b, 0)
    for (let i = 0; i < retA * 16; i++) if (viewsA.instPool[pA + i] !== viewsB.instPool[pB + i]) { console.log(`   ✗ pool memo parity frame ${f}: pool bytes at ${i}`); process.exit(1) }
    poolParity++
  }
  console.log(`   pool memo parity OK over ${poolParity} frames (30 static + 30 flipping); hits=${poolMemoHits} misses=${poolMemoMisses}`)

  // the static-frame benchmarks: cull+collect pipelines
  t0Reset()
  const planesSnap = new Float32Array(24)
  let cullClock = -1
  const cullUnchanged = (v) => v.headerU[H_CLOCK] === cullClock && arraysEqual(planesSnap, v.planes, 24)
  const markCull = (v) => { planesSnap.set(v.planes); cullClock = v.headerU[H_CLOCK] }
  const frameRealStatic = () => {
    for (let f = 0; f < 10; f++) { const b = f & 1; cullViewsBrute(viewsA, 0, b); collectInstancesViews(viewsA, 0, b) }
  }
  const frameMemoStatic = () => {
    for (let f = 0; f < 10; f++) { const b = f & 1; cullViewsBrute(viewsB, 0, b); poolMemo(viewsB, 0, b) }
  }
  const frameFullMemoStatic = () => { // N5 + N3a: skip cull AND collect when nothing changed
    for (let f = 0; f < 10; f++) { const b = f & 1; if (!cullUnchanged(viewsB)) { cullViewsBrute(viewsB, 0, b); markCull(viewsB) }; poolMemo(viewsB, 0, b) }
  }
  report([
    bench('10 static frames: real', frameRealStatic, 8),
    bench('10 static frames: +pool memo', frameMemoStatic, 8),
    bench('10 static frames: +cull memo', frameFullMemoStatic, 8),
  ])

  // the flipping-frame benchmark (the memo's miss cost)
  t0Reset()
  const frameRealFlip = () => {
    for (let f = 0; f < 10; f++) { const b = f & 1; const vis = (f & 2) === 0; for (const s of flipArr) sceneA.setVisible(s, vis); sceneA.updateWorld(); cullViewsBrute(viewsA, 0, b); collectInstancesViews(viewsA, 0, b) }
  }
  const frameMemoFlip = () => {
    for (let f = 0; f < 10; f++) { const b = f & 1; const vis = (f & 2) === 0; for (const s of flipArr) sceneB.setVisible(s, vis); sceneB.updateWorld(); cullViewsBrute(viewsB, 0, b); poolMemo(viewsB, 0, b) }
  }
  report([
    bench('10 flipping frames: real', frameRealFlip, 8),
    bench('10 flipping frames: +pool memo', frameMemoFlip, 8),
  ])
}

// ── S8: the FEES (the amortized contract costs) ────────────────────────────
{
  console.log('\n== S8 FEES (per repack / per frame / per recompute) ==')
  const views = sceneSmall.views
  const rng = mulberry32(31337)
  const feeRows = [
    // idempotent on the already-tail input — the two O(n) passes + the prefix
    // are layout-independent; the fee number is representative either way
    bench('tailRepack (per repack)', () => { tailRepack(views) }, 10),
    bench('buildWorldR (per repack)', () => { buildWorldR(views) }, 10),
    bench('buildRankFlags (per repack)', () => { buildRankFlags(views) }, 10),
    bench('foldEff (per frame)', () => { foldEff(views, bitsBase(views, 0, 0)) }, 40),
    bench('buildGroupSpheres (per refit)', () => { buildGroupSpheres(views) }, 10),
  ]
  for (const r of feeRows) console.log(`   ${r.name.padEnd(30)} ${r.med.toFixed(3)}ms  min ${r.min.toFixed(3)}ms`)
  // the cull delta + the write-pattern fee: a real TREE fixture (parents!)
  console.log('\n   — the cull fee on a TREE fixture (16k nodes, binary tree, grouped leaves) —')
  {
    const TN = 16_384
    const tree = createScene({ capacity: TN, cameraMax: 1, groupMax: 64, maxInstances: TN })
    // a TELESCOPING tree: local = grid(i) − grid(parent) ⟹ world(i) = grid(i)
    // — a real spatial hierarchy over the same 64×256 grid (the flat fixtures'
    // band); positions as LOCALS would accumulate down the chain and turn the
    // refit spheres into degenerate mega-spheres (r ≈ 5·10^5 — found by probe)
    const gp = (i) => [(i % 64) * 6 - 190, ((i / 64) | 0) * 6 - 190, ((i / 4096) | 0) * 8]
    for (let i = 0; i < TN; i++) {
      const parent = i === 0 ? -1 : (i - 1) >> 1
      const leaf = i * 2 + 1 >= TN
      const [px, py, pz] = parent < 0 ? [0, 0, 0] : gp(parent)
      const [cx, cy, cz] = gp(i)
      // internal nodes get r = -1 (an AUTO bound — refit combines children into
      // it); a user sphere on an internal node means "I know better" and the
      // cull trusts it — the documented contract
      tree.create({ parent, position: [cx - px, cy - py, cz - pz], sphere: leaf ? [0, 0, 0, 2] : [0, 0, 0, -1], group: leaf ? i % 64 : -1 })
    }
    tree.updateWorld()
    tree.refitGroupBounds() // REQUIRED: internal spheres must ENCLOSURE the
    // children for trivial accept/reject (the documented cull precondition)
    const cam = createCamera().setPerspective(0.9, 1, 0.1, 900)
    cam.setViewLookAt(0, 0, 400, 0, 0, 0, 0, 1, 0)
    writeCameraPlanes(tree.views, 0, cam.planes)
    const tv = tree.views
    groupCountNow = Math.min(tv.headerI[H_GROUP_COUNT], tv.groupMax)
    cullViewsHierarchical(tv, 0, 0)
    const pop1 = popcountBits(tv.bits, bitsBase(tv, 0, 0), tv.bitsWords)
    const plainCull = bench('cull hierarchical (plain)', () => { cullViewsHierarchical(tv, 0, 0) }, 20)
    // the recompute write-pattern fee (parents exist HERE): the math excluded,
    // only the dest/source memory pattern — slot-major vs rank-major
    buildRankOf(tv); buildWorldR(tv) // kernel B needs rankOf + worldR of THIS scene
    const [a, b] = writePatternFee(tv, rng, 2_000)
    buildRankFlags(tv)
    const treeN = tailRepack(tv)
    const tailCull = bench('cull hier(tree) + brute(tail)', () => { cullViewsHierarchical(tv, 0, 0); cullTailBrute(tv, 0, 0, treeN, tv.headerI[H_NODE_COUNT]) }, 20)
    // parity: the popcount of the visible set survives the layout change
    // (the sweep/collect parities above are the stronger gates)
    const pop2 = popcountBits(tv.bits, bitsBase(tv, 0, 0), tv.bitsWords)
    if (pop1 !== pop2) { console.log(`   ✗ tree cull parity: popcount ${pop1} vs ${pop2}`); process.exit(1) }
    console.log(`   popcount parity OK (${pop1}/${TN} visible, identical after the tail repack)`)
    report([plainCull, tailCull])
    report([a, b])
  }
}

// ── the PROPERTY PARITY (randomized scenes, twin sequences) ─────────────────
function propertyParity() {
  console.log('\n== PROPERTY PARITY (randomized scenes) ==')
  let cases = 0
  let memoFrames = 0
  for (let seed = 1; seed <= 12; seed++) {
    const rngA = mulberry32(seed * 7919)
    const rngB = mulberry32(seed * 7919)
    const build = (rng) => {
      const N = 1 + Math.floor(rng() * 4000)
      const groupMax = 8
      const scene = createScene({ capacity: N, cameraMax: 1, groupMax, maxInstances: N })
      for (let i = 0; i < N; i++) {
        const x = rng() * 600 - 300
        const y = rng() * 600 - 300
        const z = rng() * 200
        const parent = i > 0 && rng() < 0.55 ? Math.floor(rng() * i) : -1
        const pick = rng()
        const g = pick < 0.2 ? -1 : Math.floor(rng() * groupMax)
        scene.create({ parent, position: [x, y, z], sphere: [rng() * 2, rng() * 2, rng() * 2, 1 + rng() * 3], group: g })
        scene.setVisible(i, rng() > 0.3)
      }
      scene.updateWorld()
      const cam = createCamera().setPerspective(0.4 + rng() * 1.4, 1, 0.1, 900)
      cam.setViewLookAt(rng() * 200 - 100, rng() * 200 - 100, 200 + rng() * 400, 0, 0, 0, 0, 1, 0)
      writeCameraPlanes(scene.views, 0, cam.planes)
      cullViewsBrute(scene.views, 0, 0)
      return { scene, cam }
    }
    const sceneB = build(rngB).scene // the variants scene (refs taken from it pre-repack)
    const views = sceneB.views
    const n = views.headerI[H_NODE_COUNT]
    const groupMax = views.groupMax
    // stale tail bits beyond n (poison): every variant must ignore them
    const rngP = mulberry32(seed * 104729)
    for (let w = (n + 31) >>> 5; w < views.bitsWords; w++) views.bits[w] = (rngP() * 4294967296) >>> 0
    if (n > 0 && (n & 31) !== 0) views.bits[(n - 1) >>> 5] |= ((rngP() * 4294967296) >>> 0) & (-1 << (n & 31))

    groupCountNow = Math.min(views.headerI[H_GROUP_COUNT], groupMax)
    const outLen = 1 + Math.floor(rngP() * (n + 10))
    const outs = new Float32Array(outLen * 16)
    const queryGs = [0, 1, groupMax - 2, groupMax - 1, groupMax]
    const refs = new Map()
    for (const g of queryGs) {
      outs.fill(7.77)
      const k = collectGroupMatrices(views, 0, 0, g, outs)
      refs.set(g, { k, ref: outs.slice() })
    }
    // the tail repack + recull + the derived rebuild
    tailRepack(views)
    cullViewsBrute(views, 0, 0)
    buildRankOf(views); buildWorldR(views); buildRankFlags(views); buildGroupSpheres(views)
    for (const g of queryGs) {
      const { k, ref } = refs.get(g)
      for (const [name, fn] of [
        ['real-after-repack', (v) => collectGroupMatrices(v, 0, 0, g, outs)],
        ['vT', (v) => vT(v, 0, 0, g, outs)],
        ['vTR', (v) => vTR(v, 0, 0, g, outs)],
        ['vTRfast', (v) => vTRfast(v, 0, 0, g, outs)],
        ['vTRpre', (v) => vTRpre(v, 0, 0, g, outs)],
      ]) {
        outs.fill(7.77)
        const k2 = fn(views)
        if (k2 !== k || !arraysEqual(outs, ref, outs.length)) { console.log(`   ✗ seed ${seed} g ${g} ${name}: k=${k2} vs ${k}`); process.exit(1) }
      }
      cases++
    }

    // ── the randomized MEMO sequences: TWIN scenes, one shared event stream ──
    const rngTwin = seed * 7919 + 1 // a FRESH stream (rngA/rngB are consumed above)
    const sceneA2 = build(mulberry32(rngTwin)).scene // the reference twin (real every frame)
    const sceneB2 = build(mulberry32(rngTwin)).scene // the memo twin — IDENTICAL content
    const viewsA2 = sceneA2.views, viewsB2 = sceneB2.views
    const n2 = viewsA2.headerI[H_NODE_COUNT]
    const gCount2 = Math.min(viewsA2.headerI[H_GROUP_COUNT], viewsA2.groupMax)
    const rngE = mulberry32(seed * 31337)
    const FRAMES = 16
    const events = []
    for (let f = 0; f < FRAMES; f++) {
      const r = rngE()
      events.push(r < 0.4 ? 'none' : r < 0.7 ? 'burst' : 'wiggle')
    }
    const slotsOfGroup = new Map()
    for (let s = 0; s < n2; s++) {
      const g = viewsA2.group[s]
      if (g >= 0 && g < gCount2) { if (!slotsOfGroup.has(g)) slotsOfGroup.set(g, []); slotsOfGroup.get(g).push(s) }
    }
    // (i) the POOL memo sequence (original layout, double-buffered)
    t0Reset()
    for (let f = 0; f < FRAMES; f++) {
      const b = f & 1
      const ev = events[f]
      if (ev === 'burst' || ev === 'wiggle') {
        const gs = [...slotsOfGroup.keys()]
        const g = gs[Math.floor(rngE() * gs.length)]
        const members = slotsOfGroup.get(g) ?? []
        const vis = rngE() > 0.5
        const count = Math.min(members.length, 5)
        for (let j = 0; j < count; j++) { const s = members[Math.floor(rngE() * members.length)]; sceneA2.setVisible(s, vis); sceneB2.setVisible(s, vis) }
        sceneA2.updateWorld(); sceneB2.updateWorld()
      }
      if (ev === 'wiggle') {
        const cam = createCamera().setPerspective(0.9, 1, 0.1, 900)
        const ex = 80 * Math.sin(f)
        cam.setViewLookAt(ex, 0, 400, 0, 0, 0, 0, 1, 0)
        writeCameraPlanes(viewsA2, 0, cam.planes); writeCameraPlanes(viewsB2, 0, cam.planes)
      }
      cullViewsBrute(viewsA2, 0, b); cullViewsBrute(viewsB2, 0, b)
      const retA = collectInstancesViews(viewsA2, 0, b)
      const retB = poolMemo(viewsB2, 0, b)
      if (retA !== retB) { console.log(`   ✗ seed ${seed} frame ${f} POOL memo: ret ${retB} vs ${retA}`); process.exit(1) }
      for (let g = 0; g < gCount2; g++) {
        const ia = b * viewsA2.groupMax + g, ib = b * viewsB2.groupMax + g
        if (viewsA2.instCounts[ia] !== viewsB2.instCounts[ib] || viewsA2.instOffsets[ia] !== viewsB2.instOffsets[ib]) {
          console.log(`   ✗ seed ${seed} frame ${f} group ${g} POOL memo: counts/offsets`); process.exit(1)
        }
      }
      const pA = instancePoolBase(viewsA2, b, 0), pB = instancePoolBase(viewsB2, b, 0)
      for (let i = 0; i < retA * 16; i++) if (viewsA2.instPool[pA + i] !== viewsB2.instPool[pB + i]) { console.log(`   ✗ seed ${seed} frame ${f} POOL memo: bytes at ${i}`); process.exit(1) }
      memoFrames++
    }
    // (ii) the T0 memo sequence (tail layout, one buffer)
    t0Reset()
    for (const v of [viewsA2, viewsB2]) { tailRepack(v); cullViewsBrute(v, 0, 0) }
    buildRankOf(viewsB2); buildWorldR(viewsB2); buildRankFlags(viewsB2); buildGroupSpheres(viewsB2)
    t0Ensure(viewsB2)
    const savedGroupCountNow = groupCountNow
    groupCountNow = Math.min(viewsB2.headerI[H_GROUP_COUNT], viewsB2.groupMax)
    const gCountB = groupCountNow
    const outsA2 = [], outsB2 = []
    for (let g = 0; g < gCountB; g++) { outsA2.push(new Float32Array((n2 + 1) * 16)); outsB2.push(new Float32Array((n2 + 1) * 16)) }
    for (let f = 0; f < FRAMES; f++) {
      const ev = events[f]
      let flagsChanged = false
      if (ev === 'burst' || ev === 'wiggle') {
        const gs = [...slotsOfGroup.keys()]
        const g = gs[Math.floor(rngE() * gs.length)]
        const members = slotsOfGroup.get(g) ?? []
        const vis = rngE() > 0.5
        const count = Math.min(members.length, 5)
        for (let j = 0; j < count; j++) { const s = members[Math.floor(rngE() * members.length)]; sceneA2.setVisible(s, vis); sceneB2.setVisible(s, vis) }
        sceneA2.updateWorld(); sceneB2.updateWorld()
        flagsChanged = true
      }
      if (ev === 'wiggle') {
        const cam = createCamera().setPerspective(0.9, 1, 0.1, 900)
        const ex = 80 * Math.sin(f + 1)
        cam.setViewLookAt(ex, 0, 400, 0, 0, 0, 0, 1, 0)
        writeCameraPlanes(viewsA2, 0, cam.planes); writeCameraPlanes(viewsB2, 0, cam.planes)
      }
      cullViewsBrute(viewsA2, 0, 0); cullViewsBrute(viewsB2, 0, 0)
      if (flagsChanged) buildRankFlags(viewsB2)
      t0Attribute(viewsB2, 0, 0)
      foldEff(viewsB2, bitsBase(viewsB2, 0, 0))
      for (let g = 0; g < gCountB; g++) t0Collect(viewsB2, 0, 0, g, outsB2[g])
      for (let g = 0; g < gCountB; g++) {
        outsA2[g].fill(7.77)
        const k = collectGroupMatrices(viewsA2, 0, 0, g, outsA2[g])
        if (k !== memoKG[g] || !arraysEqual(outsA2[g], outsB2[g], k * 16)) { console.log(`   ✗ seed ${seed} frame ${f} group ${g} T0 memo: drift`); process.exit(1) }
      }
      memoFrames++
    }
    groupCountNow = savedGroupCountNow
  }
  console.log(`   ✓ ${cases} tail-layout parity cases + ${memoFrames} randomized memo frames PASS (forests, truncated outs, stale bits, empty ids, none/burst/wiggle events)`)
}

propertyParity()
console.log('\nTASK 189 THEORIES PROBE: ALL PARITY CHECKS PASS')
