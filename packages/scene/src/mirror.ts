/**
 * mirror.ts — мост «main ↔ воркер сцены» (Task 81).
 *
 * Разделение кадра (протокол из worker.ts):
 *   1. main пишет локали/структуру (Scene API — прямо в SAB) и камеры;
 *   2. publish(cameras): плоскости → SAB, inputEpoch++ (seq-cst атомик);
 *   3. воркер просыпается, гоняет runScenePipeline в буфер (epoch & 1),
 *      ставит outputEpoch = epoch;
 *   4. main берёт take(): если outputEpoch подвинулся — снимок нового
 *      буфера (копии битсетов и инстанс-сегментов: битсеты/пулы двойные,
 *      воркер уже пишет СЛЕДУЮЩИЙ буфер — tearing невозможен); если нет —
 *      снимок предыдущей свежей эпохи (латентность +1 кадр, БЕЗ блокировки
 *      main и без деградации: рендер всегда имеет согласованные данные).
 *
 * Снимок — обычные ArrayBuffer-копии: это готовые буферы загрузки GPU
 * (instance-атрибуты), не «лишняя» работа.
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

/** Минимальный порт воркера (bun worker_threads и браузерный Worker). */
export interface SceneWorkerPort {
  postMessage(message: unknown): void
  onMessage(handler: (message: unknown) => void): void
  terminate?(): void | Promise<unknown>
}

/** Согласованный снимок видимости одной эпохи. */
export interface SceneSnapshot {
  readonly epoch: number
  readonly cameraCount: number
  /** Битсеты видимости (ранговое пространство), копии. */
  readonly bits: readonly Uint32Array[]
  /** Инстанс-сегменты по камерам и группам: instances[камера][группа]. */
  readonly instances: ReadonlyArray<ReadonlyArray<{ matrices: Float32Array; count: number }>>
}

export interface SceneWorkerBridgeStats {
  readonly published: number
  readonly freshTakes: number
  readonly staleTakes: number
}

export interface SceneWorkerBridge {
  /** Резолвится после «scene-ready» от воркера. */
  readonly ready: Promise<void>
  /** Опубликовать кадр (локали уже в SAB через Scene API). */
  publish(cameras: readonly Camera[]): number
  /** Снять согласованный результат (null — до первого свежего кадра). */
  take(): SceneSnapshot | null
  /** Подождать свежий снимок (старт/тесты); null по таймауту. */
  waitFresh(timeoutMs: number): Promise<SceneSnapshot | null>
  stats(): SceneWorkerBridgeStats
  dispose(): Promise<void>
}

const EMPTY_MATRICES = new Float32Array(0)

/** Создать мост для SAB-сцены и воркера, исполняющего runSceneWorker. */
export function createSceneWorkerBridge(options: {
  scene: Scene
  worker: SceneWorkerPort
}): SceneWorkerBridge {
  const { scene, worker } = options
  const views = scene.views
  if (scene.backing !== 'shared') {
    throw new Error('scene: мосту нужна SAB-сцена (createScene({ shared: true }))')
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
      if (disposed) throw new Error('scene: мост уже закрыт')
      if (scene.layoutDirty) scene.pack()
      const count = Math.min(cameras.length, views.cameraMax)
      for (let k = 0; k < count; k++) {
        const planes = cameras[k]!.planes
        // Task 87: без subarray- view на каждую камеру каждый кадр
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
      // Воркер выходит из wait-цикла сам; terminate — с гонкой таймаута
      // (bun-terminate может не резолвиться, пока поток спит в futex).
      await Promise.race([
        new Promise((r) => setTimeout(r, 100)),
        Promise.resolve(worker.terminate?.()).then(() => undefined, () => undefined),
      ]).then(() => undefined)
    },
  }
}
