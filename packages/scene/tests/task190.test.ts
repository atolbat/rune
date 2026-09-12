/**
 * task190.test.ts — the frame MEMOES in production (Task 189's N3a+N5):
 * the cull memo (culling.ts) and the pool memo (instances.ts).
 *
 * The pinned invariants:
 *   • PARITY: a memoized sequence returns bit-identical bits, counts,
 *     offsets, pool bytes and stats to the kill-switch sequence (twins);
 *   • INVALIDATION: every stamp family (setLocal / setVisible / pack /
 *     planes / refit-writes) forces a MISS — asserted through the memo
 *     counters, not just through values (a served-stale path is caught by
 *     the miss that did not happen);
 *   • the off-pattern cull→refit→cull hole, closed by the refit clock bump;
 *   • SCENE ISOLATION: the memo state is keyed per views object — two
 *     identical scenes at equal clocks and epochs never validate each
 *     other (the WeakMap; the lesson the isolated one-scene probes could
 *     not teach — a shared module-level memo would leave the second scene's
 *     bitset at zero while reporting the first scene's stats);
 *   • the static pipeline: an unchanged runScenePipeline frame skips both
 *     cull and collect;
 *   • the kill-switch restores the pre-190 behavior exactly.
 *
 * Buffer rhythm note (Task 182's lesson, alive here): the flip-diff inside
 * collectInstancesViews compares the CURRENT buffer against its sibling —
 * against a never-written sibling every set bit reads as a flip. The warmup
 * below always culls+collects BOTH buffers before asserting hits.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import {
  bitsBase,
  collectInstancesViews,
  collectMemoCounters,
  createCamera,
  createScene,
  cullMemoCounters,
  cullViewsBrute,
  cullViewsHierarchical,
  H_CAMERA_COUNT,
  H_DROPPED_INSTANCES,
  instancePoolBase,
  runScenePipeline,
  setCullMemo,
  setCollectMemo,
  writeCameraPlanes,
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

/** The twins' shared builder — the Task-189 S7 canon, smaller. */
function buildMemoScene(seed: number, nodes: number): ReturnType<typeof createScene> {
  const rng = mulberry32(seed)
  const scene = createScene({ capacity: nodes + 8, cameraMax: 1, groupMax: 8, maxInstances: nodes })
  for (let i = 0; i < nodes; i++) {
    scene.create({
      position: [(i % 20) * 6 - 60, ((i / 20) | 0) * 6 - 60, ((i / 400) | 0) * 8],
      sphere: [0, 0, 0, 2],
      group: i % 8,
    })
    if (rng() > 0.9) scene.setVisible(i, false)
  }
  scene.updateWorld()
  return scene
}

function cameraFor(z = 220) {
  return createCamera().setPerspective(1.0, 1, 0.1, 900).setViewLookAt(0, 0, z, 0, 0, 0, 0, 1, 0)
}

afterEach(() => {
  setCullMemo(true)
  setCollectMemo(true)
})

describe('Task 190: the frame memoes — parity with the kill-switch twins', () => {
  it('a 30 static + 30 flipping sequence is bit-identical (bits/counts/offsets/pool/return)', () => {
    const sceneA = buildMemoScene(42, 600) // A: memoes OFF (the reference)
    const sceneB = buildMemoScene(42, 600) // B: memoes ON
    const viewsA = sceneA.views
    const viewsB = sceneB.views
    const cam = cameraFor()
    const flipMembers: number[] = []
    for (let r = 0; r < 600; r++) {
      const s = viewsA.order[r]!
      if (viewsA.group[s] === 3) flipMembers.push(s)
    }
    setCollectMemo(false)
    setCullMemo(false)

    for (let f = 0; f < 60; f++) {
      const b = f & 1
      if (f >= 30 && (f & 2) === 0) {
        const vis = f % 4 === 0
        for (const s of flipMembers) {
          sceneA.setVisible(s, vis)
          sceneB.setVisible(s, vis)
        }
        sceneA.updateWorld()
        sceneB.updateWorld()
      }
      // Both twins run the SAME functions; A's are killed, B's are memoized.
      // A's flip-diff still stamps (it is part of the pass, not the memo) —
      // the twins' clocks stay in lockstep, so the parity is meaningful.
      writeCameraPlanes(viewsA, 0, cam.planes)
      writeCameraPlanes(viewsB, 0, cam.planes)
      cullViewsBrute(viewsA, 0, b)
      setCollectMemo(true)
      setCullMemo(true)
      cullViewsBrute(viewsB, 0, b)
      const retB = collectInstancesViews(viewsB, 0, b)
      setCollectMemo(false)
      setCullMemo(false)
      const retA = collectInstancesViews(viewsA, 0, b)

      expect(retB).toBe(retA)
      const baseA = b * viewsA.groupMax
      const baseB = b * viewsB.groupMax
      for (let g = 0; g < 8; g++) {
        expect(viewsB.instCounts[baseB + g]).toBe(viewsA.instCounts[baseA + g])
        expect(viewsB.instOffsets[baseB + g]).toBe(viewsA.instOffsets[baseA + g])
      }
      const pA = instancePoolBase(viewsA, b, 0)
      const pB = instancePoolBase(viewsB, b, 0)
      for (let i = 0; i < retA * 16; i++) {
        expect(viewsB.instPool[pB + i]).toBe(viewsA.instPool[pA + i])
      }
      const bA = bitsBase(viewsA, b, 0)
      const bB = bitsBase(viewsB, b, 0)
      for (let w = 0; w < viewsA.bitsWords; w++) {
        expect(viewsB.bits[bB + w]).toBe(viewsA.bits[bA + w])
      }
    }
    const c = collectMemoCounters()
    // 28 static alternated frames hit; 2 warmups + 14 mutation frames miss.
    expect(c.hits).toBeGreaterThan(30)
    expect(c.misses).toBeGreaterThan(12)
  })

  it('a static frame after both buffers are live is a collect HIT (one compare)', () => {
    const scene = buildMemoScene(7, 200)
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    collectInstancesViews(views, 0, 0)
    cullViewsBrute(views, 0, 1)
    collectInstancesViews(views, 0, 1)
    const before = collectMemoCounters()
    const ret = collectInstancesViews(views, 0, 0) // bits[0] == bits[1], clock frozen
    const after = collectMemoCounters()
    expect(after.hits - before.hits).toBe(1)
    expect(after.misses - before.misses).toBe(0)
    expect(ret).toBeGreaterThan(0)
  })
})

describe('Task 190: invalidation — every stamp family forces a miss', () => {
  it('setLocal + updateWorld re-culls (a node leaves the frustum)', () => {
    const scene = createScene({ capacity: 8, cameraMax: 1, groupMax: 1 })
    const slot = scene.create({ position: [0, 0, 50], sphere: [0, 0, 0, 3], group: 0 })
    scene.updateWorld()
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    cullViewsBrute(views, 0, 0) // warm: the second call is a HIT
    expect(scene.isVisibleRank(0, 0, { bufferIndex: 0 })).toBe(true)
    scene.setLocalTR(slot, 0, 0, 500, 0, 0, 0, 1, 1, 1, 1)
    scene.updateWorld()
    const before = cullMemoCounters()
    cullViewsBrute(views, 0, 0)
    const after = cullMemoCounters()
    expect(after.misses - before.misses).toBe(1) // the stamp moved the clock
    expect(scene.isVisibleRank(0, 0, { bufferIndex: 0 })).toBe(false)
  })

  it('setVisible invalidates the pool memo (composition change)', () => {
    const scene = buildMemoScene(11, 120)
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    collectInstancesViews(views, 0, 0)
    cullViewsBrute(views, 0, 1)
    const first = collectInstancesViews(views, 0, 1)
    expect(first).toBeGreaterThan(0)
    const target = views.order[0]!
    scene.setVisible(target, false) // groupTouch stamp — the clock moves
    const before = collectMemoCounters()
    const second = collectInstancesViews(views, 0, 1)
    const after = collectMemoCounters()
    expect(after.misses - before.misses).toBe(1)
    expect(after.hits - before.hits).toBe(0)
    expect(second).toBe(first - 1)
    scene.setVisible(target, true)
    expect(collectInstancesViews(views, 0, 1)).toBe(first)
  })

  it('a pack (setParent) re-culls — the epoch key (rank meaning changed)', () => {
    const scene = buildMemoScene(13, 120)
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    cullViewsBrute(views, 0, 0) // HIT — the memo is warm
    const a = views.order[0]!
    const b = views.order[1]!
    scene.setParent(a, b)
    scene.updateWorld() // re-packs: H_LAYOUT_EPOCH moves (AND the clock)
    const before = cullMemoCounters()
    cullViewsBrute(views, 0, 0)
    const after = cullMemoCounters()
    expect(after.misses - before.misses).toBe(1)
    // exactness: the memoized post-pack cull == a fresh kill-switch cull
    const memoed = views.bits.slice(bitsBase(views, 0, 0), bitsBase(views, 0, 0) + views.bitsWords)
    setCullMemo(false)
    cullViewsBrute(views, 0, 0)
    expect(views.bits.slice(bitsBase(views, 0, 0), bitsBase(views, 0, 0) + views.bitsWords).join(','))
      .toBe(memoed.join(','))
  })

  it('camera planes change with a frozen clock re-culls (the planes key)', () => {
    const scene = buildMemoScene(17, 120)
    const views = scene.views
    const camWide = cameraFor()
    const camNear = createCamera().setPerspective(0.35, 1, 0.1, 900).setViewLookAt(0, 0, 220, 0, 0, 0, 0, 1, 0)
    writeCameraPlanes(views, 0, camWide.planes)
    cullViewsBrute(views, 0, 0)
    cullViewsBrute(views, 0, 0) // HIT — warm
    const wide = views.bits.slice(bitsBase(views, 0, 0), bitsBase(views, 0, 0) + views.bitsWords)
    // NO scene mutation — only the camera narrows; the clock is FROZEN.
    writeCameraPlanes(views, 0, camNear.planes)
    const before = cullMemoCounters()
    cullViewsBrute(views, 0, 0)
    const after = cullMemoCounters()
    expect(after.misses - before.misses).toBe(1) // the 24 planes are a key
    const near = views.bits.slice(bitsBase(views, 0, 0), bitsBase(views, 0, 0) + views.bitsWords)
    let diff = 0
    for (let w = 0; w < views.bitsWords; w++) {
      if (wide[w] !== near[w]) diff++
    }
    expect(diff).toBeGreaterThan(0) // narrower frustum — fewer bits
  })

  it('the off-pattern cull→refit→cull hole is closed by the refit clock bump (hierarchical)', () => {
    // A tree whose internal auto-bound is EMPTY until the first refit. The
    // first cull walks with r=0 ("unknown volume"); after the refit the root
    // HAS an enclosing sphere — the walk changes. Without the Task-190 bump
    // the refit leaves the clock untouched and the memo would serve the
    // pre-refit bitset forever.
    const scene = createScene({ capacity: 32, cameraMax: 1, groupMax: 2, maxInstances: 32 })
    const root = scene.create({ position: [0, 0, 0], sphere: [0, 0, 0, -1] })
    for (let i = 0; i < 24; i++) {
      scene.create({ parent: root, position: [(i % 8) * 2 - 7, ((i / 8) | 0) * 2, 40], sphere: [0, 0, 0, 0.8], group: i % 2 })
    }
    scene.updateWorld()
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    scene.cull([cam], { bufferIndex: 0 }) // bounds NOT refit yet
    const preRefit = views.bits.slice(bitsBase(views, 0, 0), bitsBase(views, 0, 0) + views.bitsWords)
    const refitted = scene.refitGroupBounds()
    expect(refitted).toBeGreaterThan(0) // the root's bound WAS rebuilt
    const before = cullMemoCounters()
    scene.cull([cam], { bufferIndex: 0 })
    const after = cullMemoCounters()
    expect(after.misses - before.misses).toBe(1) // the bump worked
    const postRefit = views.bits.slice(bitsBase(views, 0, 0), bitsBase(views, 0, 0) + views.bitsWords)
    // the visible SET is the same (the leaves did not move; only the walk
    // changed: descent → trivial accept); the memoized result == a fresh one
    expect(postRefit.join(',')).toBe(preRefit.join(','))
    setCullMemo(false)
    scene.cull([cam], { bufferIndex: 0 })
    expect(views.bits.slice(bitsBase(views, 0, 0), bitsBase(views, 0, 0) + views.bitsWords).join(','))
      .toBe(postRefit.join(','))
  })
})

describe('Task 190: scene isolation — the WeakMap keying', () => {
  it('two identical scenes at equal clocks and epochs never validate each other', () => {
    // A shared module-level memo would collide HERE: identical builders →
    // equal H_CLOCK, equal H_LAYOUT_EPOCH, equal planes, equal flags. The
    // second scene's first cull would HIT the first scene's slot and leave
    // its bitset at zero while reporting the twin's stats. The WeakMap makes
    // B's first cull a MISS — B's bits are B's own.
    const sceneA = buildMemoScene(5, 150)
    const sceneB = buildMemoScene(5, 150)
    const cam = cameraFor()
    writeCameraPlanes(sceneA.views, 0, cam.planes)
    writeCameraPlanes(sceneB.views, 0, cam.planes)
    expect(sceneA.views.headerU[8]).toBe(sceneB.views.headerU[8]) // H_CLOCK — equal
    cullViewsBrute(sceneA.views, 0, 0) // A culls; A's memo slot is saved
    const before = cullMemoCounters()
    const statsB = cullViewsBrute(sceneB.views, 0, 0) // B's FIRST cull — must MISS
    const after = cullMemoCounters()
    expect(after.misses - before.misses).toBe(1)
    expect(after.hits - before.hits).toBe(0)
    // B's bitset is written (a leaked hit would leave it all-zero):
    const base = bitsBase(sceneB.views, 0, 0)
    let pop = 0
    for (let w = 0; w < sceneB.views.bitsWords; w++) {
      if (sceneB.views.bits[base + w] !== 0) pop++
    }
    expect(pop).toBeGreaterThan(0)
    expect(statsB.visible).toBeGreaterThan(0)
    // and A's memo still holds — a repeat cull of A is a HIT, bits stable
    const bitsA = sceneA.views.bits.slice(bitsBase(sceneA.views, 0, 0), bitsBase(sceneA.views, 0, 0) + sceneA.views.bitsWords)
    const hitsBefore = cullMemoCounters().hits
    cullViewsBrute(sceneA.views, 0, 0)
    expect(cullMemoCounters().hits).toBe(hitsBefore + 1)
    expect(sceneA.views.bits.slice(bitsBase(sceneA.views, 0, 0), bitsBase(sceneA.views, 0, 0) + sceneA.views.bitsWords).join(','))
      .toBe(bitsA.join(','))
  })
})

describe('Task 190: the stats contract on the hit path', () => {
  it('a hit serves the cached five numbers through out records', () => {
    const scene = buildMemoScene(23, 150)
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    const out1: MutableCullStats = { tested: 0, visible: 0, trivialRejects: 0, trivialAccepts: 0, planeTests: 0 }
    cullViewsBrute(views, 0, 0, out1)
    const out2: MutableCullStats = { tested: -1, visible: -1, trivialRejects: -1, trivialAccepts: -1, planeTests: -1 }
    const before = cullMemoCounters()
    cullViewsBrute(views, 0, 0, out2) // HIT
    expect(cullMemoCounters().hits - before.hits).toBe(1)
    expect(out2.tested).toBe(out1.tested)
    expect(out2.visible).toBe(out1.visible)
    expect(out2.trivialRejects).toBe(out1.trivialRejects)
    expect(out2.trivialAccepts).toBe(out1.trivialAccepts)
    expect(out2.planeTests).toBe(out1.planeTests)
  })

  it('masks=false and the default mode never share a memo slot (stats stay exact)', () => {
    // A TREE straddling the frustum: the root's auto-bound intersects the
    // side planes → descent — exactly where the Task-85 masks narrow the
    // children's plane set. (On the flat fixtures every node is a leaf:
    // masks change NOTHING there — the honest trap this fixture avoids.)
    const scene = createScene({ capacity: 16, cameraMax: 1, groupMax: 2, maxInstances: 16 })
    const root = scene.create({ position: [0, 0, 50], sphere: [0, 0, 0, -1] })
    for (let i = 0; i < 6; i++) {
      scene.create({
        parent: root,
        position: [-150 + i * 60, 0, 0],
        sphere: [0, 0, 0, 4],
        group: i % 2,
      })
    }
    scene.updateWorld()
    scene.refitGroupBounds()
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    scene.cull([cam], { bufferIndex: 0 }) // the default-mode slot (masks, counted)
    const withMasks: MutableCullStats = { tested: 0, visible: 0, trivialRejects: 0, trivialAccepts: 0, planeTests: 0 }
    const withoutMasks: MutableCullStats = { tested: 0, visible: 0, trivialRejects: 0, trivialAccepts: 0, planeTests: 0 }
    const before = cullMemoCounters()
    cullViewsHierarchical(views, 0, 0, withMasks, true) // the same slot as scene.cull — HIT
    cullViewsHierarchical(views, 0, 0, withoutMasks, false) // the flag differs — MISS
    const after = cullMemoCounters()
    expect(after.hits - before.hits).toBe(1)
    expect(after.misses - before.misses).toBe(1)
    expect(withoutMasks.planeTests).toBeGreaterThan(withMasks.planeTests)
    expect(withoutMasks.visible).toBe(withMasks.visible)
    expect(withMasks.visible).toBeGreaterThan(0)
  })

  it('H_DROPPED_INSTANCES does not grow on hits', () => {
    const scene = createScene({ capacity: 32, cameraMax: 1, groupMax: 2, maxInstances: 4 })
    for (let i = 0; i < 24; i++) {
      scene.create({ position: [(i % 8) * 2, ((i / 8) | 0) * 2, 30], sphere: [0, 0, 0, 1], group: i % 2 })
    }
    scene.updateWorld()
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    const dropped1 = views.headerI[H_DROPPED_INSTANCES]
    cullViewsBrute(views, 0, 0)
    collectInstancesViews(views, 0, 0) // a full pass — 24 visible, 4 fit → drops
    const dropped2 = views.headerI[H_DROPPED_INSTANCES]
    expect(dropped2 - dropped1).toBe(20)
    cullViewsBrute(views, 0, 1) // the sibling goes live (the flip-diff rhythm)
    collectInstancesViews(views, 0, 1) // full again — drops recounted (honesty)
    const dropped3 = views.headerI[H_DROPPED_INSTANCES]
    expect(dropped3 - dropped2).toBe(20)
    const before = collectMemoCounters()
    collectInstancesViews(views, 0, 0) // HIT — a skipped pass drops nothing
    expect(collectMemoCounters().hits - before.hits).toBe(1)
    expect(views.headerI[H_DROPPED_INSTANCES]).toBe(dropped3)
  })
})

describe('Task 190: the static pipeline frame', () => {
  it('runScenePipeline skips cull+collect on an unchanged frame (the counters)', () => {
    const scene = buildMemoScene(31, 800)
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    views.headerI[H_CAMERA_COUNT] = 1
    // Warm 0, 1, 0: the FIRST collect's epoch branch stamps all groups
    // (a pack happened since the buffer was born) — that stamp lands BETWEEN
    // call 1's cull-save and call 3, so the cull memo needs one extra real
    // round before it can hit. Four calls make the rhythm honest.
    runScenePipeline(views, 0)
    runScenePipeline(views, 1)
    runScenePipeline(views, 0)
    const cull = cullMemoCounters()
    const collect = collectMemoCounters()
    runScenePipeline(views, 1) // nothing changed — both stages HIT
    const cull2 = cullMemoCounters()
    const collect2 = collectMemoCounters()
    expect(cull2.hits - cull.hits).toBe(1)
    expect(cull2.misses - cull.misses).toBe(0)
    expect(collect2.hits - collect.hits).toBe(1)
    expect(collect2.misses - collect.misses).toBe(0)
    // and the content survived the skipped frame
    const total = collectInstancesViews(views, 0, 0)
    expect(total).toBeGreaterThan(0)
  })
})

describe('Task 190: the kill-switch', () => {
  it('disabled memoes: no hits, the full behavior (mutations land immediately)', () => {
    const scene = buildMemoScene(37, 120)
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    setCollectMemo(false)
    setCullMemo(false)
    const cullBefore = cullMemoCounters()
    const collectBefore = collectMemoCounters()
    cullViewsBrute(views, 0, 0)
    cullViewsBrute(views, 0, 0)
    collectInstancesViews(views, 0, 0)
    collectInstancesViews(views, 0, 0)
    // the counters are module-global — the deltas are the honest assert
    expect(cullMemoCounters().hits).toBe(cullBefore.hits)
    expect(collectMemoCounters().hits).toBe(collectBefore.hits)
    const target = views.order[0]!
    scene.setVisible(target, false)
    const total = collectInstancesViews(views, 0, 0)
    expect(total).toBeGreaterThan(0) // the full pass ran and saw the change
  })
})
