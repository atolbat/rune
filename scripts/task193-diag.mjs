/** task193-diag.mjs — bisect the cluster +59%: which part of the ON path pays?
 * V0 = production OFF (the legacy sweep) · V1 = the segment restructure with
 * NO sphere classification (per-group loops only) · V2 = the full ON path. */
import {
  createScene, createCamera, writeCameraPlanes, cullViewsHierarchical, setCullMemo, setCullTailSpheres,
} from '../packages/scene/src/index.ts'
import { bitsBase, fillBits } from '../packages/scene/src/culling.ts'
import { H_NODE_COUNT, H_GROUP_COUNT } from '../packages/scene/src/layout.ts'

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
const N = 100_000
function buildCluster(seed, groups = 100) {
  const rnd = mulberry32(seed)
  const scene = createScene({ capacity: N + 64, groupMax: groups, cameraMax: 4, maxInstances: N })
  const CL = 10_000
  const cols = 100
  for (let c = 0; c < CL; c++) {
    const gx = (c % cols) * 60 - (cols * 60) / 2
    const gz = ((c / cols) | 0) * 60 - (CL / cols / 2) * 60
    const root = scene.create({ position: [gx, 0, gz], sphere: [0, 0, 0, -1] })
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

const scene = buildFlat(7)
const v = scene.views
setCullMemo(false)
const cam = createCamera().setPerspective(1.0, 1200, [0, 120, 500], 0, 0, 0, 0, 1, 0)
writeCameraPlanes(v, 0, cam.planes)

// V0: production OFF
setCullTailSpheres(false)
cullViewsHierarchical(v, 0, 0)

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

// the manual variants
const n = v.headerI[H_NODE_COUNT]
const groupCount = Math.min(v.headerI[H_GROUP_COUNT], v.groupMax)
const treeN = v.gStart[0]
const { order, sphereW, bits, planes } = v
const base = bitsBase(v, 0, 0)
const pb = 0

function sweepLegacy() {
  for (let r = treeN; r < n; r++) {
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
// V1: the per-GROUP loop restructure, no classification (just the segment iteration)
function sweepGrouped() {
  for (let g = 0; g < groupCount; g++) {
    const segFrom = v.gStart[g]
    const segTo = v.gStart[g + 1]
    if (segTo <= segFrom) continue
    for (let r = segFrom; r < segTo; r++) {
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
}

function bench(name, fn, iters = 20) {
  for (let i = 0; i < 12; i++) fn()
  const samples = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  console.log(`  ${name.padEnd(36)} med ${samples[samples.length >> 1].toFixed(4)}ms  min ${samples[0].toFixed(4)}ms`)
}
const bitsCopy = new Uint32Array(bits.subarray(base, base + v.bitsWords))
sweepLegacy()
bitsCopy.set(bits.subarray(base, base + v.bitsWords))
sweepGrouped()
let same = true
for (let i = 0; i < v.bitsWords; i++) if (bits[base + i] !== bitsCopy[i]) { same = false; break }
console.log(`parity V0/V1: ${same ? 'OK' : 'MISMATCH'}`)
// the 6-guard straight-line form (manual unroll, no inner loop)
function sweepGuards() {
  for (let g = 0; g < groupCount; g++) {
    const segFrom = v.gStart[g]
    const segTo = v.gStart[g + 1]
    if (segTo <= segFrom) continue
    // a narrowed mask: 3 of 6 planes (the flat/edge shape)
    const m = 0b001101
    const t0 = (m & 1) !== 0, t1 = (m & 2) !== 0, t2 = (m & 4) !== 0
    const t3 = (m & 8) !== 0, t4 = (m & 16) !== 0, t5 = (m & 32) !== 0
    for (let r = segFrom; r < segTo; r++) {
      const o4 = order[r] * 4
      const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2]
      const rad = sphereW[o4 + 3]
      let vis = true
      if (t0 && planes[pb] * cx + planes[pb + 1] * cy + planes[pb + 2] * cz + planes[pb + 3] < -rad) vis = false
      if (vis && t1 && planes[pb + 4] * cx + planes[pb + 5] * cy + planes[pb + 6] * cz + planes[pb + 7] < -rad) vis = false
      if (vis && t2 && planes[pb + 8] * cx + planes[pb + 9] * cy + planes[pb + 10] * cz + planes[pb + 11] < -rad) vis = false
      if (vis && t3 && planes[pb + 12] * cx + planes[pb + 13] * cy + planes[pb + 14] * cz + planes[pb + 15] < -rad) vis = false
      if (vis && t4 && planes[pb + 16] * cx + planes[pb + 17] * cy + planes[pb + 18] * cz + planes[pb + 19] < -rad) vis = false
      if (vis && t5 && planes[pb + 20] * cx + planes[pb + 21] * cy + planes[pb + 22] * cz + planes[pb + 23] < -rad) vis = false
      const w = base + (r >>> 5)
      const bit = 1 << (r & 31)
      if (vis) bits[w] |= bit
      else bits[w] &= ~bit
    }
  }
}
bench('V1 per-group loops (no classify)', sweepGrouped)
bench('V0 one big loop (legacy)', sweepLegacy)
bench('G 6-guard straight-line (mask 3/6)', sweepGuards)
bench('V0 one big loop (legacy, again)', sweepLegacy)
bench('G 6-guard straight-line (again)', sweepGuards)

// V2: full production ON (cullViewsHierarchical drives it)
setCullTailSpheres(true)
bench('V2 production ON (classify)', () => cullViewsHierarchical(v, 0, 0))
setCullTailSpheres(false)
bench('V0 production OFF', () => cullViewsHierarchical(v, 0, 0))
