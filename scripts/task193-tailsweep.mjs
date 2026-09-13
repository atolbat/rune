/**
 * task193-tailsweep.mjs — Task 193 (theory B): the CULL TAIL SWEEP inherits
 * the plane classification from the parents (the Task-192 stage-summary
 * follow-up: "ранговая маска для хвостового sweep — наследовать плоскости
 * от родителей — сейчас 6 на лист").
 *
 * The production sweep (culling.ts, Task 192) brute-tests EVERY tail leaf
 * against all 6 planes — even when the leaf's PARENT (a tree node the walk
 * just classified) was trivially accepted/rejected, and even when the
 * parent NARROWED the plane mask (Task 85) for its tree children. The tail
 * children get NOTHING from their parents today.
 *
 * Variants (all bit-identical to the production sweep — the parity gate):
 *   A  — the production shape (verbatim copy): 6 planes per tail leaf;
 *   B2 — PARENT-CLASSIFY: the walk writes a rank-space classification word
 *        (cls | mask<<8; ACCEPT / REJECT / STRADDLE+narrowed mask); the
 *        sweep looks the leaf's PARENT up (parent→rankOf→classWord) instead
 *        of 6 dot products. A root leaf (parent −1) tests fully — the
 *        current behavior. The scratch is TRANSIENT per call (module-level
 *        is safe — the same discipline as rangeStack);
 *   B1 — GROUP-SPHERE SEGMENTS: the N4 group sphere classifies the whole
 *        segment (out → clear words, in → fill words, straddle → the sweep
 *        with the segment's narrowed mask). The sphere cache is the N4
 *        WeakMap discipline (groupTouch stamps; the bench builds once and
 *        reuses — the steady-state shape);
 *   C  — the composite: B1 segment classification; a straddling segment's
 *        leaves read the parent's classification (B2) with
 *        mask = segMask & parentMask (both bounds are enclosing — a plane
 *        dropped by EITHER is proven passed).
 *
 * NOTHING here invents data: twin scenes, parity gates before measurement
 * (a variant that fails parity does not get to be measured), medians over
 * warm runs, and the ISOLATE discipline (Task 192's lesson: interleaved
 * A/B in one process deoptimizes the shared kernels — timing comes from
 * SEPARATE child processes, one per variant).
 */
import {
  createScene, createCamera, writeCameraPlanes, cullViewsBrute, cullViewsHierarchical,
  setCullMemo, setCullTailSpheres,
} from '../packages/scene/src/index.ts'
import { bitsBase, fillBits, popcountBits } from '../packages/scene/src/culling.ts'
import { H_NODE_COUNT, H_GROUP_COUNT } from '../packages/scene/src/layout.ts'

// ── the bench harness (median + min, warm) ─────────────────────────────────
function bench(name, fn, iters = 12, inner = 1) {
  // 50 warmups: the Task-193 honest-measurement lesson — the first bench of
  // a process pays the JIT tiering, and cross-process A/B medians swing 2×
  // on the same code (the "+59% regression" was FTL trajectory, not the
  // path — the same-process diagnostic pinned ON ≈ OFF at the min). 50
  // warmups + the min give the steady state.
  for (let i = 0; i < 50; i++) fn() // warmup
  const samples = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    for (let j = 0; j < inner; j++) fn()
    samples.push((performance.now() - t0) / inner)
  }
  samples.sort((a, b) => a - b)
  return { name, med: samples[samples.length >> 1], min: samples[0] }
}

function report(rows) {
  for (const r of rows) console.log(`   ${r.name.padEnd(48)} ${r.med.toFixed(4)}ms  min ${r.min.toFixed(4)}ms`)
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── scenes ─────────────────────────────────────────────────────────────────
const N = 100_000

/** The README shape: 10k cluster roots (auto spheres) × 9 grouped leaves. */
function buildCluster(seed, groups = 100) {
  const rnd = mulberry32(seed)
  const scene = createScene({ capacity: N + 64, groupMax: groups, cameraMax: 4, maxInstances: N })
  const CL = 10_000
  const cols = 100
  for (let c = 0; c < CL; c++) {
    const gx = (c % cols) * 60 - (cols * 60) / 2
    const gz = ((c / cols) | 0) * 60 - (CL / cols / 2) * 60
    const root = scene.create({
      position: [gx, 0, gz],
      sphere: [0, 0, 0, -1], // auto — refit computes the enclosing bound
    })
    for (let k = 0; k < 9; k++) {
      scene.create({
        parent: root,
        position: [gx + (rnd() - 0.5) * 20, (rnd() - 0.5) * 8, gz + (rnd() - 0.5) * 20],
        group: (rnd() * groups) | 0,
        sphere: [0, 0, 0, 0.5 + rnd() * 1.5],
      })
    }
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  return scene
}

/** The flat swarm: root grouped LEAVES only (parent −1 — the B2 no-op shape). */
function buildFlat(seed, groups = 4, count = 30_000) {
  const rnd = mulberry32(seed)
  const scene = createScene({ capacity: count + 64, groupMax: groups, cameraMax: 4, maxInstances: count })
  for (let i = 0; i < count; i++) {
    scene.create({
      position: [(rnd() - 0.5) * 400, (rnd() - 0.5) * 200, (rnd() - 0.5) * 400],
      group: (rnd() * groups) | 0,
      sphere: [0, 0, 0, 0.5 + rnd() * 2],
    })
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  return scene
}

/** The task192 pattern: a random structure forest with grouped leaves. */
function buildMixed(seed, groups = 100) {
  const rnd = mulberry32(seed)
  const scene = createScene({ capacity: N + 64, groupMax: groups, cameraMax: 4, maxInstances: N })
  const parents = []
  for (let i = 0; i < N; i++) {
    const parent = parents.length > 0 && rnd() < 0.6 ? parents[(rnd() * parents.length) | 0] : -1
    const isLeaf = rnd() < 0.45
    const slot = scene.create({
      parent,
      position: [(rnd() - 0.5) * 600, (rnd() - 0.5) * 300, (rnd() - 0.5) * 600],
      group: isLeaf ? (rnd() * groups) | 0 : -1,
      sphere: [0, 0, 0, isLeaf ? 0.5 + rnd() * 2 : -1],
    })
    if (isLeaf) parents.length = 0
    else parents.push(slot)
    if (parents.length > 64) parents.splice(0, 32)
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  return scene
}

/** The instance-field shape: 20 compact swarms (1500 leaves in a 30-unit ball, one group each). */
function buildSwarms(seed, groups = 20) {
  const rnd = mulberry32(seed)
  const count = groups * 1500
  const scene = createScene({ capacity: count + 64, groupMax: groups, cameraMax: 4, maxInstances: count })
  for (let g = 0; g < groups; g++) {
    const ox = (rnd() - 0.5) * 900, oy = (rnd() - 0.5) * 300, oz = (rnd() - 0.5) * 900
    for (let i = 0; i < 1500; i++) {
      scene.create({
        position: [ox + (rnd() - 0.5) * 30, oy + (rnd() - 0.5) * 30, oz + (rnd() - 0.5) * 30],
        group: g,
        sphere: [0, 0, 0, 0.5 + rnd() * 2],
      })
    }
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  return scene
}

// ── the cameras (four very different frustums) ─────────────────────────────
const CAMS = {
  band: () => makeCam(1.0, 1200, [0, 120, 500], [0, 0, 0]),
  all: () => makeCam(1.2, 20000, [0, 0, 9000], [0, 0, 0]),
  out: () => makeCam(1.0, 1200, [0, 0, 500], [0, 0, 2000]),
  edge: () => makeCam(1.0, 1200, [350, 0, 300], [0, 0, 0]),
}
function makeCam(fov, far, eye, target) {
  return createCamera().setPerspective(fov, 1, 0.1, far).setViewLookAt(eye[0], eye[1], eye[2], target[0], target[1], target[2], 0, 1, 0)
}

// ── the walk machinery (a faithful copy of culling.ts; B2 adds the
//    classWord writes — cls | mask<<8; ACCEPT=1, REJECT=2, STRADDLE=0) ──────
let rangeStack = new Int32Array(8192)
function pushRange(s, e, mask, sp) {
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
function splitChildrenOf(order, subtreeEnd, s, e, mask, sp) {
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

/** The transient rank-space classification scratch (B2). Grown geometrically,
 *  rewritten every call — module-level is safe (rangeStack's discipline). */
let classWordRank = new Int32Array(4096)
const CW_ACCEPT = 1
const CW_REJECT = 2

// ── VARIANT A: the production cull (verbatim — the reference shape) ─────────
function cullA(views, cameraIndex, bufferIndex) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, parent, subtreeEnd, sphereW, bits, planes } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const pb = cameraIndex * 24
  const treeN = views.gStart[0]

  let sp = 0
  for (let r = 0; r < treeN; ) {
    const slot = order[r]
    const end = subtreeEnd[slot]
    if (parent[slot] < 0 && end > r) {
      sp = pushRange(r, end, 0x3f, sp)
      r = end
    } else {
      r++
    }
  }

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
    const enclosing = leaf || r > 0

    let outside = false
    let insideAll = true
    let interMask = 0
    let m = mask
    while (m !== 0) {
      const pbIdx = m & -m
      const i = 31 - Math.clz32(pbIdx)
      m ^= pbIdx
      const o = pb + i * 4
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
      } else {
        bits[base + (s >>> 5)] &= ~(1 << (s & 31))
        sp = splitChildrenOf(order, subtreeEnd, s, e, mask, sp)
      }
      continue
    }
    if (insideAll && enclosing) {
      fillBits(bits, base, s, e, true)
      continue
    }
    bits[base + (s >>> 5)] |= 1 << (s & 31)
    if (!leaf) sp = splitChildrenOf(order, subtreeEnd, s, e, enclosing ? interMask : mask, sp)
  }

  if (treeN < n) {
    for (let r = treeN; r < n; r++) {
      const slot = order[r]
      const o4 = slot * 4
      const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2]
      const rad = sphereW[o4 + 3]
      let vis = true
      for (let i = 0; i < 6; i++) {
        const o = pb + i * 4
        if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] < -rad) {
          vis = false
          break
        }
      }
      const w = base + (r >>> 5)
      const m = 1 << (r & 31)
      if (vis) bits[w] |= m
      else bits[w] &= ~m
    }
  }
}

// ── VARIANT B2: parent-classify (the walk writes classWordRank) ─────────────
function cullB2(views, cameraIndex, bufferIndex) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, parent, subtreeEnd, sphereW, bits, planes, rankOf } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const pb = cameraIndex * 24
  const treeN = views.gStart[0]
  if (classWordRank.length < n) classWordRank = new Int32Array(n * 2)

  let sp = 0
  for (let r = 0; r < treeN; ) {
    const slot = order[r]
    const end = subtreeEnd[slot]
    if (parent[slot] < 0 && end > r) {
      sp = pushRange(r, end, 0x3f, sp)
      r = end
    } else {
      r++
    }
  }

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
    const enclosing = leaf || r > 0

    let outside = false
    let insideAll = true
    let interMask = 0
    let m = mask
    while (m !== 0) {
      const pbIdx = m & -m
      const i = 31 - Math.clz32(pbIdx)
      m ^= pbIdx
      const o = pb + i * 4
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
        classWordRank.fill(CW_REJECT, s, e)
      } else {
        bits[base + (s >>> 5)] &= ~(1 << (s & 31))
        // the point is outside, the children may protrude — TEST (inherited mask)
        classWordRank[s] = mask << 8
        sp = splitChildrenOf(order, subtreeEnd, s, e, mask, sp)
      }
      continue
    }
    if (insideAll && enclosing) {
      fillBits(bits, base, s, e, true)
      classWordRank.fill(CW_ACCEPT, s, e)
      continue
    }
    bits[base + (s >>> 5)] |= 1 << (s & 31)
    const childMask = enclosing ? interMask : mask
    classWordRank[s] = childMask << 8
    if (!leaf) sp = splitChildrenOf(order, subtreeEnd, s, e, childMask, sp)
  }

  // the sweep: the PARENT's classification instead of 6 dot products
  if (treeN < n) {
    for (let r = treeN; r < n; r++) {
      const slot = order[r]
      const w = base + (r >>> 5)
      const bit = 1 << (r & 31)
      const p = parent[slot]
      if (p >= 0) {
        const cw = classWordRank[rankOf[p]]
        const cls = cw & 0xff
        if (cls === CW_ACCEPT) {
          bits[w] |= bit
          continue
        }
        if (cls === CW_REJECT) {
          bits[w] &= ~bit
          continue
        }
        // straddle — the narrowed mask (0: every plane proven passed)
        let vis = true
        let m = cw >>> 8
        const o4 = slot * 4
        while (m !== 0) {
          const pbIdx = m & -m
          const i = 31 - Math.clz32(pbIdx)
          m ^= pbIdx
          const o = pb + i * 4
          if (planes[o] * sphereW[o4] + planes[o + 1] * sphereW[o4 + 1] + planes[o + 2] * sphereW[o4 + 2] + planes[o + 3] < -sphereW[o4 + 3]) {
            vis = false
            break
          }
        }
        if (vis) bits[w] |= bit
        else bits[w] &= ~bit
      } else {
        // a root leaf — no parent classification: the full test (verbatim)
        const o4 = slot * 4
        const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2]
        const rad = sphereW[o4 + 3]
        let vis = true
        for (let i = 0; i < 6; i++) {
          const o = pb + i * 4
          if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] < -rad) {
            vis = false
            break
          }
        }
        if (vis) bits[w] |= bit
        else bits[w] &= ~bit
      }
    }
  }
}

// ── VARIANT B1: group-sphere segment classification (the N4 sphere) ────────
/** The N4 sphere builder shape (segment walk; AABB + enclosing radius). */
const sphereCache = new Map()
function groupSpheresOf(views) {
  let state = sphereCache.get(views)
  if (state === undefined) {
    state = { spheres: new Float32Array(views.groupMax * 4) }
    sphereCache.set(views, state)
  }
  return state
}
function buildAllGroupSpheres(views) {
  const n = views.headerI[H_NODE_COUNT]
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  const { order, sphereW, gStart } = views
  const state = groupSpheresOf(views)
  for (let g = 0; g < groupCount; g++) {
    const segFrom = gStart[g]
    const segTo = gStart[g + 1]
    const o4g = g * 4
    if (segTo <= segFrom) {
      state.spheres[o4g + 3] = -1
      continue
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let r = segFrom; r < segTo; r++) {
      const o4 = order[r] * 4
      const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2], rad = sphereW[o4 + 3]
      const x0 = cx - rad, x1 = cx + rad, y0 = cy - rad, y1 = cy + rad, z0 = cz - rad, z1 = cz + rad
      if (x0 < minX) minX = x0
      if (x1 > maxX) maxX = x1
      if (y0 < minY) minY = y0
      if (y1 > maxY) maxY = y1
      if (z0 < minZ) minZ = z0
      if (z1 > maxZ) maxZ = z1
    }
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5
    let radius = 0
    for (let r = segFrom; r < segTo; r++) {
      const o4 = order[r] * 4
      const dx = sphereW[o4] - cx, dy = sphereW[o4 + 1] - cy, dz = sphereW[o4 + 2] - cz
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + sphereW[o4 + 3]
      if (d > radius) radius = d
    }
    state.spheres[o4g] = cx
    state.spheres[o4g + 1] = cy
    state.spheres[o4g + 2] = cz
    state.spheres[o4g + 3] = radius
  }
  return state
}

/** The leaf test under a plane mask (shared by B1/C sweeps). */
function maskedLeafTest(planes, pb, sphereW, slot, m) {
  const o4 = slot * 4
  while (m !== 0) {
    const pbIdx = m & -m
    const i = 31 - Math.clz32(pbIdx)
    m ^= pbIdx
    const o = pb + i * 4
    if (planes[o] * sphereW[o4] + planes[o + 1] * sphereW[o4 + 1] + planes[o + 2] * sphereW[o4 + 2] + planes[o + 3] < -sphereW[o4 + 3]) {
      return false
    }
  }
  return true
}

function cullB1(views, cameraIndex, bufferIndex) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, subtreeEnd, parent, sphereW, bits, planes } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const pb = cameraIndex * 24
  const treeN = views.gStart[0]
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  const state = groupSpheresOf(views)

  // the tree walk (identical to A — the tree region is unchanged)
  let sp = 0
  for (let r = 0; r < treeN; ) {
    const slot = order[r]
    const end = subtreeEnd[slot]
    if (parent[slot] < 0 && end > r) {
      sp = pushRange(r, end, 0x3f, sp)
      r = end
    } else {
      r++
    }
  }
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
    const enclosing = leaf || r > 0
    let outside = false
    let insideAll = true
    let interMask = 0
    let m = mask
    while (m !== 0) {
      const pbIdx = m & -m
      const i = 31 - Math.clz32(pbIdx)
      m ^= pbIdx
      const o = pb + i * 4
      const d = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3]
      if (d < -r) { outside = true; break }
      if (d < r) { interMask |= pbIdx; insideAll = false }
    }
    if (outside) {
      if (enclosing) fillBits(bits, base, s, e, false)
      else {
        bits[base + (s >>> 5)] &= ~(1 << (s & 31))
        sp = splitChildrenOf(order, subtreeEnd, s, e, mask, sp)
      }
      continue
    }
    if (insideAll && enclosing) {
      fillBits(bits, base, s, e, true)
      continue
    }
    bits[base + (s >>> 5)] |= 1 << (s & 31)
    if (!leaf) sp = splitChildrenOf(order, subtreeEnd, s, e, enclosing ? interMask : mask, sp)
  }

  // the tail: per-SEGMENT classification by the group sphere
  for (let g = 0; g < groupCount; g++) {
    const segFrom = views.gStart[g]
    const segTo = views.gStart[g + 1]
    if (segTo <= segFrom) continue
    const o4g = g * 4
    const gr = state.spheres[o4g + 3]
    let segMask = 0x3f
    if (gr > 0) {
      const gcx = state.spheres[o4g], gcy = state.spheres[o4g + 1], gcz = state.spheres[o4g + 2]
      let outside = false
      let insideAll = true
      let inter = 0
      for (let i = 0; i < 6; i++) {
        const o = pb + i * 4
        const d = planes[o] * gcx + planes[o + 1] * gcy + planes[o + 2] * gcz + planes[o + 3]
        if (d < -gr) { outside = true; break }
        if (d < gr) { inter |= 1 << i; insideAll = false }
      }
      if (outside) { fillBits(bits, base, segFrom, segTo, false); continue }
      if (insideAll) { fillBits(bits, base, segFrom, segTo, true); continue }
      segMask = inter
    }
    for (let r = segFrom; r < segTo; r++) {
      const slot = order[r]
      const w = base + (r >>> 5)
      const bit = 1 << (r & 31)
      // the inlined masked test (a shared function call cost +26% — JSC does
      // not inline it across the module; the monolithic loop form it is)
      let vis = true
      let m = segMask
      const o4 = slot * 4
      while (m !== 0) {
        const pbIdx = m & -m
        const i = 31 - Math.clz32(pbIdx)
        m ^= pbIdx
        const o = pb + i * 4
        if (planes[o] * sphereW[o4] + planes[o + 1] * sphereW[o4 + 1] + planes[o + 2] * sphereW[o4 + 2] + planes[o + 3] < -sphereW[o4 + 3]) {
          vis = false
          break
        }
      }
      if (vis) bits[w] |= bit
      else bits[w] &= ~bit
    }
  }
}

// ── VARIANT C: composite (B1 segments; straddling segments read B2 parents) ─
function cullC(views, cameraIndex, bufferIndex) {
  const n = views.headerI[H_NODE_COUNT]
  const { order, subtreeEnd, parent, sphereW, bits, planes, rankOf } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const pb = cameraIndex * 24
  const treeN = views.gStart[0]
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  const state = groupSpheresOf(views)
  if (classWordRank.length < n) classWordRank = new Int32Array(n * 2)

  let sp = 0
  for (let r = 0; r < treeN; ) {
    const slot = order[r]
    const end = subtreeEnd[slot]
    if (parent[slot] < 0 && end > r) {
      sp = pushRange(r, end, 0x3f, sp)
      r = end
    } else {
      r++
    }
  }
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
    const enclosing = leaf || r > 0
    let outside = false
    let insideAll = true
    let interMask = 0
    let m = mask
    while (m !== 0) {
      const pbIdx = m & -m
      const i = 31 - Math.clz32(pbIdx)
      m ^= pbIdx
      const o = pb + i * 4
      const d = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3]
      if (d < -r) { outside = true; break }
      if (d < r) { interMask |= pbIdx; insideAll = false }
    }
    if (outside) {
      if (enclosing) {
        fillBits(bits, base, s, e, false)
        classWordRank.fill(CW_REJECT, s, e)
      } else {
        bits[base + (s >>> 5)] &= ~(1 << (s & 31))
        classWordRank[s] = mask << 8
        sp = splitChildrenOf(order, subtreeEnd, s, e, mask, sp)
      }
      continue
    }
    if (insideAll && enclosing) {
      fillBits(bits, base, s, e, true)
      classWordRank.fill(CW_ACCEPT, s, e)
      continue
    }
    bits[base + (s >>> 5)] |= 1 << (s & 31)
    const childMask = enclosing ? interMask : mask
    classWordRank[s] = childMask << 8
    if (!leaf) sp = splitChildrenOf(order, subtreeEnd, s, e, childMask, sp)
  }

  for (let g = 0; g < groupCount; g++) {
    const segFrom = views.gStart[g]
    const segTo = views.gStart[g + 1]
    if (segTo <= segFrom) continue
    const o4g = g * 4
    const gr = state.spheres[o4g + 3]
    let segMask = 0x3f
    if (gr > 0) {
      const gcx = state.spheres[o4g], gcy = state.spheres[o4g + 1], gcz = state.spheres[o4g + 2]
      let outside = false
      let insideAll = true
      let inter = 0
      for (let i = 0; i < 6; i++) {
        const o = pb + i * 4
        const d = planes[o] * gcx + planes[o + 1] * gcy + planes[o + 2] * gcz + planes[o + 3]
        if (d < -gr) { outside = true; break }
        if (d < gr) { inter |= 1 << i; insideAll = false }
      }
      if (outside) { fillBits(bits, base, segFrom, segTo, false); continue }
      if (insideAll) { fillBits(bits, base, segFrom, segTo, true); continue }
      segMask = inter
    }
    for (let r = segFrom; r < segTo; r++) {
      const slot = order[r]
      const w = base + (r >>> 5)
      const bit = 1 << (r & 31)
      const p = parent[slot]
      if (p >= 0) {
        const cw = classWordRank[rankOf[p]]
        const cls = cw & 0xff
        if (cls === CW_ACCEPT) { bits[w] |= bit; continue }
        if (cls === CW_REJECT) { bits[w] &= ~bit; continue }
        let vis = true
        let m = segMask & (cw >>> 8)
        const o4 = slot * 4
        while (m !== 0) {
          const pbIdx = m & -m
          const i = 31 - Math.clz32(pbIdx)
          m ^= pbIdx
          const o = pb + i * 4
          if (planes[o] * sphereW[o4] + planes[o + 1] * sphereW[o4 + 1] + planes[o + 2] * sphereW[o4 + 2] + planes[o + 3] < -sphereW[o4 + 3]) {
            vis = false
            break
          }
        }
        if (vis) bits[w] |= bit
        else bits[w] &= ~bit
      } else {
        let vis = true
        let m = segMask
        const o4 = slot * 4
        while (m !== 0) {
          const pbIdx = m & -m
          const i = 31 - Math.clz32(pbIdx)
          m ^= pbIdx
          const o = pb + i * 4
          if (planes[o] * sphereW[o4] + planes[o + 1] * sphereW[o4 + 1] + planes[o + 2] * sphereW[o4 + 2] + planes[o + 3] < -sphereW[o4 + 3]) {
            vis = false
            break
          }
        }
        if (vis) bits[w] |= bit
        else bits[w] &= ~bit
      }
    }
  }
}

const VARIANTS = { a: cullA, b2: cullB2, b1: cullB1, c: cullC }

// ── the ISOLATE mode (argv: --isolate <variant> <scene>) ───────────────────
// ── the PRODUCTION A/B (argv: --prod <on|off> <scene>) — the REAL
//    cullViewsHierarchical through the public API (the variants above are
//    faithful copies; this pins the INTEGRATED path end-to-end) ───────────
if (process.argv[2] === '--prod') {
  const mode = process.argv[3] === 'on'
  const sceneName = process.argv[4]
  const scene = sceneName === 'cluster' ? buildCluster(7)
    : sceneName === 'flat' ? buildFlat(7)
    : sceneName === 'swarms' ? buildSwarms(7)
    : buildMixed(7)
  const v = scene.views
  setCullTailSpheres(mode)
  setCullMemo(false)
  const cull = () => cullViewsHierarchical(v, 0, 0)
  writeCameraPlanes(v, 0, CAMS.band().planes)
  cull()
  const rows = []
  for (const [camName, make] of Object.entries(CAMS)) {
    writeCameraPlanes(v, 0, make().planes)
    cull()
    // inner=10: the cull is 0.01-3ms — a single scheduler preemption
    // (a 5ms timeslice) wrecks a 1ms sample; the inner loop amortizes it.
    rows.push(bench(`cull ${camName}`, cull, 24, 10))
  }
  const drone = () => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      writeCameraPlanes(v, 0, createCamera().setPerspective(1.0, 1200, [Math.cos(a) * 500, 120, Math.sin(a) * 500], 0, 0, 0, 0, 1, 0).planes)
      cullViewsHierarchical(v, 0, 0)
    }
  }
  drone()
  rows.push(bench('drone orbit ×8', drone, 6))
  console.log(JSON.stringify({ variant: mode ? 'prod-on' : 'prod-off', scene: sceneName, rows }))
  process.exit(0)
}

if (process.argv[2] === '--isolate') {
  const variant = VARIANTS[process.argv[3]]
  const sceneName = process.argv[4]
  const scene = sceneName === 'cluster' ? buildCluster(7)
    : sceneName === 'flat' ? buildFlat(7)
    : sceneName === 'swarms' ? buildSwarms(7)
    : buildMixed(7)
  const v = scene.views
  if (process.argv[3] === 'b1' || process.argv[3] === 'c') buildAllGroupSpheres(v) // warm the sphere cache
  const cam = CAMS.band()
  writeCameraPlanes(v, 0, cam.planes)
  const cull = () => variant(v, 0, 0)
  cull()
  const rows = []
  for (const [camName, make] of Object.entries(CAMS)) {
    const c = make()
    writeCameraPlanes(v, 0, c.planes)
    variant(v, 0, 0)
    rows.push(bench(`cull ${camName}`, cull, 12))
  }
  // the drone: 8 orbiting positions — fresh planes every frame
  const drone = () => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      const c = createCamera().setPerspective(1.0, 1200, [Math.cos(a) * 500, 120, Math.sin(a) * 500], 0, 0, 0, 0, 1, 0)
      writeCameraPlanes(v, 0, c.planes)
      variant(v, 0, 0)
    }
  }
  drone()
  rows.push(bench('drone orbit ×8', drone, 6))
  console.log(JSON.stringify({ variant: process.argv[3], scene: sceneName, rows }))
  process.exit(0)
}

// ── the parity gate (in-process; timing comes from the isolate children) ───
function snapshot(views, cameraIndex, bufferIndex) {
  const base = bitsBase(views, bufferIndex, cameraIndex)
  return new Uint32Array(views.bits.subarray(base, base + views.bitsWords))
}

console.log('TASK 193 — the tail-sweep theories (B1 group spheres / B2 parent-classify / C composite)')
console.log('Parity gate: every variant vs the production sweep AND vs brute, 3 scenes × 4 cameras.\n')

const SCENES = { cluster: buildCluster, flat: buildFlat, swarms: buildSwarms, mixed: buildMixed }
let parityFail = 0
for (const [sceneName, build] of Object.entries(SCENES)) {
  const scene = build(7)
  const v = scene.views
  buildAllGroupSpheres(v)
  const groupCount = Math.min(v.headerI[H_GROUP_COUNT], v.groupMax)
  const n = v.headerI[H_NODE_COUNT]
  const treeN = v.gStart[0]
  for (const [camName, make] of Object.entries(CAMS)) {
    const cam = make()
    writeCameraPlanes(v, 0, cam.planes)
    cullA(v, 0, 0)
    const ref = snapshot(v, 0, 0)
    const visible = popcountBits(ref, 0, v.bitsWords)
    // brute — the ground truth (the whole bitset, tree + tail alike)
    cullViewsBrute(v, 0, 1)
    const brute = snapshot(v, 0, 1)
    let bruteEq = true
    for (let i = 0; i < v.bitsWords; i++) if (ref[i] !== brute[i]) { bruteEq = false; break }
    const line = [`${sceneName}/${camName}: n=${n} tree=${treeN} tail=${n - treeN} groups=${groupCount} vis=${visible} (${(visible * 100 / n).toFixed(1)}%)`]
    for (const name of ['b2', 'b1', 'c']) {
      VARIANTS[name](v, 0, 0)
      const snap = snapshot(v, 0, 0)
      let eq = true
      for (let i = 0; i < v.bitsWords; i++) if (snap[i] !== ref[i]) { eq = false; break }
      if (!eq) parityFail++
      line.push(`${name}=${eq ? 'OK' : 'MISMATCH'}`)
    }
    if (!bruteEq) parityFail++
    line.push(`brute=${bruteEq ? 'OK' : 'MISMATCH'}`)
    console.log('  ' + line.join('  '))
  }
}

if (parityFail > 0) {
  console.log(`\nPARITY FAILED (${parityFail}) — a broken variant does not get to be measured.`)
  process.exit(1)
}
console.log('\nParity: ALL BIT-IDENTICAL (variants == production sweep == brute).')

// ── the isolated timing (child processes; the Task-192 lesson) ─────────────
console.log('\nIsolated kernels (one child process per variant × scene; medians):')
const { execSync } = await import('node:child_process')
const results = []
for (const sceneName of ['cluster', 'flat', 'swarms', 'mixed']) {
  console.log(`\n  scene: ${sceneName}`)
  for (const variant of ['a', 'b2', 'b1', 'c']) {
    const out = execSync(`bun "${import.meta.path}" --isolate ${variant} ${sceneName}`, { encoding: 'utf8' })
    const parsed = JSON.parse(out.trim().slice(out.indexOf('{')))
    results.push(parsed)
    for (const row of parsed.rows) console.log(`   [${variant}] ${row.name.padEnd(42)} ${row.med.toFixed(4)}ms  min ${row.min.toFixed(4)}ms`)
  }
}

// ── the production A/B (the integrated path; separate child processes) ─────
console.log('\nPRODUCTION A/B (the real cullViewsHierarchical, kill-switch off/on):')
const prodResults = []
for (const sceneName of ['cluster', 'flat', 'swarms', 'mixed']) {
  for (const mode of ['off', 'on']) {
    const out = execSync(`bun "${import.meta.path}" --prod ${mode} ${sceneName}`, { encoding: 'utf8' })
    const parsed = JSON.parse(out.trim().slice(out.indexOf('{')))
    prodResults.push(parsed)
  }
  for (const camName of ['band', 'all', 'out', 'edge', 'drone orbit ×8']) {
    const off = prodResults.find(r => r.scene === sceneName && r.variant === 'prod-off')?.rows.find(row => row.name === `cull ${camName}`)
    const on = prodResults.find(r => r.scene === sceneName && r.variant === 'prod-on')?.rows.find(row => row.name === `cull ${camName}`)
    if (off === undefined || on === undefined) continue
    // MEDIAN of inner=10 samples (a single preemption can no longer wreck
    // a sample); the min stays printed for the tier steady state.
    const pct = ((on.med - off.med) / off.med) * 100
    console.log(`  ${sceneName}/${camName}: ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`)
  }
}

// ── the honest verdict ─────────────────────────────────────────────────────
// NOTE on the production A/B above: at 0.4–3ms kernel scale this container's
// process-level luck (CPU contention, the FTL tier lottery, the ON→OFF
// branch polymorphism if modes ever interleave in ONE process) swings the
// medians ±2× on IDENTICAL code — treat the cross-process table as a SMOKE
// signal, not the truth. The kernel-level truths (scripts/task193-diag.mjs,
// same process, same tier, repeated):
//   • the segment restructure is FREE (per-group loops ≈ one big loop);
//   • the 6-guard narrowed sweep is −21..−35% vs the legacy 6-plane loop;
//   • the wholesale classifications are −78..−97% (stable in every run);
//   • the B2 parent-classify twin: REJECTED (the archive below).

console.log('\nDeltas vs A (the production sweep; per scene × camera):')
for (const sceneName of ['cluster', 'flat', 'swarms', 'mixed']) {
  for (const camName of ['band', 'all', 'out', 'edge', 'drone orbit ×8']) {
    const a = results.find(r => r.scene === sceneName && r.variant === 'a')?.rows.find(row => row.name === `cull ${camName}`)
    if (a === undefined) continue
    const parts = []
    for (const variant of ['b2', 'b1', 'c']) {
      const v = results.find(r => r.scene === sceneName && r.variant === variant)?.rows.find(row => row.name === `cull ${camName}`)
      if (v === undefined) continue
      const pct = ((v.med - a.med) / a.med) * 100
      parts.push(`${variant} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`)
    }
    console.log(`  ${sceneName}/${camName}: ${parts.join('   ')}`)
  }
}
console.log('\nTASK 193 TAILSWEEP: DONE')
