/**
 * worker.ts — кадровый конвейер сцены и точка входа воркера (Task 81).
 *
 * runScenePipeline — ЕДИНЫЙ кадр конвейера: updateWorld → refit → cull →
 * instances. Вызывается и main-потоком (T0), и воркером (T1/T2) — паритет
 * по построению, разница только в том, КТО вызвал.
 *
 * runSceneWorker — цикл воркера: спит на Atomics.wait(H_INPUT_EPOCH),
 * просыпается на publish(), исполняет конвейер в буфер (epoch & 1),
 * публикует H_OUTPUT_EPOCH. Останов — CMD_STOP в H_CMD_FLAGS + notify
 * (мост dispose()).
 *
 * Протокол честности кадра: main пишет локали/структуру/камеры ТОЛЬКО до
 * Atomics.store(H_INPUT_EPOCH); воркер читает их ТОЛЬКО после пробуждения;
 * main читает битсеты/пулы ТОЛЬКО после H_OUTPUT_EPOCH == опубликованной
 * эпохе. Двухбуферность пулов исключает tearing между соседними эпохами.
 */
import type { SceneViews } from './layout.ts'
import { buildSceneViews } from './layout.ts'
import {
  CMD_CULL,
  CMD_INSTANCES,
  CMD_REFIT,
  CMD_STOP,
  CMD_UPDATE_WORLD,
  H_CAMERA_COUNT,
  H_CMD_FLAGS,
  H_INPUT_EPOCH,
  H_OUTPUT_EPOCH,
} from './layout.ts'
import { cullViewsHierarchical } from './culling.ts'
import { collectInstancesViews } from './instances.ts'
import { refitGroupBoundsViews, updateWorldViews } from './transforms.ts'

/**
 * Один кадр конвейера сцены в буфер bufferIndex (0/1).
 * Возвращает суммарное время фаз (мс) для диагностики.
 */
export function runScenePipeline(views: SceneViews, bufferIndex: number): number {
  const headerI = views.headerI
  const cmd = headerI[H_CMD_FLAGS]
  const t0 = now()
  if ((cmd & CMD_UPDATE_WORLD) !== 0) updateWorldViews(views)
  if ((cmd & CMD_REFIT) !== 0) refitGroupBoundsViews(views)
  if ((cmd & CMD_CULL) !== 0) {
    const cameras = headerI[H_CAMERA_COUNT]
    for (let k = 0; k < cameras; k++) cullViewsHierarchical(views, k, bufferIndex)
  }
  if ((cmd & CMD_INSTANCES) !== 0) {
    const cameras = headerI[H_CAMERA_COUNT]
    for (let k = 0; k < cameras; k++) collectInstancesViews(views, k, bufferIndex)
  }
  return now() - t0
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** Хуки наблюдения за воркером (диагностика/тесты). */
export interface SceneWorkerHooks {
  /** Вызывается после каждого обработанного кадра. */
  onFrame?(epoch: number, frameMs: number): void
}

/** Запуск воркера сцены (вызывается ВНУТРИ потока воркера). */
export function runSceneWorker(
  sab: SharedArrayBuffer,
  hooks: SceneWorkerHooks = {},
): { stop(): void } {
  const views = buildSceneViews(sab)
  const headerI = views.headerI
  let stopped = false
  let lastInput = Atomics.load(headerI, H_INPUT_EPOCH)

  const handle = {
    stop() {
      stopped = true
      Atomics.notify(headerI, H_INPUT_EPOCH)
    },
  }

  while (!stopped) {
    // Спим до смены inputEpoch. Notify может быть ПОТЕРЯН, если main
    // опубликовал кадр до входа воркера в wait — поэтому таймаут короткий,
    // а решение об обработке принимается по ЭПОХАМ (output < input), а не
    // по факту пробуждения: потерянный кадр подберётся через таймаут.
    Atomics.wait(headerI, H_INPUT_EPOCH, lastInput, 50)
    if (stopped) break
    if ((Atomics.load(headerI, H_CMD_FLAGS) & CMD_STOP) !== 0) break
    const input = Atomics.load(headerI, H_INPUT_EPOCH)
    const output = Atomics.load(headerI, H_OUTPUT_EPOCH)
    if (output >= input) {
      lastInput = input
      continue // этот кадр уже обработан
    }
    lastInput = input
    const frameMs = runScenePipeline(views, input & 1)
    Atomics.store(headerI, H_OUTPUT_EPOCH, input)
    hooks.onFrame?.(input, frameMs)
  }
  return handle
}
