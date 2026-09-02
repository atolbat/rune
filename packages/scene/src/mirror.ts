/**
 * mirror.ts — the "main ↔ scene worker" bridge (Task 81).
 *
 * Frame splitting (the protocol from worker.ts):
 *   1. main writes locals/structure (the Scene API — straight into the SAB) and cameras;
 *   2. publish(cameras): planes → SAB, inputEpoch++ (a seq-cst atomic);
 *   3. the worker wakes, runs runScenePipeline into the buffer (epoch & 1),
 *      sets outputEpoch = epoch;
 *   4. main calls take(): if outputEpoch has advanced — a snapshot of the new
 *      buffer (copies of the bitsets and instance segments: the bitsets/pools
 *      are double, the worker is already writing the NEXT buffer — tearing is
 *      impossible); if not — a snapshot of the previous fresh epoch (latency
 *      +1 frame, WITHOUT blocking main and without degradation: the render
 *      always has consistent data).
 *
 * A snapshot is plain ArrayBuffer copies: these are ready GPU upload buffers
 * (instance attributes), not "extra" work.
 */
import type { Camera } from './camera.ts'
import type { Scene } from './scene.ts'
import type { SceneViews } from './layout.ts'
import {
  CMD_STOP,
  H_CAMERA_COUNT,
  H_CMD_FLAGS,
  H_GROUP_COUNT,
  H_INPUT_EPOCH,
  H_INSTANCE_POOL,
  H_OUTPUT_EPOCH,
  H_STALE_TAKES,
} from './layout.ts'
import { bitsBase } from './culling.ts'

/** A minimal worker port (bun worker_threads and the browser Worker). */
export interface SceneWorkerPort {
  postMessage(message: unknown): void
  onMessage(handler: (message: unknown) => void): void
  terminate?(): void | Promise<unknown>
}

/** A consistent snapshot of one epoch's visibility. */
export interface SceneSnapshot {
  readonly epoch: number
  readonly cameraCount: number
  /** Visibility bitsets (rank space), copies. */
  readonly bits: readonly Uint32Array[]
  /** Instance segments per camera and group: instances[camera][group]. */
  readonly instances: ReadonlyArray<ReadonlyArray<{ matrices: Float32Array; count: number }>>
}

export interface SceneWorkerBridgeStats {
  readonly published: number
  readonly freshTakes: number
  readonly staleTakes: number
}

export interface SceneWorkerBridge {
  /** Resolves after "scene-ready" from the worker. */
  readonly ready: Promise<void>
  /** Publish a frame (the locals are already in the SAB via the Scene API). */
  publish(cameras: readonly Camera[]): number
  /** Take the consistent result (null — before the first fresh frame). */
  take(): SceneSnapshot | null
  /** Wait for a fresh snapshot (startup/tests); null on timeout. */
  waitFresh(timeoutMs: number): Promise<SceneSnapshot | null>
  stats(): SceneWorkerBridgeStats
  dispose(): Promise<void>
}

const EMPTY_MATRICES = new Float32Array(0)

/** Create a bridge for a SAB scene and a worker running runSceneWorker. */
export function createSceneWorkerBridge(options: {
  scene: Scene
  worker: SceneWorkerPort
}): SceneWorkerBridge {
  const { scene, worker } = options
  const views = scene.views
  if (scene.backing !== 'shared') {
    throw new Error('scene: the bridge needs a SAB scene (createScene({ shared: true }))')
  }

  let published = 0
  let freshTakes = 0
  let staleTakes = 0
  let lastSnapshot: SceneSnapshot | null = null
  let lastSnapshotEpoch = 0
  let disposed = false

  const ready = new Promise<void>((resolve) => {
    worker.onMessage((message) => {
      const m = message as { type?: string }
      if (m?.type === 'scene-ready') resolve()
    })
    worker.postMessage({ type: 'scene-init', sab: views.buffer })
  })

  function snapshot(views: SceneViews, epoch: number): SceneSnapshot {
    const cameraCount = views.headerI[H_CAMERA_COUNT]
    const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
    const bufferIndex = epoch & 1
    const bits: Uint32Array[] = []
    const instances: Array<Array<{ matrices: Float32Array; count: number }>> = []
    for (let k = 0; k < cameraCount; k++) {
      const base = bitsBase(views, bufferIndex, k)
      bits.push(views.bits.slice(base, base + views.bitsWords))
      const perCamera: Array<{ matrices: Float32Array; count: number }> = []
      const countsBase = (bufferIndex * views.cameraMax + k) * views.groupMax
      const poolBase = (bufferIndex * views.cameraMax + k) * views.headerI[H_INSTANCE_POOL] * 16
      for (let g = 0; g < groupCount; g++) {
        const count = Math.max(0, views.instCounts[countsBase + g])
        if (count === 0) {
          perCamera.push({ matrices: EMPTY_MATRICES, count: 0 })
          continue
        }
        const offset = views.instOffsets[countsBase + g]
        const pool = views.instPool
        perCamera.push({
          matrices: pool.slice(
            poolBase + offset * 16,
            poolBase + (offset + count) * 16,
          ),
          count,
        })
      }
      instances.push(perCamera)
    }
    return { epoch, cameraCount, bits, instances }
  }

  return {
    ready,
    publish(cameras) {
      if (disposed) throw new Error('scene: the bridge is already closed')
      if (scene.layoutDirty) scene.pack()
      const count = Math.min(cameras.length, views.cameraMax)
      for (let k = 0; k < count; k++) {
        const planes = cameras[k]!.planes
        // Task 87: no per-camera subarray view every frame
        if (planes.length === 24) views.planes.set(planes, k * 24)
        else views.planes.set(planes.subarray(0, 24), k * 24)
      }
      views.headerI[H_CAMERA_COUNT] = count
      published++
      Atomics.store(views.headerI, H_INPUT_EPOCH, published)
      Atomics.notify(views.headerI, H_INPUT_EPOCH)
      return published
    },
    take() {
      const output = Atomics.load(views.headerI, H_OUTPUT_EPOCH)
      if (output > 0 && output !== lastSnapshotEpoch) {
        lastSnapshot = snapshot(views, output)
        lastSnapshotEpoch = output
        freshTakes++
        return lastSnapshot
      }
      staleTakes++
      views.headerI[H_STALE_TAKES] += 1
      return lastSnapshot
    },
    async waitFresh(timeoutMs) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const snap = this.take()
        if (snap !== null && snap.epoch === published) return snap
        if (Date.now() >= deadline) return snap
        await new Promise((r) => setTimeout(r, 1))
      }
    },
    stats() {
      return { published, freshTakes, staleTakes }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      const flags = Atomics.load(views.headerI, H_CMD_FLAGS)
      Atomics.store(views.headerI, H_CMD_FLAGS, flags | CMD_STOP)
      Atomics.notify(views.headerI, H_INPUT_EPOCH)
      // The worker exits the wait loop by itself; terminate — with a timeout race
      // (bun terminate may not resolve while the thread sleeps in a futex).
      await Promise.race([
        new Promise((r) => setTimeout(r, 100)),
        Promise.resolve(worker.terminate?.()).then(() => undefined, () => undefined),
      ]).then(() => undefined)
    },
  }
}
