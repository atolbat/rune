/**
 * zeroAlloc.test.ts — Task 87: a hot frame without allocations + A/B modes.
 *
 * We verify the BEHAVIOR of the new allocation-free paths (parity with the old ones):
 *   • scene.cull({ out }) — reusable stats records = the same numbers;
 *   • masks=false — the bitset is BITWISE-equal to brute (A/B "before Task 85",
 *     only more expensive: planeTests not lower);
 *   • scene.updateWorld(true) — forced recomputation = a byte-for-byte identical
 *     world to the dirty one (parity);
 *   • instanceCountOf/instanceOffsetOf/instancePoolBase — numbers consistent
 *     with instanceMatricesView (the same pool segment);
 *   • scene.cull({ masks: false }) and hierarchical by default — identical
 *     bitsets (masks do not change the result).
 */
import { describe, expect, it } from 'bun:test'
import {
  bitsBase,
  createCamera,
  createScene,
  instanceMatricesView,
  instancePoolBase,
} from '../src/index.ts'
import type { MutableCullStats } from '../src/index.ts'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildTree(seed: number, targetNodes: number) {
  const rnd = mulberry32(seed)
  const scene = createScene({ capacity: targetNodes + 16, groupMax: 8, shared: false })
  const parents: number[] = []
  let created = 0
  while (created < targetNodes) {
    const parent = parents.length > 0 && rnd() < 0.75 ? parents[Math.floor(rnd() * parents.length)]! : -1
    const slot = scene.create({
      parent,
      position: [(rnd() - 0.5) * 40, (rnd() - 0.5) * 20, (rnd() - 0.5) * 40],
      rotation: [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, 1],
      scale: [0.5 + rnd(), 0.5 + rnd(), 0.5 + rnd()],
      group: rnd() < 0.6 ? Math.floor(rnd() * 4) : -1,
      sphere: rnd() < 0.5 ? [0, 0, 0, rnd() * 3] : undefined,
    })
    parents.push(slot)
    created++
  }
  return scene
}

describe('Task 87: cull with out records (zero allocations)', () => {
  it('out stats = fresh objects (same numbers, reuse)', () => {
    const scene = buildTree(7, 400)
    const cam = createCamera()
    cam.setPerspective(1.2, 1.5, 0.5, 300)
    cam.setViewLookAt(30, 25, 30, 0, 0, 0, 0, 1, 0)
    scene.updateWorld()
    scene.refitGroupBounds()

    const out: MutableCullStats[] = [
      { tested: -1, visible: -1, trivialRejects: -1, trivialAccepts: -1, planeTests: -1 },
    ]
    const res = scene.cull([cam], { bufferIndex: 0, out })
    // the out record is filled and matches the allocated copy
    expect(out[0]!.tested).toBe(res.stats[0]!.tested)
    expect(out[0]!.visible).toBe(res.stats[0]!.visible)
    expect(out[0]!.trivialRejects).toBe(res.stats[0]!.trivialRejects)
    expect(out[0]!.trivialAccepts).toBe(res.stats[0]!.trivialAccepts)
    expect(out[0]!.planeTests).toBe(res.stats[0]!.planeTests)
    expect(out[0]!.visible).toBeGreaterThan(0)
    // the second frame overwrites the same record
    const res2 = scene.cull([cam], { bufferIndex: 1, out })
    expect(out[0]!.tested).toBe(res2.stats[0]!.tested)
  })
})

describe('Task 87: masks=false — A/B "before Task 85" (same bitset, more expensive)', () => {
  it('bitsets bitwise equal; planeTests not lower (masks — pure savings)', () => {
    // Scene contract: a user sphere of an internal node = SUBTREE
    // bounds (culling.ts); hence the reference for mask A/B is the hierarchical
    // check itself with masks, not brute (comparison with brute on arbitrary
    // user spheres — a separate test in optimizations.test.ts).
    const scene = buildTree(11, 500)
    const cam = createCamera()
    cam.setPerspective(1.0, 1.7, 0.5, 300)
    cam.setViewLookAt(-35, 20, -25, 5, 0, 5, 0, 1, 0)
    scene.updateWorld()
    scene.refitGroupBounds()

    const withMasks = scene.cull([cam], { bufferIndex: 0, masks: true })
    const withoutMasks = scene.cull([cam], { bufferIndex: 1, masks: false })

    const words = scene.views.bitsWords
    const b0 = bitsBase(scene.views, 0, 0)
    const b1 = bitsBase(scene.views, 1, 0)
    for (let w = 0; w < words; w++) {
      expect(scene.views.bits[b1 + w]).toBe(scene.views.bits[b0 + w]) // A/B does not change the result
    }
    expect(withoutMasks.stats[0]!.visible).toBe(withMasks.stats[0]!.visible)
    expect(withoutMasks.stats[0]!.trivialRejects).toBe(withMasks.stats[0]!.trivialRejects)
    expect(withoutMasks.stats[0]!.trivialAccepts).toBe(withMasks.stats[0]!.trivialAccepts)
    // masks really save "sphere×plane" tests
    expect(withMasks.stats[0]!.planeTests).toBeLessThan(withoutMasks.stats[0]!.planeTests)
  })
})

describe('Task 87: updateWorld(force) — parity with the dirty one', () => {
  it('forced recomputation gives a byte-for-byte identical world', () => {
    const scene = buildTree(23, 300)
    const cam = createCamera()
    cam.setPerspective(1.0, 1.5, 0.5, 300)
    cam.setViewLookAt(10, 15, 10, 0, 0, 0, 0, 1, 0)
    scene.updateWorld()
    scene.refitGroupBounds()
    // dirty frame after a local edit
    const slot = 5
    scene.setLocalTR(slot, 1, 2, 3, 0, 0.6, 0, 0.8, 1, 1, 1)
    const dirty = scene.updateWorld(false)
    const worldDirty = scene.views.world.slice()
    // forced frame: ALL recomputed, the world is the same
    const forced = scene.updateWorld(true)
    expect(forced).toBe(scene.count)
    expect(dirty).toBeLessThan(scene.count)
    const worldForced = scene.views.world
    for (let i = 0; i < worldForced.length; i++) {
      expect(worldForced[i]).toBe(worldDirty[i])
    }
  })
})

describe('Task 87: numeric instance accesses (without subarray)', () => {
  it('countOf/offsetOf/poolBase are consistent with instanceMatricesView', () => {
    const scene = buildTree(31, 400)
    const cam = createCamera()
    cam.setPerspective(1.0, 1.4, 0.5, 300)
    cam.setViewLookAt(20, 18, 20, 0, 0, 0, 0, 1, 0)
    scene.updateWorld()
    scene.refitGroupBounds()
    scene.cull([cam], { bufferIndex: 0 })
    scene.collectInstances(0, { bufferIndex: 0 })

    const g = 1
    const count = scene.instanceCountOf(g, 0, 0)
    const offset = scene.instanceOffsetOf(g, 0, 0)
    const base = scene.instancePoolBase(0, 0)
    const seg = instanceMatricesView(scene.views, 0, 0, g)
    expect(seg.count).toBe(count)
    if (count > 0) {
      // first element of the segment = pool[base + offset*16]
      const pool = scene.views.instPool
      expect(seg.matrices[0]).toBe(pool[base + offset * 16]!)
      expect(seg.matrices[count * 16 - 1]).toBe(pool[base + (offset + count) * 16 - 1]!)
    }
    // the base depends on the camera (per-camera pools do not overlap)
    const base1 = scene.instancePoolBase(1, 0)
    expect(base1).not.toBe(base)
  })
})

describe('Task 113: cull reuse — the scene-owned result', () => {
  it('numbers equal the default mode; the wrapper is stable; stats.length follows cameraCount', () => {
    const scene = buildTree(37, 300)
    const camA = createCamera()
    camA.setPerspective(1.1, 1.5, 0.5, 300)
    camA.setViewLookAt(25, 20, 25, 0, 0, 0, 0, 1, 0)
    const camB = createCamera()
    camB.setPerspective(0.9, 1.6, 0.5, 300)
    camB.setViewLookAt(-25, 20, -25, 0, 0, 0, 0, 1, 0)
    scene.updateWorld()
    scene.refitGroupBounds()

    // Reference numbers from the default (independent) mode.
    const ref1 = scene.cull([camA], { bufferIndex: 0 })
    const ref2 = scene.cull([camA, camB], { bufferIndex: 1 })
    const held = { ...ref2.stats[1]! } // survives the reuse calls below

    const r1 = scene.cull([camA], { bufferIndex: 0, reuse: true })
    expect(r1.cameraCount).toBe(1)
    expect(r1.stats.length).toBe(1)
    expect(r1.stats[0]!.tested).toBe(ref1.stats[0]!.tested)
    expect(r1.stats[0]!.visible).toBe(ref1.stats[0]!.visible)
    expect(r1.stats[0]!.planeTests).toBe(ref1.stats[0]!.planeTests)

    const r2 = scene.cull([camA, camB], { bufferIndex: 1, reuse: true })
    expect(r2.cameraCount).toBe(2)
    expect(r2.stats.length).toBe(2)
    expect(r2.stats[1]!.tested).toBe(held.tested)
    expect(r2.stats[1]!.visible).toBe(held.visible)
    expect(r2.bufferIndex).toBe(1)

    // The contract: ONE wrapper — r1 is invalidated by the r2 call.
    expect(r2).toBe(r1)
    // stats.length shrinks back without re-allocating (the record is retained).
    const r3 = scene.cull([camA], { reuse: true })
    expect(r3.stats.length).toBe(1)
    expect(r3.stats[0]).toBe(r2.stats[0])

    // out still wins over reuse (the caller owns the records).
    const out: MutableCullStats[] = [
      { tested: -1, visible: -1, trivialRejects: -1, trivialAccepts: -1, planeTests: -1 },
    ]
    const ro = scene.cull([camA], { reuse: true, out })
    expect(out[0]!.tested).toBe(ref1.stats[0]!.tested)
    expect(ro.stats[0]).toBe(out[0])
    expect(ro).not.toBe(r3)
  })
})
