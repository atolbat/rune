/**
 * Task 182 tests — the scene-package audit fixes:
 *   • popcountBits SWAR form (property: equals the Kernighan reference);
 *   • cullViewsHierarchical countVisible=false (the -1 sentinel, exact other
 *     stats, bit-identical result) + runScenePipeline parity (the pipeline
 *     skips the popcount — the numbers were never read there);
 *   • THE AUTO-PARITY FIX: the DEFAULT cull/collect loop alternates the
 *     double bitset buffer (0,1,0,1…) — the Task-85 groupFlip diff finally
 *     sees the PREVIOUS frame instead of a dead never-written buffer, so the
 *     flip memo (the instance upload skip) works in T0 out of the box;
 *     static frames freeze the stamps, a camera turn grows them;
 *   • forEachVisible strength reduction (word cache + rolling mask) — the
 *     callback sequence is EXACTLY the per-rank form's, including the
 *     n % 32 === 0 boundary (the guarded last reload);
 *   • the bridge snapshot reuse ring (real worker): alternating ring slots,
 *     object identity, content parity with the T0 reference, live-sized bits.
 */
import { describe, expect, it } from 'bun:test'
import { Worker } from 'node:worker_threads'
import {
  bitsBase,
  createCamera,
  createScene,
  createSceneWorkerBridge,
  cullViewsHierarchical,
  popcountBits,
} from '../src/index.ts'
import type { MutableCullStats } from '../src/index.ts'
import { runScenePipeline } from '../src/index.ts'
import { H_CAMERA_COUNT } from '../src/layout.ts'
import type { Scene } from '../src/index.ts'

// ─── helpers ────────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The Kernighan reference (the pre-Task-182 popcountBits, verbatim). */
function popcountKernighan(bits: Uint32Array, base: number, words: number): number {
  let count = 0
  for (let w = 0; w < words; w++) {
    let v = bits[base + w]
    while (v !== 0) { v &= v - 1; count++ }
  }
  return count
}

/** A random mixed scene with groups (for the memo/pipeline tests). */
function buildScene(seed: number, targetNodes: number): Scene {
  const rnd = mulberry32(seed)
  const scene = createScene({ capacity: targetNodes + 16, groupMax: 4, shared: false })
  const parents: number[] = []
  let created = 0
  while (created < targetNodes) {
    const parent = parents.length > 0 && rnd() < 0.7 ? parents[Math.floor(rnd() * parents.length)]! : -1
    const slot = scene.create({
      parent,
      position: [(rnd() - 0.5) * 40, (rnd() - 0.5) * 10, (rnd() - 0.5) * 40],
      group: rnd() < 0.6 ? Math.floor(rnd() * 4) : -1,
      sphere: rnd() < 0.5 ? [0, 0, 0, 0.5 + rnd() * 2] : undefined,
    })
    parents.push(slot)
    created++
  }
  // Task 192: the leaf-domain contract — grouped internal nodes demoted. A
  // grouped node that gained children is demoted (the documented contract:
  // setGroup on it would do exactly this; here we keep the historical
  // fixtures' semantics under the tail layout).
  {
    const v = scene.views
    for (let slot = 0; slot < v.capacity; slot++) {
      if ((v.nodeFlags[slot] & 2) === 0) continue // NF_ALIVE
      if (v.group[slot] >= 0 && v.firstChild[slot] >= 0) scene.setGroup(slot, -1)
    }
  }
  scene.pack()
  return scene
}

function mkCam(yaw: number, dist: number) {
  const cam = createCamera().setPerspective(1.1, 1, 0.5, 200)
  cam.setViewLookAt(Math.cos(yaw) * dist, 8, Math.sin(yaw) * dist, 0, 0, 0, 0, 1, 0)
  return cam
}

// ─── popcount: SWAR property ────────────────────────────────────────────────
describe('Task 182: popcountBits — SWAR equals the Kernighan reference', () => {
  it('random words: same count, both directions (dense and sparse)', () => {
    const rnd = mulberry32(1234)
    for (let round = 0; round < 50; round++) {
      const words = 1 + Math.floor(rnd() * 200)
      const dense = rnd() < 0.5
      const bits = new Uint32Array(words + 8)
      for (let w = 4; w < 4 + words; w++) {
        const hi = Math.floor(rnd() * 65536)
        const lo = Math.floor(rnd() * 65536)
        let v = ((hi << 16) | lo) >>> 0
        if (!dense) v &= (1 << Math.floor(rnd() * 32)) - 1 // sparse-ish words
        bits[w] = v
      }
      expect(popcountBits(bits, 4, words)).toBe(popcountKernighan(bits, 4, words))
    }
  })

  it('boundary words and all-zero regions', () => {
    const bits = new Uint32Array([0, 0xffffffff, 0x80000000, 1, 0x55555555, 0xaaaaaaaa, 0x0f0f0f0f, 0, 0x7fffffff])
    expect(popcountBits(bits, 0, bits.length)).toBe(popcountKernighan(bits, 0, bits.length))
    // 0 + 32 + 1 + 1 + 16 + 16 + 16 + 0 + 31 = 113
    expect(popcountBits(bits, 0, bits.length)).toBe(113)
    expect(popcountBits(bits, 1, 1)).toBe(32)
    expect(popcountBits(new Uint32Array(64), 0, 64)).toBe(0)
  })
})

// ─── countVisible=false ─────────────────────────────────────────────────────
describe('Task 182: cullViewsHierarchical countVisible=false', () => {
  it('visible = -1 (not counted), the other stats exact, bits identical', () => {
    const scene = buildScene(31, 400)
    scene.updateWorld()
    scene.refitGroupBounds()
    const cam = mkCam(0.4, 40)
    // The same real planes for both cameras (the walk is deterministic).
    scene.views.planes.set(cam.planes, 0)
    scene.views.planes.set(cam.planes, 24)

    const ref = cullViewsHierarchical(scene.views, 0, 0) // counts (default)
    const out: MutableCullStats = { tested: -1, visible: -2, trivialRejects: -1, trivialAccepts: -1, planeTests: -1 }
    cullViewsHierarchical(scene.views, 1, 1, out, true, false)
    expect(out.visible).toBe(-1)
    expect(out.tested).toBe(ref.tested)
    expect(out.trivialRejects).toBe(ref.trivialRejects)
    expect(out.trivialAccepts).toBe(ref.trivialAccepts)
    expect(out.planeTests).toBe(ref.planeTests)
    // The bitset is IDENTICAL (counting does not affect the result).
    const w = scene.views.bitsWords
    const b0 = bitsBase(scene.views, 0, 0)
    const b1 = bitsBase(scene.views, 1, 1)
    for (let i = 0; i < w; i++) {
      expect(scene.views.bits[b1 + i]).toBe(scene.views.bits[b0 + i])
    }
    expect(ref.visible).toBeGreaterThan(0)
  })

  it('runScenePipeline (no stats read inside) — bit parity with a direct hierarchical cull', () => {
    const scene = buildScene(47, 300)
    scene.updateWorld()
    scene.refitGroupBounds()
    const cam = mkCam(1.2, 55)
    // The worker/T0 pipeline form: planes via the header, buffer 1.
    scene.views.headerI[H_CAMERA_COUNT] = 1
    scene.views.planes.set(cam.planes, 0)
    runScenePipeline(scene.views, 1)
    // Reference: a direct hierarchical cull (the same algorithm, same planes,
    // buffer 0) — countVisible=false inside the pipeline must not change the bits.
    cullViewsHierarchical(scene.views, 0, 0)
    const w = scene.views.bitsWords
    const b1 = bitsBase(scene.views, 1, 0)
    for (let i = 0; i < w; i++) {
      expect(scene.views.bits[b1 + i]).toBe(scene.views.bits[i]) // base 0, camera 0
    }
  })
})

// ─── THE AUTO-PARITY FIX (the T0 flip memo) ─────────────────────────────────
describe('Task 182: default buffers auto-alternate — the flip memo lives in T0', () => {
  it('the default cull alternates 0,1,0; readers default to the latest buffer', () => {
    const scene = buildScene(59, 200)
    scene.updateWorld()
    scene.refitGroupBounds()
    const cam = mkCam(0.3, 40)
    const r1 = scene.cull([cam])
    expect(r1.bufferIndex).toBe(0)
    scene.collectInstances(0)
    const seg1 = scene.instances(0)
    expect(seg1.count).toBe(scene.instances(0, { bufferIndex: 0 }).count)
    const r2 = scene.cull([cam])
    expect(r2.bufferIndex).toBe(1)
    scene.collectInstances(0)
    const seg2 = scene.instances(0)
    expect(seg2.count).toBe(scene.instances(0, { bufferIndex: 1 }).count)
    const r3 = scene.cull([cam])
    expect(r3.bufferIndex).toBe(0)
    // An explicit bufferIndex does NOT advance the rhythm: after three auto
    // culls the next explicit-free call writes buffer 1 (autoEpoch = 3).
    scene.cull([cam], { bufferIndex: 0 }) // explicit — autoEpoch untouched
    const r5 = scene.cull([cam])
    expect(r5.bufferIndex).toBe(1)
  })

  it('STATIC frames freeze the group stamps (the memo finally skips uploads)', () => {
    const scene = buildScene(61, 250)
    const cam = mkCam(0.5, 35)
    const frame = (c: ReturnType<typeof mkCam>) => {
      scene.updateWorld()
      scene.refitGroupBounds()
      scene.cull([c]) // ALL DEFAULTS — the README pattern
      scene.collectInstances(0)
    }
    frame(cam) // epoch 1: everything is new — the stamps grow once
    frame(cam) // epoch 2: THE MEMO — nothing changed
    const stamps2 = [0, 1, 2, 3].map(g => scene.groupFlipStamp(g, 0))
    const worlds2 = [0, 1, 2, 3].map(g => scene.groupWorldStamp(g))
    frame(cam) // epoch 3: still nothing
    const stamps3 = [0, 1, 2, 3].map(g => scene.groupFlipStamp(g, 0))
    const worlds3 = [0, 1, 2, 3].map(g => scene.groupWorldStamp(g))
    expect(stamps3).toEqual(stamps2)
    expect(worlds3).toEqual(worlds2)
    // Sanity: some group is actually in use (the memo is not vacuously quiet).
    expect(stamps2.some(s => s > 0)).toBe(true)
  })

  it('a camera turn grows the flip stamps of the affected groups', () => {
    const scene = buildScene(67, 250)
    const cam = mkCam(0.5, 35)
    const frame = (c: ReturnType<typeof mkCam>) => {
      scene.updateWorld()
      scene.refitGroupBounds()
      scene.cull([c])
      scene.collectInstances(0)
    }
    frame(cam)
    frame(cam)
    const before = [0, 1, 2, 3].map(g => scene.groupFlipStamp(g, 0))
    frame(mkCam(2.8, 35)) // the camera turned
    const after = [0, 1, 2, 3].map(g => scene.groupFlipStamp(g, 0))
    expect(after.some((s, g) => s > before[g]!)).toBe(true)
  })

  it('a drone setVisible toggle grows the CONTENT stamp (groupWorldStamp — the upload trigger)', () => {
    const scene = buildScene(71, 200)
    const cam = mkCam(0.9, 30)
    const frame = () => {
      scene.updateWorld()
      scene.refitGroupBounds()
      scene.cull([cam])
      scene.collectInstances(0)
    }
    frame()
    frame()
    // setVisible does not touch the cull bitset (spheres are unchanged —
    // the flip memo stays quiet, which is CORRECT: the bits did not flip);
    // it bumps the group's CONTENT stamp directly (the pack loses a matrix —
    // the upload must fire). The stamp that grows is groupWorldStamp.
    const flipBefore = scene.groupFlipStamp(0, 0)
    const before = scene.groupWorldStamp(0)
    const countBefore = scene.instanceCountOf(0, 0)
    // Toggle nodes that ARE in the current pack (culled-visible + flag on).
    const visible0: number[] = []
    scene.forEachVisible(0, (slot) => {
      if (scene.views.group[slot] === 0) visible0.push(slot)
    })
    expect(visible0.length).toBeGreaterThanOrEqual(4)
    for (const slot of visible0.slice(0, 8)) scene.setVisible(slot, false)
    expect(scene.groupWorldStamp(0)).toBeGreaterThan(before) // the direct write
    frame()
    frame()
    expect(scene.instanceCountOf(0, 0)).toBeLessThan(countBefore) // the pack shrank
    expect(scene.groupFlipStamp(0, 0)).toBe(flipBefore) // the bits did not flip
  })
})

// ─── forEachVisible strength reduction ──────────────────────────────────────
describe('Task 182: forEachVisible — the cached-word walk equals the per-rank form', () => {
  it('mixed flags, n not a multiple of 32: the exact callback sequence', () => {
    const scene = buildScene(83, 377) // 377 = 11×32 + 25 — partial last word
    scene.updateWorld()
    scene.refitGroupBounds()
    const cam = mkCam(1.7, 45)
    scene.cull([cam], { bufferIndex: 0 })
    // Reference: the per-rank form (bits + node flag), verbatim.
    const base = bitsBase(scene.views, 0, 0)
    const expected: Array<[number, number]> = []
    for (let r = 0; r < scene.count; r++) {
      if ((scene.views.bits[base + (r >>> 5)] & (1 << (r & 31))) === 0) continue
      const slot = scene.views.order[r]!
      if ((scene.views.nodeFlags[slot] & 1) === 0) continue
      expected.push([slot, r])
    }
    const got: Array<[number, number]> = []
    scene.forEachVisible(0, (slot, rank) => got.push([slot, rank]), { bufferIndex: 0 })
    expect(got).toEqual(expected)
    expect(got.length).toBeGreaterThan(0)
  })

  it('n exactly a multiple of 32 — the guarded last reload (no OOB word read)', () => {
    const scene = createScene({ capacity: 64, groupMax: 1 })
    for (let i = 0; i < 64; i++) {
      scene.create({ position: [i, 0, 0], sphere: [0, 0, 0, 0.5] })
    }
    scene.updateWorld()
    const cam = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 500)
    cam.setViewLookAt(32, 0, 60, 32, 0, 0, 0, 1, 0)
    scene.cull([cam], { bufferIndex: 0 })
    const seen: number[] = []
    scene.forEachVisible(0, (slot) => seen.push(slot), { bufferIndex: 0 })
    expect(seen.length).toBe(64)
    // And with the auto buffer after a DEFAULT cull (reader default tracking).
    scene.cull([cam])
    const seen2: number[] = []
    scene.forEachVisible(0, (slot) => seen2.push(slot))
    expect(seen2.length).toBe(64)
  })
})

// ─── the snapshot reuse ring (a real worker) ────────────────────────────────
describe('Task 182: bridge snapshotReuse — the ring of two slots', () => {
  function bunPort(worker: Worker) {
    return {
      postMessage: (message: unknown) => worker.postMessage(message),
      onMessage: (handler: (message: unknown) => void) => { worker.on('message', handler) },
      terminate: () => worker.terminate(),
    }
  }

  it('alternating slots, live-sized bits, content parity, stale = same object', async () => {
    const worker = new Worker(new URL('./sceneWorkerEntry.ts', import.meta.url))
    try {
      const opts = { capacity: 256, cameraMax: 1, groupMax: 2, maxInstances: 256, shared: true } as const
      // The T0 reference: the same topology, computed on main.
      const reference = createScene(opts)
      const buildTopology = (scene: Scene) => {
        for (let i = 0; i < 60; i++) {
          scene.create({
            position: [i * 2, 0, 0],
            sphere: [0, 0, 0, 1],
            group: i % 2,
          })
        }
      }
      buildTopology(reference)

      const mirror = createScene({ ...opts, shared: true })
      buildTopology(mirror)
      const bridge = createSceneWorkerBridge({ scene: mirror, worker: bunPort(worker), snapshotReuse: true })
      await bridge.ready

      const runT0 = (yaw: number) => {
        const cam = mkCam(yaw, 30)
        reference.updateWorld()
        reference.refitGroupBounds()
        reference.cull([cam])
        reference.collectInstances(0)
        return cam
      }

      const cam1 = runT0(0.2)
      bridge.publish([cam1])
      const snap1 = await bridge.waitFresh(4000)
      expect(snap1).not.toBeNull()
      // Live-sized bits: ceil(n/32) words, not the capacity-sized words.
      expect(snap1!.bits[0]!.length).toBe((60 + 31) >>> 5)
      expect(snap1!.bits[0]!.length).toBeLessThan(reference.views.bitsWords)
      // Content parity with the T0 reference.
      const t0g0 = reference.instances(0)
      expect(t0g0.count).toBeGreaterThan(0)
      expect(snap1!.instances[0]![0]!.count).toBe(t0g0.count)
      for (let i = 0; i < t0g0.count * 16; i++) {
        expect(snap1!.instances[0]![0]!.matrices[i]).toBeCloseTo(t0g0.matrices[i]!, 6)
      }

      const cam2 = runT0(2.4) // the camera turned — visibility changes
      bridge.publish([cam2])
      const snap2 = await bridge.waitFresh(4000)
      expect(snap2!.epoch).toBe(2)
      // Different ring slots → different backing memory.
      expect(snap2!.instances[0]![0]!.matrices.buffer).not.toBe(snap1!.instances[0]![0]!.matrices.buffer)

      const cam3 = runT0(0.9)
      bridge.publish([cam3])
      const snap3 = await bridge.waitFresh(4000)
      expect(snap3!.epoch).toBe(3)
      // The ring wrapped: the third fresh take reuses the FIRST slot's memory.
      expect(snap3!.instances[0]![0]!.matrices.buffer).toBe(snap1!.instances[0]![0]!.matrices.buffer)
      // And its content is the epoch-3 data (not a stale copy of epoch 1).
      const t0g0e3 = reference.instances(0)
      expect(snap3!.instances[0]![0]!.count).toBe(t0g0e3.count)
      for (let i = 0; i < t0g0e3.count * 16; i++) {
        expect(snap3!.instances[0]![0]!.matrices[i]).toBeCloseTo(t0g0e3.matrices[i]!, 6)
      }

      // A stale take returns the LAST fresh snapshot object, untouched.
      const stale = bridge.take()
      expect(stale).toBe(snap3)
      expect(bridge.stats().published).toBe(3)
      await bridge.dispose()
    } finally {
      // dispose() already terminates the worker.
    }
  }, 20000)
})
