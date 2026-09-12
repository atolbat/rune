/**
 * task188-collect.mjs — Task 188: ISOLATED probes for the ARCHITECTURE/CONTRACT
 * proposals on the instance-collect paths (the "if we may change contracts"
 * dossier). NOTHING here touches packages/ — every variant is a standalone
 * function; `real` is the CURRENT implementation imported from src.
 *
 * PROPOSAL P1 — GROUP INDEX AT PACK ("groupEntries"):
 *   pack() additionally emits, for every group g, a CONTIGUOUS segment of
 *   interleaved (rank, slot) pairs (a counting sort over the packed ranks).
 *   Contract change: setGroup(slot, g) marks layoutDirty (a repack on the next
 *   ensurePacked — group membership becomes a PACK-TIME derived index).
 *   Payoff: collectGroupMatrices(g) walks ONLY the group's segment —
 *   O(|g|) instead of O(n/32 words + all visible ranks), and the random
 *   group[slot] load (a cache miss per visible node of ANY group) dies.
 *   Contract narrowing (documented): groupId < 0 or > groupMax returns 0 —
 *   today groupId = -1 accidentally collects NON-instanced nodes (a
 *   side effect of the `group[slot] !== groupId` filter, never a documented
 *   feature); the proposal makes the query domain the dense ids only.
 *
 * PROPOSAL P2 — EFFECTIVE-BITS FOLD ("rankFlags" + "bitsEff"):
 *   pack() emits rankOf (slot→rank); setVisible maintains rankFlags — a
 *   RANK-SPACE NF_VISIBLE bitset (one bit write, rank known via rankOf).
 *   At collect time ONE word-wise AND folds it: bitsEff[w] = bits[w] &
 *   rankFlags[w] (O(bitsWords), ~n/32 ops — µs at 100k). Every collect loop
 *   then drops the per-rank random nodeFlags[slot] load entirely. The raw
 *   bits are untouched — isVisibleRank's "ignoring node flags" contract
 *   survives; the fold also kills stale tail bits beyond n for free.
 *
 * Variants (each must be BIT-IDENTICAL to `real`):
 *   real — the current src implementation (the reference);
 *   vA   — P2 alone: fold in-call, the current word-blocked walk, no nodeFlags;
 *   vB   — P1 alone: groupEntries walk (interleaved pairs), nodeFlags kept;
 *   vB2  — P1 alone, SPLIT arrays (gRank/gSlot) — the production-shape A/B;
 *   vC   — P1+P2: fold + entries walk (interleaved);
 *   vC2  — P1+P2, split arrays.
 *   The pool pass (collectInstancesViews) — real vs vP (fold + entries, the
 *   flip-diff block copied verbatim: equal overhead on both sides).
 *
 * Scenarios: 100k nodes, the task-186 canonical camera (~45% visibility):
 *   single (1 group = everything), large (group 0 = 50% of nodes, 8 groups),
 *   small (100 groups ≈ 1%), many (1000 groups ≈ 0.1%),
 *   sparse (~10% visibility — the regime where today's word-scan is
 *   CHEAPEST; the entries walk must not lose there), sweep (all 100 groups
 *   back to back — with and without a SHARED fold), the pool pass, and the
 *   pack-time cost of building the group index (the amortized contract fee).
 */
import { createScene, createCamera, cullViewsBrute, writeCameraPlanes, collectGroupMatrices, collectInstancesViews, instancePoolBase } from '../packages/scene/src/index.ts'
import { bitsBase } from '../packages/scene/src/culling.ts'
import { H_NODE_COUNT, H_GROUP_COUNT, H_MAX_INSTANCES, H_DROPPED_INSTANCES, H_CLOCK, H_COLLECT_LAYOUT_EPOCH, H_LAYOUT_EPOCH, NF_VISIBLE } from '../packages/scene/src/layout.ts'

// ── the PROPOSED derived structures (the P1/P2 contract) ───────────────────
// Module-level scratch, grown geometrically — the zero-alloc discipline.
let gStart = new Int32Array(66)     // groupMax+2: segment starts (end = gStart[g+1])
let gCursor = new Int32Array(66)    // build scratch (disjoint from gStart!)
let gPairs = new Uint32Array(1024)  // interleaved (rank, slot) pairs
let gRank = new Int32Array(512)     // split form
let gSlot = new Int32Array(512)
let rankFlags = new Uint32Array(32)  // P2: rank-space NF_VISIBLE mirror
let effScratch = new Uint32Array(32) // the folded bits

/** P1: the counting sort over the PACKED ranks — the added pack() work. */
function buildGroupIndex(views) {
  const n = views.headerI[H_NODE_COUNT]
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  const groupMax = views.groupMax
  const size = groupMax + 2
  if (gStart.length < size) { gStart = new Int32Array(size * 2); gCursor = new Int32Array(size * 2) }
  if (gPairs.length < n * 2) { gPairs = new Uint32Array(n * 2); gRank = new Int32Array(n * 2); gSlot = new Int32Array(n * 2) }
  const { order, group } = views
  // pass 1: count members per group at gStart[g] (only the DENSE ids — the collect domain)
  gStart.fill(0, 0, size)
  for (let r = 0; r < n; r++) {
    const g = group[order[r]]
    if (g >= 0 && g < groupCount) gStart[g]++
  }
  // prefix over ALL buckets (ids beyond groupCount stay empty — queryable)
  let acc = 0
  for (let g = 0; g < size; g++) { const c = gStart[g]; gStart[g] = acc; acc += c }
  // pass 2: scatter (ranks ascending → every segment is rank-ascending)
  gCursor.set(gStart.subarray(0, size))
  for (let r = 0; r < n; r++) {
    const g = group[order[r]]
    if (g < 0 || g >= groupCount) continue
    const j = gCursor[g]++
    gPairs[j * 2] = r
    gPairs[j * 2 + 1] = order[r]
    gRank[j] = r
    gSlot[j] = order[r]
  }
}

/** P2: build the rank-space NF_VISIBLE mirror (pack-time + setVisible upkeep). */
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

/** P2: the fold — bits ∩ rankFlags → effScratch (O(bitsWords)). */
function foldEff(views, base) {
  const words = views.bitsWords
  const bits = views.bits
  for (let w = 0; w < words; w++) effScratch[w] = bits[base + w] & rankFlags[w]
}

// ── the variants (all must be bit-identical to `real` on the dense domain) ─
/** vA — P2 alone: fold + the current word-blocked walk, nodeFlags dropped. */
function vA(views, cameraIndex, bufferIndex, groupId, out) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, group, world, bits } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  foldEff(views, base)
  const capacity = out.length >>> 4
  const wEnd = Math.min(views.bitsWords, (n + 31) >>> 5)
  let k = 0
  scan: for (let w = 0; w < wEnd; w++) {
    const word = effScratch[w]
    if (word === 0) continue
    const rEnd = Math.min((w << 5) + 32, n)
    for (let r = w << 5; r < rEnd; r++) {
      if ((word & (1 << (r & 31))) === 0) continue
      const slot = order[r]
      if (group[slot] !== groupId) continue
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

/** vB — P1 alone: groupEntries walk (interleaved pairs), nodeFlags kept. */
function vB(views, cameraIndex, bufferIndex, groupId, out) {
  if (groupId < 0 || groupId >= views.groupMax) return 0 // dense-id domain (narrowing)
  const { world, bits, nodeFlags } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const capacity = out.length >>> 4
  const s = gStart[groupId] * 2
  const e = gStart[groupId + 1] * 2
  let k = 0
  for (let j = s; j < e; j += 2) {
    const r = gPairs[j]
    if ((bits[base + (r >>> 5)] & (1 << (r & 31))) === 0) continue
    const slot = gPairs[j + 1]
    if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
    if (k >= capacity) break
    const src = slot * 16
    const dst = k * 16
    out[dst] = world[src]; out[dst + 1] = world[src + 1]; out[dst + 2] = world[src + 2]; out[dst + 3] = world[src + 3]
    out[dst + 4] = world[src + 4]; out[dst + 5] = world[src + 5]; out[dst + 6] = world[src + 6]; out[dst + 7] = world[src + 7]
    out[dst + 8] = world[src + 8]; out[dst + 9] = world[src + 9]; out[dst + 10] = world[src + 10]; out[dst + 11] = world[src + 11]
    out[dst + 12] = world[src + 12]; out[dst + 13] = world[src + 13]; out[dst + 14] = world[src + 14]; out[dst + 15] = world[src + 15]
    k++
  }
  return k
}

/** vB2 — P1 alone, SPLIT arrays (the production-shape A/B against vB). */
function vB2(views, cameraIndex, bufferIndex, groupId, out) {
  if (groupId < 0 || groupId >= views.groupMax) return 0
  const { world, bits, nodeFlags } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const capacity = out.length >>> 4
  const s = gStart[groupId]
  const e = gStart[groupId + 1]
  let k = 0
  for (let j = s; j < e; j++) {
    const r = gRank[j]
    if ((bits[base + (r >>> 5)] & (1 << (r & 31))) === 0) continue
    const slot = gSlot[j]
    if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
    if (k >= capacity) break
    const src = slot * 16
    const dst = k * 16
    out[dst] = world[src]; out[dst + 1] = world[src + 1]; out[dst + 2] = world[src + 2]; out[dst + 3] = world[src + 3]
    out[dst + 4] = world[src + 4]; out[dst + 5] = world[src + 5]; out[dst + 6] = world[src + 6]; out[dst + 7] = world[src + 7]
    out[dst + 8] = world[src + 8]; out[dst + 9] = world[src + 9]; out[dst + 10] = world[src + 10]; out[dst + 11] = world[src + 11]
    out[dst + 12] = world[src + 12]; out[dst + 13] = world[src + 13]; out[dst + 14] = world[src + 14]; out[dst + 15] = world[src + 15]
    k++
  }
  return k
}

/** vC — P1+P2: fold + entries walk (interleaved). */
function vC(views, cameraIndex, bufferIndex, groupId, out) {
  if (groupId < 0 || groupId >= views.groupMax) return 0
  const { world, bits } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  foldEff(views, base)
  const capacity = out.length >>> 4
  const s = gStart[groupId] * 2
  const e = gStart[groupId + 1] * 2
  let k = 0
  for (let j = s; j < e; j += 2) {
    const r = gPairs[j]
    if ((effScratch[r >>> 5] & (1 << (r & 31))) === 0) continue
    if (k >= capacity) break
    const src = gPairs[j + 1] * 16
    const dst = k * 16
    out[dst] = world[src]; out[dst + 1] = world[src + 1]; out[dst + 2] = world[src + 2]; out[dst + 3] = world[src + 3]
    out[dst + 4] = world[src + 4]; out[dst + 5] = world[src + 5]; out[dst + 6] = world[src + 6]; out[dst + 7] = world[src + 7]
    out[dst + 8] = world[src + 8]; out[dst + 9] = world[src + 9]; out[dst + 10] = world[src + 10]; out[dst + 11] = world[src + 11]
    out[dst + 12] = world[src + 12]; out[dst + 13] = world[src + 13]; out[dst + 14] = world[src + 14]; out[dst + 15] = world[src + 15]
    k++
  }
  return k
}

/** vC2 — P1+P2, split arrays. */
function vC2(views, cameraIndex, bufferIndex, groupId, out) {
  if (groupId < 0 || groupId >= views.groupMax) return 0
  const { world, bits } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  foldEff(views, base)
  const capacity = out.length >>> 4
  const s = gStart[groupId]
  const e = gStart[groupId + 1]
  let k = 0
  for (let j = s; j < e; j++) {
    const r = gRank[j]
    if ((effScratch[r >>> 5] & (1 << (r & 31))) === 0) continue
    if (k >= capacity) break
    const src = gSlot[j] * 16
    const dst = k * 16
    out[dst] = world[src]; out[dst + 1] = world[src + 1]; out[dst + 2] = world[src + 2]; out[dst + 3] = world[src + 3]
    out[dst + 4] = world[src + 4]; out[dst + 5] = world[src + 5]; out[dst + 6] = world[src + 6]; out[dst + 7] = world[src + 7]
    out[dst + 8] = world[src + 8]; out[dst + 9] = world[src + 9]; out[dst + 10] = world[src + 10]; out[dst + 11] = world[src + 11]
    out[dst + 12] = world[src + 12]; out[dst + 13] = world[src + 13]; out[dst + 14] = world[src + 14]; out[dst + 15] = world[src + 15]
    k++
  }
  return k
}

/** vC-shared — the FOLD HOISTED OUT (once per camera per frame, the pool-like
 * usage): the caller folded effScratch already; the walk reads it. */
function vCshared(views, cameraIndex, bufferIndex, groupId, out) {
  if (groupId < 0 || groupId >= views.groupMax) return 0
  const { world } = views
  const capacity = out.length >>> 4
  const s = gStart[groupId] * 2
  const e = gStart[groupId + 1] * 2
  let k = 0
  for (let j = s; j < e; j += 2) {
    const r = gPairs[j]
    if ((effScratch[r >>> 5] & (1 << (r & 31))) === 0) continue
    if (k >= capacity) break
    const src = gPairs[j + 1] * 16
    const dst = k * 16
    out[dst] = world[src]; out[dst + 1] = world[src + 1]; out[dst + 2] = world[src + 2]; out[dst + 3] = world[src + 3]
    out[dst + 4] = world[src + 4]; out[dst + 5] = world[src + 5]; out[dst + 6] = world[src + 6]; out[dst + 7] = world[src + 7]
    out[dst + 8] = world[src + 8]; out[dst + 9] = world[src + 9]; out[dst + 10] = world[src + 10]; out[dst + 11] = world[src + 11]
    out[dst + 12] = world[src + 12]; out[dst + 13] = world[src + 13]; out[dst + 14] = world[src + 14]; out[dst + 15] = world[src + 15]
    k++
  }
  return k
}

/** vH — the PRODUCTION CANDIDATE: a hybrid. Small segments walk the entries;
 * large ones (|g| > n/4) keep the sequential word-scan (the entries walk
 * LOSES there — measured: +74% when the group IS the scene) with the fold.
 * The threshold is a contract constant (see the report). */
function vH(views, cameraIndex, bufferIndex, groupId, out) {
  if (groupId < 0 || groupId >= views.groupMax) return 0
  const n = views.headerI[H_NODE_COUNT]
  const s = gStart[groupId]
  const e = gStart[groupId + 1]
  if (e - s > (n >> 2)) return vA(views, cameraIndex, bufferIndex, groupId, out)
  return vC(views, cameraIndex, bufferIndex, groupId, out)
}

// ── the POOL PASS: real vs vP (flip-diff verbatim; count+fill via entries) ──
function vP(views, cameraIndex, bufferIndex) {
  const n = views.headerI[H_NODE_COUNT]
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  const maxInstances = views.headerI[H_MAX_INSTANCES]
  const { group, world, instPool, instCounts, instOffsets, bits, groupTouch, groupFlip, headerI, headerU, order } = views
  const bitsBaseV = bitsBase(views, bufferIndex, cameraIndex)
  const countsBase = (bufferIndex * views.cameraMax + cameraIndex) * views.groupMax
  const offsetsBase = countsBase
  const pool = instancePoolBase(views, bufferIndex, cameraIndex)
  const words = views.bitsWords

  // flip-diff — VERBATIM from the src (equal overhead on both sides)
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

  // P2: the fold (once per call — shared by counting AND fill)
  foldEff(views, bitsBaseV)

  // 1) counting via the GROUP ENTRIES (no order/group/nodeFlags loads)
  for (let g = 0; g < groupCount; g++) {
    const s = gStart[g] * 2
    const e = gStart[g + 1] * 2
    let count = 0
    for (let j = s; j < e; j += 2) {
      const r = gPairs[j]
      if ((effScratch[r >>> 5] & (1 << (r & 31))) !== 0) count++
    }
    instCounts[countsBase + g] = count
  }

  // 2) prefix offsets (id order — the same)
  let total = 0
  for (let g = 0; g < groupCount; g++) {
    instOffsets[offsetsBase + g] = total
    total += instCounts[countsBase + g]
  }

  // 3) filling the pool — entries walk + unrolled copy (drop accounting exact)
  let dropped = 0
  for (let g = 0; g < groupCount; g++) {
    const s = gStart[g] * 2
    const e = gStart[g + 1] * 2
    let cursor = 0
    for (let j = s; j < e; j += 2) {
      const r = gPairs[j]
      if ((effScratch[r >>> 5] & (1 << (r & 31))) === 0) continue
      const dst = instOffsets[offsetsBase + g] + cursor
      if (dst >= maxInstances) { dropped++; continue }
      cursor++
      const src = gPairs[j + 1] * 16
      const o = pool + dst * 16
      instPool[o] = world[src]; instPool[o + 1] = world[src + 1]; instPool[o + 2] = world[src + 2]; instPool[o + 3] = world[src + 3]
      instPool[o + 4] = world[src + 4]; instPool[o + 5] = world[src + 5]; instPool[o + 6] = world[src + 6]; instPool[o + 7] = world[src + 7]
      instPool[o + 8] = world[src + 8]; instPool[o + 9] = world[src + 9]; instPool[o + 10] = world[src + 10]; instPool[o + 11] = world[src + 11]
      instPool[o + 12] = world[src + 12]; instPool[o + 13] = world[src + 13]; instPool[o + 14] = world[src + 14]; instPool[o + 15] = world[src + 15]
    }
  }
  if (dropped > 0) views.headerI[H_DROPPED_INSTANCES] += dropped
  return total - dropped
}

// ── fixtures & harness (the task-186 canon) ────────────────────────────────
function buildScene(N, groups, groupOfNode, fov = 1.0) {
  const scene = createScene({ capacity: N, cameraMax: 1, groupMax: groups, maxInstances: N })
  for (let i = 0; i < N; i++) {
    const x = (i % 100) * 6 - 300
    const y = ((i / 100) | 0) % 100 * 6 - 300
    const z = ((i / 10000) | 0) * 8
    scene.create({ position: [x, y, z], sphere: [0, 0, 0, 2], group: groupOfNode(i) })
  }
  scene.updateWorld()
  const cam = createCamera().setPerspective(fov, 1, 0.1, 900)
  cam.setViewLookAt(0, 0, 400, 0, 0, 0, 0, 1, 0)
  writeCameraPlanes(scene.views, 0, cam.planes)
  cullViewsBrute(scene.views, 0, 0)
  let visible = 0
  const bits = scene.views.bits
  for (let w = 0; w < scene.views.bitsWords; w++) {
    let x = bits[w]
    x = x - ((x >>> 1) & 0x55555555)
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
    visible += (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
  }
  return { scene, visible }
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
    console.log(`   ${r.name.padEnd(26)} ${r.med.toFixed(3)}ms  min ${r.min.toFixed(3)}ms  ${r === rows[0] ? '—' : ((100 * (r.med - base) / base).toFixed(1) + '%')}`)
  }
}

function arraysEqual(a, b, len) {
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return false
  return true
}

function prepare(views) {
  buildGroupIndex(views)
  buildRankFlags(views)
}

function runScenario(title, scene, groupId, out, runs = 40) {
  console.log(`\n== ${title} ==`)
  const views = scene.views
  prepare(views)
  out.fill(7.77) // sentinel: untouched tail must stay IDENTICAL in every variant
  const kReal = collectGroupMatrices(views, 0, 0, groupId, out)
  const ref = out.slice()
  for (const [name, fn] of [['vA', vA], ['vB', vB], ['vB2', vB2], ['vC', vC], ['vC2', vC2], ['vH', vH]]) {
    out.fill(7.77)
    const k = fn(views, 0, 0, groupId, out)
    if (k !== kReal || !arraysEqual(out, ref, out.length)) {
      console.log(`   ✗ ${name}: MISMATCH (k=${k} vs ${kReal})`)
      process.exit(1)
    }
  }
  console.log(`   all variants bit-identical (k=${kReal})`)
  const rows = [
    bench('real (current)', () => { collectGroupMatrices(views, 0, 0, groupId, out) }, runs),
    bench('vA fold only (P2)', () => { vA(views, 0, 0, groupId, out) }, runs),
    bench('vB entries (P1)', () => { vB(views, 0, 0, groupId, out) }, runs),
    bench('vB2 entries split (P1)', () => { vB2(views, 0, 0, groupId, out) }, runs),
    bench('vC fold+entries (P1+P2)', () => { vC(views, 0, 0, groupId, out) }, runs),
    bench('vC2 fold+entries split', () => { vC2(views, 0, 0, groupId, out) }, runs),
    bench('vH hybrid (production)', () => { vH(views, 0, 0, groupId, out) }, runs),
  ]
  report(rows)
  return rows
}

// ── PROPERTY PARITY: randomized scenes, full-array equality ────────────────
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function propertyParity() {
  console.log('\n== PROPERTY PARITY (randomized scenes) ==')
  let cases = 0
  for (let seed = 1; seed <= 12; seed++) {
    const rng = mulberry32(seed * 7919)
    const N = 1 + Math.floor(rng() * 4000)
    const groupMax = 8
    const scene = createScene({ capacity: N, cameraMax: 1, groupMax, maxInstances: N })
    for (let i = 0; i < N; i++) {
      const x = rng() * 600 - 300
      const y = rng() * 600 - 300
      const z = rng() * 200
      // groups: -1 (not instanced) .. groupMax-1 (ids ≥ groupMax are
      // REJECTED by create()'s own contract — cannot exist)
      const pick = rng()
      const g = pick < 0.2 ? -1 : Math.floor(rng() * groupMax)
      scene.create({ position: [x, y, z], sphere: [rng() * 2, rng() * 2, rng() * 2, 1 + rng() * 3], group: g })
    }
    // random per-node visible flags (P2's mirror must track them)
    for (let i = 0; i < N; i++) scene.setVisible(i, rng() > 0.3)
    scene.updateWorld()
    const cam = createCamera().setPerspective(0.4 + rng() * 1.4, 1, 0.1, 900)
    cam.setViewLookAt(rng() * 200 - 100, rng() * 200 - 100, 200 + rng() * 400, 0, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    // stale tail bits: junk beyond (n+31)>>5 AND the live tail word — real
    // must ignore them; so must the variants (the fold kills them for free)
    const views = scene.views
    const n = views.headerI[H_NODE_COUNT]
    for (let w = (n + 31) >>> 5; w < views.bitsWords; w++) views.bits[w] = (rng() * 4294967296) >>> 0
    if (n > 0 && (n & 31) !== 0) views.bits[(n - 1) >>> 5] |= ((rng() * 4294967296) >>> 0) & (-1 << (n & 31))
    prepare(views)
    const outLen = 1 + Math.floor(rng() * (N + 10)) // generous AND truncated outs
    for (const buf of [0, 1]) {
      const out = new Float32Array(outLen * 16)
      // dense-id domain incl. empty ids and the last bucket
      for (const g of [0, 1, groupMax - 2, groupMax - 1, groupMax]) {
        const ref = new Float32Array(outLen * 16).fill(7.77)
        const kRef = collectGroupMatrices(views, 0, buf, g, ref)
        for (const [name, fn] of [['vA', vA], ['vB', vB], ['vB2', vB2], ['vC', vC], ['vC2', vC2], ['vH', vH]]) {
          out.fill(7.77)
          const k = fn(views, 0, buf, g, out)
          if (k !== kRef || !arraysEqual(out, ref, outLen * 16)) {
            console.log(`   ✗ seed ${seed} buf ${buf} g ${g} ${name}: k=${k} vs ${kRef}`)
            process.exit(1)
          }
        }
        cases++
      }
      // the pool pass: counts/offsets/return/pool bytes (written region only —
      // the poison tail must SURVIVE: no OOB writes)
      const poolBase = instancePoolBase(views, buf, 0)
      const poolLen = views.headerI[H_MAX_INSTANCES] * 16
      const countsPre = views.instCounts.slice()
      const offsetsPre = views.instOffsets.slice()
      const retReal = collectInstancesViews(views, 0, buf)
      const countsA = views.instCounts.slice()
      const offsetsA = views.instOffsets.slice()
      const poolA = views.instPool.slice(poolBase, poolBase + poolLen)
      // vP from the SAME pre-state: restore, poison the pool, run, compare
      views.instCounts.set(countsPre); views.instOffsets.set(offsetsPre)
      views.instPool.fill(9999999, poolBase, poolBase + poolLen)
      const retV = vP(views, 0, buf)
      if (retV !== retReal || !arraysEqual(views.instCounts, countsA, countsA.length) || !arraysEqual(views.instOffsets, offsetsA, offsetsA.length)) {
        console.log(`   ✗ seed ${seed} buf ${buf} POOL vP: ret=${retV} vs ${retReal} / counts or offsets differ`)
        process.exit(1)
      }
      const written = retV * 16
      for (let i = 0; i < written; i++) {
        if (views.instPool[poolBase + i] !== poolA[i]) {
          console.log(`   ✗ seed ${seed} buf ${buf} POOL vP: pool bytes differ at ${i}`)
          process.exit(1)
        }
      }
      for (let i = written; i < poolLen; i++) {
        if (views.instPool[poolBase + i] !== 9999999) {
          console.log(`   ✗ seed ${seed} buf ${buf} POOL vP: OOB write at ${i} (poison overwritten)`)
          process.exit(1)
        }
      }
      cases++
    }
  }
  console.log(`   ✓ ${cases} parity cases PASS (group collects + pool passes; truncated out, stale bits, empty/out-of-range ids)`)
}

// ── main ───────────────────────────────────────────────────────────────────
const N = 100_000

const { scene: sceneSingle, visible: visSingle } = buildScene(N, 4, () => 0)
console.log(`single: nodes=${N} visible=${visSingle} (${(100 * visSingle / N).toFixed(1)}%)`)
runScenario('SINGLE group (100% of nodes)', sceneSingle, 0, new Float32Array(visSingle * 16 + 64))

const { scene: sceneLarge, visible: visLarge } = buildScene(N, 8, (i) => (i % 2 === 0 ? 0 : 1 + (i % 7)))
console.log(`\nlarge: nodes=${N} visible=${visLarge} (${(100 * visLarge / N).toFixed(1)}%)`)
runScenario('LARGE group (≈50% of nodes, 8 groups)', sceneLarge, 0, new Float32Array(60_000 * 16))

const { scene: sceneSmall, visible: visSmall } = buildScene(N, 100, (i) => i % 100)
console.log(`\nsmall: nodes=${N} visible=${visSmall} (${(100 * visSmall / N).toFixed(1)}%)`)
{
  const counts = new Int32Array(100)
  const { order, group, bits, nodeFlags } = sceneSmall.views
  for (let r = 0; r < N; r++) {
    const slot = order[r]
    if ((bits[r >>> 5] & (1 << (r & 31))) === 0) continue
    if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
    const g = group[slot]
    if (g >= 0) counts[g]++
  }
  let bestG = 0, bestC = -1
  for (let g = 0; g < 100; g++) if (counts[g] > bestC) { bestC = counts[g]; bestG = g }
  console.log(`   small-group pick: group ${bestG} with ${bestC} visible members`)
  runScenario('SMALL group (≈1% of nodes, 100 groups)', sceneSmall, bestG, new Float32Array(4_000 * 16))
}

const { scene: sceneMany, visible: visMany } = buildScene(N, 1000, (i) => i % 1000)
console.log(`\nmany: nodes=${N} visible=${visMany} (${(100 * visMany / N).toFixed(1)}%)`)
runScenario('MANY groups (1000 groups, ≈0.1% each)', sceneMany, 7, new Float32Array(512 * 16))

const { scene: sceneSparse, visible: visSparse } = buildScene(N, 100, (i) => i % 100, 0.28)
console.log(`\nsparse: nodes=${N} visible=${visSparse} (${(100 * visSparse / N).toFixed(1)}%) — today's word-scan is CHEAPEST here; entries must not lose`)
{
  const counts = new Int32Array(100)
  const { order, group, bits, nodeFlags } = sceneSparse.views
  for (let r = 0; r < N; r++) {
    const slot = order[r]
    if ((bits[r >>> 5] & (1 << (r & 31))) === 0) continue
    if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
    const g = group[slot]
    if (g >= 0) counts[g]++
  }
  let bestG = 0, bestC = -1
  for (let g = 0; g < 100; g++) if (counts[g] > bestC) { bestC = counts[g]; bestG = g }
  console.log(`   sparse-group pick: group ${bestG} with ${bestC} visible members`)
  runScenario('SPARSE visibility (100 groups)', sceneSparse, bestG, new Float32Array(2000 * 16))
}

// ── SWEEP: all 100 groups back to back (the T0 asymptotic) ─────────────────
{
  console.log('\n== SWEEP all 100 groups (T0 asymptotics) ==')
  const views = sceneSmall.views
  prepare(views)
  const out = new Float32Array(4_000 * 16)
  const hashSweep = (fn) => {
    let h = 2166136261
    for (let g = 0; g < 100; g++) {
      const k = fn(views, 0, 0, g, out)
      h = Math.imul(h ^ k, 16777619)
      for (let i = 0; i < k * 16; i++) h = Math.imul(h ^ Math.round(out[i] * 1024), 16777619)
    }
    return h >>> 0
  }
  const hRef = hashSweep(collectGroupMatrices)
  const hC = hashSweep(vC)
  if (hRef !== hC) { console.log(`   ✗ sweep parity MISMATCH (${hRef} vs ${hC})`); process.exit(1) }
  console.log('   sweep parity OK (per-group k + prefix checksums match)')
  const rows = [
    bench('real sweep (current)', () => { for (let g = 0; g < 100; g++) collectGroupMatrices(views, 0, 0, g, out) }, 10),
    bench('vC sweep (fold per call)', () => { for (let g = 0; g < 100; g++) vC(views, 0, 0, g, out) }, 10),
    bench('vC sweep (SHARED fold)', () => { foldEff(views, bitsBase(views, 0, 0)); for (let g = 0; g < 100; g++) vCshared(views, 0, 0, g, out) }, 10),
    bench('vC2 sweep (SHARED fold)', () => { foldEff(views, bitsBase(views, 0, 0)); for (let g = 0; g < 100; g++) vC2(views, 0, 0, g, out) }, 10),
  ]
  report(rows)
}

// ── THE POOL PASS (collectInstancesViews) ──────────────────────────────────
{
  console.log('\n== POOL PASS (collectInstancesViews, 100 groups, 45% visibility) ==')
  const views = sceneSmall.views
  prepare(views)
  const poolBase = instancePoolBase(views, 0, 0)
  const poolLen = views.headerI[H_MAX_INSTANCES] * 16
  const countsPre = views.instCounts.slice()
  const offsetsPre = views.instOffsets.slice()
  const retReal = collectInstancesViews(views, 0, 0)
  const countsA = views.instCounts.slice()
  const offsetsA = views.instOffsets.slice()
  const poolA = views.instPool.slice(poolBase, poolBase + poolLen)
  views.instCounts.set(countsPre); views.instOffsets.set(offsetsPre)
  views.instPool.fill(9999999, poolBase, poolBase + poolLen)
  const retV = vP(views, 0, 0)
  if (retV !== retReal || !arraysEqual(views.instCounts, countsA, countsA.length) || !arraysEqual(views.instOffsets, offsetsA, offsetsA.length)) {
    console.log(`   ✗ pool parity: ret=${retV} vs ${retReal}`)
    process.exit(1)
  }
  const written = retV * 16
  for (let i = 0; i < written; i++) {
    if (views.instPool[poolBase + i] !== poolA[i]) { console.log(`   ✗ pool bytes differ at ${i}`); process.exit(1) }
  }
  for (let i = written; i < poolLen; i++) {
    if (views.instPool[poolBase + i] !== 9999999) { console.log(`   ✗ OOB write at ${i} (poison overwritten)`); process.exit(1) }
  }
  console.log(`   pool parity OK (ret=${retReal}, counts/offsets/pool bytes identical)`)
  const rows = [
    bench('real pool (current)', () => { collectInstancesViews(views, 0, 0) }, 20),
    bench('vP pool (fold+entries)', () => { vP(views, 0, 0) }, 20),
  ]
  report(rows)
}

// ── THE PACK-TIME FEE (the amortized contract cost) ────────────────────────
{
  console.log('\n== PACK-TIME FEE (per repack / per collect) ==')
  const views = sceneSmall.views
  const rows = [
    bench('buildGroupIndex (per repack)', () => { buildGroupIndex(views) }, 40),
    bench('buildRankFlags (per repack)', () => { buildRankFlags(views) }, 40),
    bench('foldEff (per collect call)', () => { foldEff(views, bitsBase(views, 0, 0)) }, 40),
  ]
  report(rows)
}

propertyParity()
console.log('\nTASK 188 COLLECT PROBE: ALL PARITY CHECKS PASS')
