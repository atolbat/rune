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
 * A snapshot is plain ArrayBuffer copies by default: these are ready GPU
 * upload buffers (instance attributes), not "extra" work. Task 182: (a)
 * the bits copy is live-sized (ceil(n/32) words — the capacity padding is
 * always zero); (b) snapshotReuse — a ring of two bridge-owned slots: the
 * big arrays are reused per fresh take (zero big-array churn; a snapshot's
 * memory lives until the fresh take after the next one). Task 185:
 * snapshotViews — ZERO copies: the snapshot hands out SAB views directly
 * (valid until publish×2 — the worker's own double-buffer rhythm), the
 * zero-copy upload source for writeExternalBuffer/syncVertexBuffer.
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
  H_NODE_COUNT,
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

/** A consistent snapshot of one epoch's visibility.
 * Task 182 — bits are copied LIVE-SIZED (ceil(n/32) words): the words above
 * the live node count are always zero (fillBits never writes beyond n),
 * copying them was pure bytes on the wire (capacity-sized copies on a
 * sparse scene paid up to bitsWords/liveWords× more).
 * Task 185 — snapshotViews: bits AND matrices are VIEWS into the worker's
 * SAB (zero copies; valid until publish×2 — see createSceneWorkerBridge). */
export interface SceneSnapshot {
  readonly epoch: number
  readonly cameraCount: number
  /** Visibility bitsets (rank space), live words only. With snapshotReuse:
   *  VIEWS into bridge-owned ring memory; with snapshotViews: VIEWS into
   *  the worker's SAB itself (see createSceneWorkerBridge). */
  readonly bits: readonly Uint32Array[]
  /** Instance segments per camera and group: instances[camera][group].
 *  With snapshotReuse: matrices are VIEWS into bridge-owned ring memory;
 *  with snapshotViews: VIEWS into the worker's SAB (publish×2 validity). */
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

/** One ring slot of the reuse mode (Task 182): the big buffers a snapshot
 * is built from. bits — cameraMax rows of bitsWords (fixed, tiny); matrices —
 * one geometrically grown row per camera (the total can never exceed
 * maxInstances — collect drops beyond it). */
interface SnapshotRingSlot {
  readonly bits: Uint32Array
  matrices: Float32Array[]
}

/** Create a bridge for a SAB scene and a worker running runSceneWorker.
 * Task 182 — snapshotReuse (default false): the fresh-take snapshots are built
 * in a RING of two slots — the bits/matrix MEMORY is bridge-owned and reused,
 * zero big-array allocations per frame (the old copy mode churned ~pool-sized
 * garbage per fresh take — at 100k instances that was megabytes per frame).
 * A snapshot's memory stays valid until the fresh take AFTER the next one
 * (the stale take in between returns the previous object, untouched). The
 * default mode keeps the old contract: every fresh take returns independent
 * copies (held snapshots stay valid forever).
 * Task 185 — snapshotViews (default false, mutually exclusive with
 * snapshotReuse): THE ZERO-COPY TAKE — the snapshot's bits and matrix
 * segments are VIEWS straight into the worker's double-buffered SAB (no
 * ring, no memcpy, no allocation at all). The contract is the double
 * buffer's own rhythm: a view taken at epoch E stays VALID (byte-stable)
 * until the worker starts epoch E+2 — the same physical buffer returns
 * into rotation two publishes later; "valid until publish×2". Consume
 * the view (upload it, read it) within the frame you took it — or the
 * next — and it is always safe; hold it longer and its CONTENT silently
 * changes under you. This is the mode for the zero-copy upload pattern:
 * writeExternalBuffer(gpuId, snap.instances[k][g].matrices) — the GPU
 * queue snapshots the bytes at call time (Task 185's probe verdict), so
 * even the E+2 rewrite cannot tear an already-enqueued upload. */
export function createSceneWorkerBridge(options: {
  scene: Scene
  worker: SceneWorkerPort
  /** Task 182 — ring-reuse of the snapshot memory (see above). */
  snapshotReuse?: boolean
  /** Task 185 — zero-copy SAB views (see above); exclusive with snapshotReuse. */
  snapshotViews?: boolean
}): SceneWorkerBridge {
  const { scene, worker } = options
  const views = scene.views
  if (scene.backing !== 'shared') {
    throw new Error('scene: the bridge needs a SAB scene (createScene({ shared: true }))')
  }
  if (options.snapshotViews === true && options.snapshotReuse === true) {
    throw new Error('scene: snapshotViews and snapshotReuse are mutually exclusive (views need no ring — the SAB is the ring)')
  }

  let published = 0
  let freshTakes = 0
  let staleTakes = 0
  let lastSnapshot: SceneSnapshot | null = null
  let lastSnapshotEpoch = 0
  let disposed = false
  // Task 182: the reuse ring — two slots, alternating per fresh take.
  const snapshotReuse = options.snapshotReuse === true
  // Task 185: the view mode — zero-copy SAB views (no ring, no copies).
  const snapshotViews = options.snapshotViews === true
  const ring: SnapshotRingSlot[] = snapshotReuse
    ? [
        { bits: new Uint32Array(views.cameraMax * views.bitsWords), matrices: [] },
        { bits: new Uint32Array(views.cameraMax * views.bitsWords), matrices: [] },
      ]
    : []
  let ringNext = 0

  const ready = new Promise<void>((resolve) => {
    worker.onMessage((message) => {
      const m = message as { type?: string }
      if (m?.type === 'scene-ready') resolve()
    })
    worker.postMessage({ type: 'scene-init', sab: views.buffer })
  })

  function snapshot(views: SceneViews, epoch: number, slot: number): SceneSnapshot {
    const cameraCount = views.headerI[H_CAMERA_COUNT]
    const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
    const bufferIndex = epoch & 1
    // Task 182: live words only — the padding above the node count is zero.
    const liveWords = (views.headerI[H_NODE_COUNT] + 31) >>> 5
    const bits: Uint32Array[] = []
    const instances: Array<Array<{ matrices: Float32Array; count: number }>> = []
    const ringSlot = slot >= 0 ? ring[slot] : undefined
    // Task 185 — the view mode flag: bits/pool segments become SAB views.
    const asViews = snapshotViews && ringSlot === undefined
    for (let k = 0; k < cameraCount; k++) {
      const base = bitsBase(views, bufferIndex, k)
      if (ringSlot !== undefined) {
        // Reuse: memcpy the live words into the ring row, hand out a view.
        ringSlot.bits.set(views.bits.subarray(base, base + liveWords), k * views.bitsWords)
        bits.push(ringSlot.bits.subarray(k * views.bitsWords, k * views.bitsWords + liveWords))
      } else if (asViews) {
        // Task 185 — ZERO-COPY: the bitset view straight into the SAB (the
        // worker's OTHER buffer is the one being rewritten; this one is
        // frozen until epoch+2 — the publish×2 contract).
        bits.push(views.bits.subarray(base, base + liveWords))
      } else {
        bits.push(views.bits.slice(base, base + liveWords))
      }
      const perCamera: Array<{ matrices: Float32Array; count: number }> = []
      const countsBase = (bufferIndex * views.cameraMax + k) * views.groupMax
      const poolBase = (bufferIndex * views.cameraMax + k) * views.headerI[H_INSTANCE_POOL] * 16
      const pool = views.instPool
      if (ringSlot !== undefined) {
        // The ring row's prefix offsets are pool-compatible (both are
        // 0-based prefix sums per camera) — segments land at the same
        // offsets, then hand out views.
        let total = 0
        for (let g = 0; g < groupCount; g++) total += Math.max(0, views.instCounts[countsBase + g])
        let row = ringSlot.matrices[k] ?? new Float32Array(0)
        if (row.length < total * 16) {
          row = new Float32Array(Math.max(total * 16, row.length * 2, 1024))
        }
        ringSlot.matrices[k] = row
        for (let g = 0; g < groupCount; g++) {
          const count = Math.max(0, views.instCounts[countsBase + g])
          if (count === 0) {
            perCamera.push({ matrices: EMPTY_MATRICES, count: 0 })
            continue
          }
          const offset = views.instOffsets[countsBase + g]
          const srcStart = poolBase + offset * 16
          row.set(pool.subarray(srcStart, srcStart + count * 16), offset * 16)
          perCamera.push({ matrices: row.subarray(offset * 16, offset * 16 + count * 16), count })
        }
      } else if (asViews) {
        // Task 185 — ZERO-COPY: the per-(camera, group) segments are
        // contiguous prefix-sum ranges of the camera's pool row — views,
        // not copies (instanceMatricesView's own shape). Same publish×2
        // validity contract as the bits above: this physical pool row is
        // frozen until the worker starts epoch E+2.
        for (let g = 0; g < groupCount; g++) {
          const count = Math.max(0, views.instCounts[countsBase + g])
          if (count === 0) {
            perCamera.push({ matrices: EMPTY_MATRICES, count: 0 })
            continue
          }
          const offset = views.instOffsets[countsBase + g]
          const srcStart = poolBase + offset * 16
          perCamera.push({ matrices: pool.subarray(srcStart, srcStart + count * 16), count })
        }
      } else {
        for (let g = 0; g < groupCount; g++) {
          const count = Math.max(0, views.instCounts[countsBase + g])
          if (count === 0) {
            perCamera.push({ matrices: EMPTY_MATRICES, count: 0 })
            continue
          }
          const offset = views.instOffsets[countsBase + g]
          const srcStart = poolBase + offset * 16
          perCamera.push({
            matrices: pool.slice(srcStart, srcStart + count * 16),
            count,
          })
        }
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
        // Task 182: the reuse ring alternates slots per fresh take — the
        // previous fresh snapshot's memory is never the target.
        // Task 185: the view mode passes slot -1 as well (no ring) — the
        // snapshot builder's own snapshotViews flag routes to SAB views.
        const slot = snapshotReuse ? (ringNext ^= 1) : -1
        lastSnapshot = snapshot(views, output, slot)
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
