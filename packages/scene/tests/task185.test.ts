/**
 * Task 185 tests — the bridge's ZERO-COPY view mode (snapshotViews):
 *   • the snapshot's bits and matrix segments are VIEWS straight into the
 *     scene's SAB (no ring, no copies, no big allocations — .buffer is the
 *     scene SAB itself);
 *   • content parity with the T0 reference (the same topology computed on
 *     main — the view reads exactly what the worker wrote);
 *   • THE publish×2 CONTRACT, pinned honestly: a view taken at epoch E is
 *     byte-stable through epoch E+1 (the OTHER buffer is being rewritten)
 *     and its content CHANGES once the worker starts E+2 — the same
 *     physical buffer returns into rotation. Consume within the frame (or
 *     the next) and it is always safe; the GPU upload path snapshots the
 *     bytes at queue.writeBuffer call time, so even the E+2 rewrite cannot
 *     tear an enqueued upload;
 *   • a stale take returns the previous snapshot object, untouched;
 *   • snapshotViews and snapshotReuse are mutually exclusive (views need
 *     no ring — the SAB's double buffer IS the ring).
 */
import { describe, expect, it } from 'bun:test'
import { Worker } from 'node:worker_threads'
import {
  createCamera,
  createScene,
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

describe('Task 185: bridge snapshotViews — the zero-copy SAB take', () => {
  const opts = { capacity: 256, cameraMax: 1, groupMax: 2, maxInstances: 256, shared: true } as const

  function buildTopology(scene: Scene) {
    for (let i = 0; i < 60; i++) {
      scene.create({
        position: [i * 2, 0, 0],
        sphere: [0, 0, 0, 1],
        group: i % 2,
      })
    }
  }

  it('views INTO the SAB, content parity with T0, live-sized bits, stale = same object', async () => {
    const worker = new Worker(new URL('./sceneWorkerEntry.ts', import.meta.url))
    // The T0 reference: the same topology, computed on main.
    const reference = createScene(opts)
    buildTopology(reference)

    const mirror = createScene({ ...opts, shared: true })
    buildTopology(mirror)
    const sab = mirror.views.buffer
    const bridge = createSceneWorkerBridge({ scene: mirror, worker: bunPort(worker), snapshotViews: true })
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
    // THE ZERO-COPY PIN: the bits and matrices are views into the SCENE SAB
    // (a copy or a ring row would live in its own ArrayBuffer).
    expect(snap1!.bits[0]!.buffer).toBe(sab)
    expect(snap1!.instances[0]![0]!.matrices.buffer).toBe(sab)
    expect(snap1!.instances[0]![1]!.matrices.buffer).toBe(sab)
    // Live-sized bits: ceil(n/32) words, not capacity-sized words.
    expect(snap1!.bits[0]!.length).toBe((60 + 31) >>> 5)
    // Content parity with the T0 reference.
    const t0g0 = reference.instances(0)
    expect(t0g0.count).toBeGreaterThan(0)
    expect(snap1!.instances[0]![0]!.count).toBe(t0g0.count)
    const snap1CountFrozen = t0g0.count
    for (let i = 0; i < t0g0.count * 16; i++) {
      expect(snap1!.instances[0]![0]!.matrices[i]).toBeCloseTo(t0g0.matrices[i]!, 6)
    }

    // The publish×2 window, phase 1: ONE more publish — the view stays
    // byte-stable (the worker rewrites the OTHER physical buffer).
    const before = Array.from(snap1!.instances[0]![0]!.matrices)
    const cam2 = runT0(2.4)
    bridge.publish([cam2])
    await bridge.waitFresh(4000) // epoch 2 — the OTHER buffer
    expect(Array.from(snap1!.instances[0]![0]!.matrices)).toEqual(before)

    // Phase 2: the publish AFTER that (epoch 3) — the same physical buffer
    // returns into rotation and the HELD view's content changes under it.
    // This is the honest hazard pin: the held snapshot's count FIELD stays
    // frozen (its epoch-1 number), but the VIEW's bytes are the same live
    // memory the epoch-3 take reads — "consume within the frame" is on you.
    const cam3 = runT0(0.9)
    bridge.publish([cam3])
    const snap3 = await bridge.waitFresh(4000)
    expect(snap3!.epoch).toBe(3)
    // epoch 1 and epoch 3 share the physical buffer (1&1) — the held view
    // and the fresh take of epoch 3 read the SAME memory: the held view's
    // current bytes equal the epoch-3 segment's prefix over the frozen window.
    expect(snap3!.instances[0]![0]!.matrices.buffer).toBe(sab)
    const held = snap1!.instances[0]![0]!.matrices
    const fresh = snap3!.instances[0]![0]!.matrices
    const overlap = Math.min(held.length, fresh.length)
    for (let i = 0; i < overlap; i++) {
      expect(held[i]).toBe(fresh[i])
    }
    // The count FIELD of the held snapshot is frozen at its own epoch's
    // number (7 at yaw 0.2 — the number never tracks the live view).
    expect(held.length).toBe(snap1CountFrozen * 16)

    // A stale take returns the LAST fresh snapshot object, untouched.
    const stale = bridge.take()
    expect(stale).toBe(snap3)
    expect(bridge.stats().published).toBe(3)
    await bridge.dispose()
  }, 20000)

  it('snapshotViews and snapshotReuse are mutually exclusive', async () => {
    const worker = new Worker(new URL('./sceneWorkerEntry.ts', import.meta.url))
    try {
      const mirror = createScene({ ...opts, shared: true })
      buildTopology(mirror)
      expect(() => createSceneWorkerBridge({
        scene: mirror,
        worker: bunPort(worker),
        snapshotReuse: true,
        snapshotViews: true,
      })).toThrow('mutually exclusive')
    } finally {
      await worker.terminate()
    }
  })
})
