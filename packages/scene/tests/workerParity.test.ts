/**
 * Scene worker parity: a REAL bun worker (SAB + Atomics.wait)
 * vs the T0 pipeline in main. The same input — consistent
 * worlds/bitsets/instance matrices (transport invariant §7.2).
 */
import { describe, expect, it } from 'bun:test'
import { Worker } from 'node:worker_threads'
import { createCamera, createScene, createSceneWorkerBridge } from '../src/index.ts'
import type { Scene } from '../src/index.ts'

/** Bun worker port adapted to the bridge interface. */
function bunPort(worker: Worker) {
  return {
    postMessage: (message: unknown) => worker.postMessage(message),
    onMessage: (handler: (message: unknown) => void) => {
      worker.on('message', handler)
    },
    terminate: () => worker.terminate(),
  }
}

/** The same topology on any scene (determinism → identical slots/ranks). */
function buildTopology(scene: Scene): void {
  const root = scene.create({ position: [0, 0, 0] })
  for (let i = 0; i < 40; i++) {
    const x = ((i % 8) - 4) * 4
    const z = (Math.floor(i / 8) - 2.5) * 4
    scene.create({
      parent: i % 3 === 0 ? root : undefined,
      position: [x, 0, z],
      sphere: [0, 0, 0, 1.2],
      group: 0,
      payload: i,
    })
  }
  const a = scene.create({ position: [10, 0, 0], parent: root })
  scene.create({ parent: a, position: [0, 2, 0], sphere: [0, 0, 0, 1], group: 1 })
}

function popcount(words: Uint32Array): number {
  let count = 0
  for (let i = 0; i < words.length; i++) {
    let v = words[i]
    while (v !== 0) { v &= v - 1; count++ }
  }
  return count
}

const OPTS = { capacity: 512, cameraMax: 1, groupMax: 4, maxInstances: 512 } as const

describe('scene worker (SAB, real thread)', () => {
  it('parity of worlds/bitsets/instances with the T0 pipeline', async () => {
    const worker = new Worker(new URL("./sceneWorkerEntry.ts", import.meta.url))
    try {
      // Reference: T0 in main.
      const reference = createScene(OPTS)
      buildTopology(reference)
      const cam = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 100)
      cam.setViewLookAt(0, 6, 18, 0, 0, 0, 0, 1, 0)
      reference.updateWorld()
      reference.refitGroupBounds()
      reference.cull([cam])
      reference.collectInstances(0)

      // Mirror: the same topology in a SAB + worker.
      const mirror = createScene({ ...OPTS, shared: true })
      buildTopology(mirror)
      const bridge = createSceneWorkerBridge({ scene: mirror, worker: bunPort(worker) })
      await bridge.ready
      bridge.publish([cam])
      const snap = await bridge.waitFresh(4000)
      expect(snap).not.toBeNull()
      expect(snap!.epoch).toBe(1)
      expect(snap!.cameraCount).toBe(1)

      // The worker consumed all dirt: local updateWorld recomputes 0 nodes.
      expect(mirror.updateWorld()).toBe(0)

      // World parity (same topology/positions → same matrices).
      for (let i = 0; i < reference.views.world.length; i++) {
        expect(Math.abs(mirror.views.world[i] - reference.views.world[i])).toBeLessThan(1e-6)
      }

      // Visibility parity.
      const t0Bits = reference.views.bits.subarray(0, reference.views.bitsWords)
      expect(popcount(snap!.bits[0])).toBe(popcount(t0Bits))
      expect(snap!.bits[0].length).toBe(reference.views.bitsWords)

      // Parity of group 0 instance matrices.
      const t0Seg = reference.instances(0, { cameraIndex: 0 })
      expect(snap!.instances[0][0].count).toBe(t0Seg.count)
      const wm = snap!.instances[0][0].matrices
      for (let i = 0; i < t0Seg.matrices.length; i++) {
        expect(Math.abs(wm[i] - t0Seg.matrices[i])).toBeLessThan(1e-6)
      }

      // Second epoch: the camera moved → a fresh snapshot with different visibility.
      cam.setViewLookAt(30, 6, 18, 0, 0, 0, 0, 1, 0)
      reference.updateWorld()
      reference.cull([cam])
      reference.collectInstances(0)
      bridge.publish([cam])
      const snap2 = await bridge.waitFresh(4000)
      expect(snap2!.epoch).toBe(2)
      expect(popcount(snap2!.bits[0])).toBe(popcount(reference.views.bits.subarray(0, reference.views.bitsWords)))
      expect(snap2!.instances[0][0].count).toBe(reference.instances(0, { cameraIndex: 0 }).count)

      const stats = bridge.stats()
      expect(stats.published).toBe(2)
      expect(stats.freshTakes).toBeGreaterThanOrEqual(2)
      await bridge.dispose()
    } finally {
      // dispose() already terminates the worker; a repeated await does not resolve in bun.
    }
  }, 20000)

  it('stale take does not block and returns the previous snapshot', async () => {
    const worker = new Worker(new URL("./sceneWorkerEntry.ts", import.meta.url))
    try {
      const scene = createScene({ capacity: 64, cameraMax: 1, groupMax: 2, maxInstances: 64, shared: true })
      scene.create({ position: [0, 0, 0], sphere: [0, 0, 0, 1], group: 0 })
      const bridge = createSceneWorkerBridge({ scene, worker: bunPort(worker) })
      await bridge.ready
      const cam = createCamera()
      expect(bridge.take()).toBeNull() // no snapshot before the first publish
      bridge.publish([cam])
      const snap = await bridge.waitFresh(4000)
      expect(snap).not.toBeNull()
      const again = bridge.take() // the worker already processed this epoch → stale
      expect(again).toBe(snap)
      expect(bridge.stats().staleTakes).toBeGreaterThanOrEqual(1)
      await bridge.dispose()
    } finally {
      // dispose() already terminates the worker.
    }
  }, 20000)
})
