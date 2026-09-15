/**
 * Task 214 tests — @rune/scene's mirror/publish ON THE STORE.
 *
 * The contracts:
 *   · ADOPTION ALIASES: the stores' column views read the SAME bytes the
 *     Scene API writes (pos/quat/scale through setLocalTR; sphereL/W
 *     through setSphereLocal + refit; the world rows through the
 *     pipeline's updateWorld — rank-major, resolved through rankOf);
 *   · THE POOL SIDE: the (row, camera) store's matrix column is
 *     BIT-EXACT the segment view (instanceMatricesView's own bytes);
 *     `ranges` is the stamp law — a group whose node moved (or whose
 *     visibility flipped for THIS camera) re-uploads exactly its
 *     segment, the others stay; a fresh watermark sees nothing; a pack is
 *     conservative (the collect's own all-groups stamp — the store sees
 *     the scene's law);
 *   · THE PUBLISH SIDE: staticRanges = the live slots whose locals
 *     changed (the stamp domain is the same H_CLOCK — one watermark
 *     serves both directions); a fresh watermark sees nothing; a dead
 *     slot never reports;
 *   · THE WORLD SIDE: worldRanges resolves worldStamp through order[]
 *     (rank-space records); a layout-epoch change returns the FULL
 *     region (touchAll — never a skip);
 *   · THE SHAPE: every range is 4-aligned, non-empty, and pairwise
 *     DISJOINT (a multi-column store emits per-column blocks — the runs
 *     interleave across columns, the updateRecords contract only demands
 *     disjoint 4-aligned spans);
 *   · THE BRIDGE WRAPPER: take() observes freshness and captures the
 *     watermark (a stale take holds it) — the real-worker path.
 */
import { describe, expect, it } from 'bun:test'
import { Worker } from 'node:worker_threads'
import {
  createCamera,
  createScene,
  createSceneStoreMirror,
  createSceneWorkerBridge,
} from '../src/index.ts'
import type { Scene } from '../src/index.ts'

function mkCam(yaw: number, dist: number) {
  const cam = createCamera().setPerspective(1.1, 1, 0.5, 200)
  cam.setViewLookAt(Math.cos(yaw) * dist, 8, Math.sin(yaw) * dist, 0, 0, 0, 0, 1, 0)
  return cam
}

function bunPort(worker: Worker) {
  return {
    postMessage: (message: unknown) => worker.postMessage(message),
    onMessage: (handler: (message: unknown) => void) => { worker.on('message', handler) },
    terminate: () => worker.terminate(),
  }
}

/** the shape law: 4-aligned, non-empty, pairwise disjoint (updateRecords' contract) */
function expectRangeShape(ranges: { start: number; end: number }[]) {
  const spans: [number, number][] = []
  for (const r of ranges) {
    expect(r.start % 4).toBe(0)
    expect(r.end % 4).toBe(0)
    expect(r.end).toBeGreaterThan(r.start)
    spans.push([r.start, r.end])
  }
  spans.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < spans.length; i++) {
    expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1])
  }
}

/** the 4-byte words covered by the ranges */
function coveredBytes(ranges: { start: number; end: number }[]): Set<number> {
  const set = new Set<number>()
  for (const r of ranges) for (let b = r.start; b < r.end; b += 4) set.add(b)
  return set
}

describe('Task 214: the scene store mirror — adoption, dirt, shape', () => {
  const opts = { capacity: 256, cameraMax: 2, groupMax: 4, maxInstances: 256, shared: false } as const

  function buildCity(scene: Scene, perGroup = 20) {
    const slots: number[] = []
    for (let i = 0; i < perGroup * 4; i++) {
      slots.push(
        scene.create({
          position: [i * 1.5, 0, 0],
          sphere: [0, 0, 0, 1],
          group: i % 4,
        }),
      )
    }
    return slots
  }

  it('the adopted stores alias the Scene API\u2019s own bytes', () => {
    const scene = createScene({ ...opts })
    const slots = buildCity(scene)
    const mirror = createSceneStoreMirror(scene)

    // the SLICE discipline: each store's capacity is its REGION's, not the
    // whole buffer remainder's (the quat view must land on the scene's own
    // quat region — the bug the regionBytes bound kills)
    expect(mirror.locals.capacity).toBe(views(scene).capacity)
    expect(mirror.worlds.capacity).toBe(views(scene).capacity)
    expect(mirror.pool(0, 0).capacity).toBe(views(scene).maxInstances)

    // locals: setLocalTR writes the exact bytes the column views read
    const s = slots[7]
    scene.setLocalTR(s, 11, 12, 13, 0, 0, 0, 1, 2, 3, 4)
    const pos = mirror.locals.column('pos') as Float32Array
    const quat = mirror.locals.column('quat') as Float32Array
    const scale = mirror.locals.column('scale') as Float32Array
    expect([pos[s * 3], pos[s * 3 + 1], pos[s * 3 + 2]]).toEqual([11, 12, 13])
    expect([quat[s * 4], quat[s * 4 + 1], quat[s * 4 + 2], quat[s * 4 + 3]]).toEqual([0, 0, 0, 1])
    expect([scale[s * 3], scale[s * 3 + 1], scale[s * 3 + 2]]).toEqual([2, 3, 4])

    // spheres: setSphereLocal lands in the adopted sphereL column
    scene.setSphereLocal(s, 5, 6, 7, 8)
    const sphereL = mirror.spheres.column('sphereL') as Float32Array
    expect([sphereL[s * 4], sphereL[s * 4 + 1], sphereL[s * 4 + 2], sphereL[s * 4 + 3]]).toEqual([5, 6, 7, 8])

    // worlds: the pipeline's rank-major rows, resolved through rankOf
    scene.pack()
    scene.updateWorld()
    scene.refitGroupBounds()
    const world = mirror.worlds.column('world') as Float32Array
    for (const slot of slots.slice(0, 12)) {
      const rank = views(scene).rankOf[slot]
      const view = scene.worldMatrix(slot)
      for (let w = 0; w < 16; w++) expect(world[rank * 16 + w]).toBe(view[w])
    }

    // the buffer identity: every column view rides the scene's own buffer
    expect(mirror.locals.buffer).toBe(views(scene).buffer)
    expect(mirror.spheres.buffer).toBe(views(scene).buffer)
    expect(mirror.worlds.buffer).toBe(views(scene).buffer)
    expect(mirror.pool(1, 1).buffer).toBe(views(scene).buffer)
  })

  it('the pool store is the segment view\u2019s own bytes; ranges = the stamp law', () => {
    const scene = createScene({ ...opts })
    const slots = buildCity(scene)
    const mirror = createSceneStoreMirror(scene)
    const v = views(scene)

    // explicit buffer discipline: frame N writes row b = N&1 — the
    // BRIDGE's own convention (the worker's epoch&1), which pool() shares
    const runFrame = (cam: ReturnType<typeof mkCam>, b: number) => {
      scene.updateWorld()
      scene.refitGroupBounds()
      scene.cull([cam], { bufferIndex: b })
      scene.collectInstances(0, { bufferIndex: b })
    }
    runFrame(mkCam(0.2, 40), 0)

    // THE POOL ≡ THE SEGMENTS: the store's matrix column is the same
    // memory instanceMatricesView hands out (bit-exact over the segments,
    // at each group's own segment offset)
    const store = mirror.pool(0, 0)
    const col = store.column('matrix') as Float32Array
    const segOff = (g: number): number => v.instOffsets[0 * v.cameraMax * v.groupMax + g]
    for (let g = 0; g < 4; g++) {
      const seg = scene.instances(g, { cameraIndex: 0, bufferIndex: 0 })
      expect(seg.count).toBeGreaterThan(0)
      for (let i = 0; i < seg.count * 16; i++) expect(col[segOff(g) * 16 + i]).toBe(seg.matrices[i])
    }

    // THE STAMP LAW: move one node of group 2 — exactly that segment
    // re-uploads; the other groups' bytes stay clean
    const wm1 = v.headerU[8] // H_CLOCK after frame 1
    scene.setLocalTR(slots[2], 100, 0, 0, 0, 0, 0, 1, 1, 1, 1)
    runFrame(mkCam(0.2, 40), 1)
    const wm2 = v.headerU[8]
    expect(wm2).toBeGreaterThan(wm1)
    const ranges = mirror.ranges(1, 0, wm1)
    expectRangeShape(ranges)
    const seg2 = scene.instances(2, { cameraIndex: 0, bufferIndex: 1 })
    const seg1 = scene.instances(1, { cameraIndex: 0, bufferIndex: 1 })
    const rowBase1 = mirror.pool(1, 0).columnBytes('matrix').start
    // the row's per-group offsets (buffer 1, camera 0): (b*cameraMax + k)*groupMax
    const off1 = v.instOffsets[1 * v.cameraMax * v.groupMax + 1]
    const off2 = v.instOffsets[1 * v.cameraMax * v.groupMax + 2]
    const covered = coveredBytes(ranges)
    // group 2's segment words are covered (buffer-absolute — the store's
    // own column offsets, at the group's own segment offset)
    for (let i = 0; i < seg2.count; i++) expect(covered.has(rowBase1 + (off2 + i) * 64)).toBe(true)
    // group 1's segment words are NOT (its bytes did not change)
    for (let i = 0; i < seg1.count; i++) expect(covered.has(rowBase1 + (off1 + i) * 64)).toBe(false)
    // the fresh watermark sees nothing
    expect(mirror.ranges(1, 0, wm2)).toEqual([])

    // THE VISIBILITY FLIP: hide a node of group 1 — group 1's segment
    // re-uploads (groupFlip), group 3's does not
    const wm3 = v.headerU[8]
    scene.setVisible(slots[1], false)
    runFrame(mkCam(0.2, 40), 0)
    const rangesFlip = mirror.ranges(0, 0, wm3)
    expectRangeShape(rangesFlip)
    const seg1b = scene.instances(1, { cameraIndex: 0, bufferIndex: 0 })
    const seg3 = scene.instances(3, { cameraIndex: 0, bufferIndex: 0 })
    const rowBase0 = mirror.pool(0, 0).columnBytes('matrix').start
    const off1b = v.instOffsets[0 * v.cameraMax * v.groupMax + 1]
    const off3 = v.instOffsets[0 * v.cameraMax * v.groupMax + 3]
    const coveredFlip = coveredBytes(rangesFlip)
    for (let i = 0; i < seg1b.count; i++) expect(coveredFlip.has(rowBase0 + (off1b + i) * 64)).toBe(true)
    for (let i = 0; i < seg3.count; i++) expect(coveredFlip.has(rowBase0 + (off3 + i) * 64)).toBe(false)
    // the fresh watermark is clean again, and a stale re-query with the old
    // watermark is IDEMPOTENT (ranges is a pure query)
    expect(mirror.ranges(0, 0, v.headerU[8])).toEqual([])
    expect(mirror.ranges(0, 0, wm3)).toEqual(rangesFlip)

    // THE PACK CONSERVATISM: a structural edit reshuffles ranks — the
    // collect stamps EVERY group (instances.ts's own law); the store sees
    // the full segments even at a per-group watermark
    const wm4 = v.headerU[8]
    scene.setParent(slots[79], slots[0])
    runFrame(mkCam(0.2, 40), 1)
    const rangesPack = mirror.ranges(1, 0, wm4)
    const rowBase1b = mirror.pool(1, 0).columnBytes('matrix').start
    const coveredPack = coveredBytes(rangesPack)
    let total = 0
    for (let g = 0; g < 4; g++) total += scene.instances(g, { cameraIndex: 0, bufferIndex: 1 }).count
    for (let i = 0; i < total; i++) expect(coveredPack.has(rowBase1b + i * 64)).toBe(true)
  })

  it('staticRanges: the live slots whose locals changed; fresh sees nothing; the dead stay silent', () => {
    const scene = createScene({ ...opts })
    const slots = buildCity(scene)
    const mirror = createSceneStoreMirror(scene)
    const v = views(scene)
    scene.pack()
    scene.updateWorld()

    // three far-apart slots — per-column blocks (pos/quat/scale live in
    // three separate regions: 3 runs × 3 columns = 9 ranges, disjoint)
    const targets = [slots[0], slots[40], slots[79]]
    const wm = v.headerU[8]
    for (const s of targets) scene.setLocalTR(s, 9, 9, 9, 0, 0, 0, 1, 1, 1, 1)
    const ranges = mirror.staticRanges(wm)
    expectRangeShape(ranges)
    expect(ranges.length).toBe(9)
    const posBase = mirror.locals.columnBytes('pos').start
    const quatBase = mirror.locals.columnBytes('quat').start
    const scaleBase = mirror.locals.columnBytes('scale').start
    const covered = coveredBytes(ranges)
    for (const s of targets) {
      expect(covered.has(posBase + s * 12)).toBe(true)
      expect(covered.has(quatBase + s * 16)).toBe(true)
      expect(covered.has(scaleBase + s * 12)).toBe(true)
    }
    // a neighbor slot's bytes stay clean
    expect(covered.has(posBase + slots[1] * 12)).toBe(false)
    // the fresh watermark sees nothing
    expect(mirror.staticRanges(v.headerU[8])).toEqual([])
    // dead slots never report: dispose after a local edit — the stale
    // stamp must NOT reappear in the ranges
    const dead = slots[slots.length - 1]
    const wm2 = v.headerU[8]
    scene.setLocalTR(dead, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1)
    scene.dispose(dead)
    const ranges2 = mirror.staticRanges(wm2)
    expect(coveredBytes(ranges2).has(posBase + dead * 12)).toBe(false)
  })

  it('worldRanges: rank-space dirt through order[]; a layout change = the full region', () => {
    const scene = createScene({ ...opts })
    const slots = buildCity(scene)
    const mirror = createSceneStoreMirror(scene)
    const v = views(scene)
    scene.pack()
    scene.updateWorld()
    const layout0 = mirror.layoutEpoch()

    // one node moves — its rank's 64B row is the dirt (a single run in a
    // single-column store: ONE range)
    const moved = slots[10]
    const wm = v.headerU[8]
    scene.setLocalTR(moved, 50, 50, 50, 0, 0, 0, 1, 1, 1, 1)
    scene.updateWorld()
    const ranges = mirror.worldRanges(wm, layout0)
    expectRangeShape(ranges)
    expect(ranges.length).toBe(1)
    const covered = coveredBytes(ranges)
    const worldBase = mirror.worlds.columnBytes('world').start
    const movedRank = v.rankOf[moved]
    expect(covered.has(worldBase + movedRank * 64)).toBe(true)
    // the fresh watermark (and the current layout) sees nothing
    expect(mirror.worldRanges(v.headerU[8], mirror.layoutEpoch())).toEqual([])

    // a structural edit reshuffles the ranks — with the consumer's OLD
    // layout epoch the FULL region returns (touchAll, never a skip)
    scene.setParent(slots[79], slots[0])
    scene.pack()
    scene.updateWorld()
    expect(mirror.layoutEpoch()).not.toBe(layout0)
    const full = mirror.worldRanges(wm, layout0)
    expect(full.length).toBe(1)
    const worldBase2 = mirror.worlds.columnBytes('world').start
    expect(full[0].start).toBe(worldBase2)
    expect(full[0].end).toBe(worldBase2 + v.headerI[2] * 64)
  })

  it('the bridge wrapper: take() observes freshness and captures the watermark; stale holds', async () => {
    const worker = new Worker(new URL('./sceneWorkerEntry.ts', import.meta.url))
    const scene = createScene({ ...opts, shared: true })
    buildCity(scene)
    const bridge = createSceneWorkerBridge({ scene, worker: bunPort(worker) })
    const mirror = createSceneStoreMirror(scene, bridge)
    await bridge.ready

    const cam = mkCam(0.2, 40)
    bridge.publish([cam])
    const snap1 = await bridge.waitFresh(4000)
    expect(snap1).not.toBeNull()
    expect(mirror.observe(snap1!.epoch)).toBe(true)
    const wm1 = mirror.watermark()
    expect(wm1).toBeGreaterThan(0)

    // THE POOL ≡ THE SNAPSHOT (through the REAL worker path): the store's
    // column is the snapshot segment's own bytes (at each group's offset)
    const store = mirror.pool(snap1!.epoch, 0)
    const col = store.column('matrix') as Float32Array
    const vB = views(scene)
    const rowBaseB = store.columnBytes('matrix').start
    for (let g = 0; g < 4; g++) {
      const seg = snap1!.instances[0][g]
      const off = vB.instOffsets[(snap1!.epoch & 1) * vB.cameraMax * vB.groupMax + g]
      for (let i = 0; i < seg.count * 16; i++) expect(col[off * 16 + i]).toBe(seg.matrices[i])
    }
    expect(rowBaseB).toBe(vB.instPool.byteOffset + (snap1!.epoch & 1) * vB.cameraMax * vB.maxInstances * 64)

    // a fresh take (the worker produced the next epoch) advances the
    // watermark; a stale take holds it
    const cam2 = mkCam(1.4, 30)
    bridge.publish([cam2])
    await bridge.waitFresh(4000)
    // one more publish+wait so take() lands on a FRESH epoch itself
    bridge.publish([cam2])
    const snap3 = await bridge.waitFresh(4000)
    const takenFresh = mirror.take()
    expect(takenFresh).not.toBeNull()
    expect(takenFresh!.epoch).toBe(snap3!.epoch)
    const wm2 = mirror.watermark()
    expect(wm2).toBeGreaterThanOrEqual(wm1)
    const stale = mirror.take()
    expect(stale!.epoch).toBe(takenFresh!.epoch)
    expect(mirror.watermark()).toBe(wm2) // held — the stale discipline

    // the moved-node law through the worker path: publish a frame where
    // one node moved; the diff against the held watermark covers exactly
    // that group's segment bytes
    const movedSlot = views(scene).order[3]
    const wmBefore = mirror.watermark()
    scene.setLocalTR(movedSlot, 77, 0, 0, 0, 0, 0, 1, 1, 1, 1)
    bridge.publish([cam2])
    const snap4 = await bridge.waitFresh(4000)
    mirror.observe(snap4!.epoch)
    const ranges = mirror.ranges(snap4!.epoch, 0, wmBefore)
    expectRangeShape(ranges)
    const movedGroup = views(scene).group[movedSlot]
    const seg = snap4!.instances[0][movedGroup]
    const vW = views(scene)
    const rowBase4 = mirror.pool(snap4!.epoch, 0).columnBytes('matrix').start
    const offG = vW.instOffsets[(snap4!.epoch & 1) * vW.cameraMax * vW.groupMax + movedGroup]
    const covered = coveredBytes(ranges)
    for (let i = 0; i < seg.count; i++) expect(covered.has(rowBase4 + (offG + i) * 64)).toBe(true)

    // take() without the factory's bridge is the documented error
    const solo = createSceneStoreMirror(createScene({ ...opts }))
    expect(() => solo.take()).toThrow()

    await bridge.dispose()
  })
})

function views(scene: Scene) {
  return scene.views
}
