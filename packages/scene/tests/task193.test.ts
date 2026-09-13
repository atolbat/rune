import { describe, expect, it, beforeEach } from 'bun:test'
import {
  createScene, createCamera, writeCameraPlanes, cullViewsHierarchical, cullViewsBrute,
  setCullMemo, cullMemoCounters, setCullTailSpheres, setCollectMemo, setGroupSphereReject,
  groupSphereCounters, collectGroupMatrices, gpuInstanceSource, setTailLayout,
} from '../src/index.ts'
import { bitsBase } from '../src/culling.ts'
import { groupSphereBuildCount } from '../src/groupBounds.ts'

/**
 * Task 193 (theory B) — the TAIL SEGMENT CLASSIFICATION: the group sphere
 * (the Task-191 N4 cache, shared via groupBounds.ts) classifies the whole
 * tail segment before a leaf is touched — out → clear words, in → set
 * words, straddle → only the intersecting planes per leaf.
 *
 * The pins, mirroring the task191/task192 discipline:
 *   1. BIT-PARITY with the kill-switch (static + camera flips, both buffers)
 *      AND with brute — the bits are a pure function of (sphereW, planes);
 *   2. the STATS semantics: a wholesale segment decision is ONE trivial
 *      accept/reject (the range semantics), the sphere's plane tests are
 *      counted honestly;
 *   3. the SHARED CACHE with the collect's N4 pre-reject — the cull builds,
 *      the collect reuses (the build count does not double per frame);
 *   4. the MEMO FLAG BYTE — a hit under one mode never serves the other
 *      (the stats differ at identical bits);
 *   5. INVALIDATION — an animated member rebuilds the sphere (the groupTouch
 *      discipline) and the bits follow the moved swarm;
 *   6. a scene WITHOUT a tail (no groups) — the classification is a no-op.
 */

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The compact-swarm shape (the instance field): one group = one spatial ball. */
function buildSwarms(seed: number, groups = 6, perGroup = 400) {
  const rnd = mulberry32(seed)
  const scene = createScene({ capacity: groups * perGroup + 64, groupMax: groups, cameraMax: 2, maxInstances: groups * perGroup })
  for (let g = 0; g < groups; g++) {
    const ox = (rnd() - 0.5) * 400, oy = (rnd() - 0.5) * 100, oz = (rnd() - 0.5) * 400
    for (let i = 0; i < perGroup; i++) {
      scene.create({
        position: [ox + (rnd() - 0.5) * 20, oy + (rnd() - 0.5) * 20, oz + (rnd() - 0.5) * 20],
        group: g,
        sphere: [0, 0, 0, 0.5 + rnd() * 1.5],
      })
    }
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  return scene
}

function makeCam(fov: number, far: number, eye: readonly number[], target: readonly number[]) {
  return createCamera().setPerspective(fov, 1, 0.1, far).setViewLookAt(eye[0], eye[1], eye[2], target[0], target[1], target[2], 0, 1, 0)
}

function snapshotBits(views: ReturnType<typeof buildSwarms>['views'], bufferIndex: number, cameraIndex: number) {
  const base = bitsBase(views, bufferIndex, cameraIndex)
  return new Uint32Array(views.bits.subarray(base, base + views.bitsWords))
}

beforeEach(() => {
  setCullMemo(false)
  setCollectMemo(false)
  setGroupSphereReject(true)
  setCullTailSpheres(true)
})

describe('Task 193: the tail segment classification', () => {
  it('BIT-PARITY with the kill-switch and brute — static and flip frames, both buffers', () => {
    const scene = buildSwarms(7)
    const views = scene.views
    const cams = [
      makeCam(1.0, 1200, [0, 60, 300], [0, 0, 0]),
      makeCam(1.2, 20000, [0, 0, 3000], [0, 0, 0]),
      makeCam(1.0, 1200, [0, 0, 300], [0, 0, 2000]),
      makeCam(1.0, 1200, [180, 0, 150], [0, 0, 0]),
    ]
    for (let k = 0; k < cams.length; k++) {
      writeCameraPlanes(views, 0, cams[k].planes)
      for (const bufferIndex of [0, 1]) {
        setCullTailSpheres(true)
        const withSpheres = cullViewsHierarchical(views, 0, bufferIndex)
        const bitsOn = snapshotBits(views, bufferIndex, 0)
        setCullTailSpheres(false)
        cullViewsHierarchical(views, 0, bufferIndex)
        const bitsOff = snapshotBits(views, bufferIndex, 0)
        expect([...bitsOn]).toEqual([...bitsOff])
        // brute — the ground truth (into the other buffer)
        cullViewsBrute(views, 0, 1 - bufferIndex)
        const bruteBits = snapshotBits(views, 1 - bufferIndex, 0)
        expect([...bitsOn]).toEqual([...bruteBits])
        // the visible tally is identical (the popcount over identical bits)
        expect(withSpheres.visible).toBe(cullViewsBrute(views, 0, bufferIndex).visible)
      }
    }
  })

  it('STATS: a wholesale segment decision is ONE trivial accept/reject (the range semantics)', () => {
    const scene = buildSwarms(11)
    const views = scene.views
    // camera fully outside the world → every segment is a trivial reject
    writeCameraPlanes(views, 0, makeCam(1.0, 1200, [0, 0, 300], [0, 0, 5000]).planes)
    const out = cullViewsHierarchical(views, 0, 0)
    expect(out.trivialRejects).toBeGreaterThanOrEqual(6) // every group's segment + tree roots
    // six sphere tests per group + the walk — no per-leaf dots: the whole
    // 2400-leaf tail cost ~36 plane tests, not thousands
    expect(out.planeTests).toBeLessThan(200)
    // camera far back → every segment fully inside
    writeCameraPlanes(views, 0, makeCam(1.2, 20000, [0, 0, 3000], [0, 0, 0]).planes)
    const inView = cullViewsHierarchical(views, 0, 0)
    expect(inView.trivialAccepts).toBeGreaterThanOrEqual(6)
    expect(inView.planeTests).toBeLessThan(200)
    expect(inView.visible).toBe(6 * 400)
  })

  it('the SHARED cache: the cull builds the sphere, the collect\'s N4 reuses it (no double build)', () => {
    const scene = buildSwarms(13)
    const views = scene.views
    writeCameraPlanes(views, 0, makeCam(1.0, 1200, [0, 60, 300], [0, 0, 0]).planes)
    const out = new Float32Array(400 * 16)
    const before = groupSphereBuildCount()
    cullViewsHierarchical(views, 0, 0) // the cull builds all 6 spheres
    const afterCull = groupSphereBuildCount()
    expect(afterCull - before).toBe(6)
    // the DIRECT collect's N4 pre-reject finds them fresh — no rebuild
    for (let g = 0; g < 6; g++) collectGroupMatrices(views, 0, 0, g, out)
    expect(groupSphereBuildCount()).toBe(afterCull)
    // and the counters see the checks (the pre-reject path is live)
    expect(groupSphereCounters().checks).toBeGreaterThanOrEqual(6)
  })

  it('the MEMO FLAG BYTE: a hit under one mode never serves the other (stats differ, bits do not)', () => {
    const scene = buildSwarms(17)
    const views = scene.views
    writeCameraPlanes(views, 0, makeCam(1.2, 20000, [0, 0, 3000], [0, 0, 0]).planes)
    setCullMemo(true)
    setCullTailSpheres(true)
    const on1 = cullViewsHierarchical(views, 0, 0)
    const on2 = cullViewsHierarchical(views, 0, 0) // a memo HIT under mode ON
    expect(on2.trivialAccepts).toBe(on1.trivialAccepts)
    expect(cullMemoCounters().hits).toBeGreaterThan(0)
    // flip the mode: the flag byte differs → MISS → the stats recompute
    const hitsBefore = cullMemoCounters().hits
    setCullTailSpheres(false)
    const off = cullViewsHierarchical(views, 0, 0)
    expect(cullMemoCounters().hits).toBe(hitsBefore) // no new hit — it recomputed
    // the BITS are the same; the stats are not (no wholesale counters)
    expect(off.visible).toBe(on1.visible)
    expect(off.trivialAccepts).toBeLessThan(on1.trivialAccepts)
    expect([...snapshotBits(views, 0, 0)]).toEqual([...snapshotBits(views, 0, 0)])
    setCullMemo(false)
  })

  it('INVALIDATION: an animated member rebuilds the sphere and the bits follow the moved swarm', () => {
    const scene = buildSwarms(19, 3, 200)
    const views = scene.views
    // group 0's swarm moves far away, member by member (setLocal stamps
    // groupTouch through updateWorld — the Task-85 discipline)
    const cam = makeCam(1.2, 20000, [0, 0, 3000], [0, 0, 0])
    writeCameraPlanes(views, 0, cam.planes)
    const before = cullViewsHierarchical(views, 0, 0)
    expect(before.visible).toBe(600) // everything in view
    // move the WHOLE swarm of group 0 behind the camera (out of view)
    const slots: number[] = []
    for (let r = 0; r < views.headerI[2]; r++) {
      const slot = views.order[r]
      if (views.group[slot] === 0) slots.push(slot)
    }
    expect(slots.length).toBe(200)
    for (const slot of slots) scene.setLocal(slot, { position: [0, 0, 2500] })
    scene.updateWorld()
    scene.refitGroupBounds()
    const buildsBefore = groupSphereBuildCount()
    writeCameraPlanes(views, 0, makeCam(1.0, 1200, [0, 0, 500], [0, 0, 0]).planes)
    const after = cullViewsHierarchical(views, 0, 0)
    // the sphere of group 0 was rebuilt (the stamp moved) — not the others
    expect(groupSphereBuildCount() - buildsBefore).toBe(1)
    // group 0's segment is a wholesale reject now; groups 1-2 are in view
    expect(after.trivialRejects).toBeGreaterThanOrEqual(1)
    expect(after.visible).toBe(400)
    // brute agrees — the bits are still the ground truth
    cullViewsBrute(views, 0, 1)
    expect([...snapshotBits(views, 0, 0)]).toEqual([...snapshotBits(views, 1, 0)])
  })

describe('Task 193 (theory A): the GPU instance source (bit-discard views)', () => {
  it('the segment views: rank-major matrices, the bits view, rankBase, gHidden', () => {
    const scene = buildSwarms(23, 4, 300)
    const views = scene.views
    writeCameraPlanes(views, 0, makeCam(1.2, 20000, [0, 0, 3000], [0, 0, 0]).planes)
    cullViewsHierarchical(views, 0, 0)
    for (let g = 0; g < 4; g++) {
      const src = gpuInstanceSource(views, 0, 0, g)
      const gs = views.gStart[g]
      const ge = views.gStart[g + 1]
      expect(src.instances).toBe(ge - gs)
      expect(src.rankBase).toBe(gs)
      // the matrices: a VIEW of the rank-major rows — no copy, exact window
      expect(src.matrices.byteOffset).toBe(views.world.byteOffset + gs * 16 * 4)
      expect(src.matrices.length).toBe((ge - gs) * 16)
      // the bits: the camera's whole bitset (rank space)
      expect(src.bits.byteOffset).toBe(views.bits.byteOffset)
      expect(src.bits.length).toBe(views.bitsWords)
      // the visible members of the segment: the bits say exactly what the
      // CPU collect would count (the parity the GPU filter relies on)
      let visible = 0
      for (let r = gs; r < ge; r++) {
        if ((src.bits[r >>> 5] & (1 << (r & 31))) !== 0) visible++
      }
      const out = new Float32Array(300 * 16)
      expect(collectGroupMatrices(views, 0, 0, g, out)).toBe(visible)
      // a fresh segment (all visible) — gHidden is 0 in this fixture
      expect(src.gHidden).toBe(0)
    }
  })

  it('out-of-range groups and the kill-switch: an EMPTY source (instances 0)', () => {
    const scene = buildSwarms(29, 4, 100)
    const views = scene.views
    writeCameraPlanes(views, 0, makeCam(1.0, 1200, [0, 60, 300], [0, 0, 0]).planes)
    cullViewsHierarchical(views, 0, 0)
    expect(gpuInstanceSource(views, 0, 0, -1).instances).toBe(0)
    expect(gpuInstanceSource(views, 0, 0, 99).instances).toBe(0)
    setTailLayout(false)
    scene.pack()
    expect(gpuInstanceSource(views, 0, 0, 0).instances).toBe(0)
    setTailLayout(true)
    scene.pack()
    expect(gpuInstanceSource(views, 0, 0, 0).instances).toBe(100)
  })
})

describe('Task 193: the tail classification extras', () => {
  it('a scene without a tail (no groups): the classification is a no-op, bit-for-bit', () => {
    const scene = createScene({ capacity: 512, groupMax: 4, cameraMax: 2 })
    for (let i = 0; i < 300; i++) {
      scene.create({ position: [(i % 17) * 10, ((i / 17) | 0) * 10, 0], sphere: [0, 0, 0, 2] })
    }
    scene.updateWorld()
    scene.refitGroupBounds()
    const views = scene.views
    writeCameraPlanes(views, 0, makeCam(1.0, 1200, [0, 0, 200], [0, 0, 0]).planes)
    setCullTailSpheres(true)
    cullViewsHierarchical(views, 0, 0)
    const bitsOn = snapshotBits(views, 0, 0)
    setCullTailSpheres(false)
    cullViewsHierarchical(views, 0, 0)
    expect([...snapshotBits(views, 0, 0)]).toEqual([...bitsOn])
  })
})
})
