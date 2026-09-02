/**
 * worker.ts — the scene frame pipeline and the worker entry point (Task 81).
 *
 * runScenePipeline — ONE pipeline frame: updateWorld → refit → cull →
 * instances. Called both by the main thread (T0) and by the worker (T1/T2) —
 * parity by construction, the only difference is WHO called it.
 *
 * runSceneWorker — the worker loop: sleeps on Atomics.wait(H_INPUT_EPOCH),
 * wakes on publish(), runs the pipeline into buffer (epoch & 1),
 * publishes H_OUTPUT_EPOCH. Stop — CMD_STOP in H_CMD_FLAGS + notify
 * (bridge dispose()).
 *
 * Frame honesty protocol: main writes locals/structure/cameras ONLY before
 * Atomics.store(H_INPUT_EPOCH); the worker reads them ONLY after waking;
 * main reads bitsets/pools ONLY after H_OUTPUT_EPOCH == the published
 * epoch. Double buffering of pools rules out tearing between adjacent epochs.
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
 * One scene pipeline frame into buffer bufferIndex (0/1).
 * Returns the total time of the phases (ms) for diagnostics.
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

/** Hooks for observing the worker (diagnostics/tests). */
export interface SceneWorkerHooks {
  /** Called after each processed frame. */
  onFrame?(epoch: number, frameMs: number): void
}

/** Start the scene worker (called INSIDE the worker thread). */
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
    // Sleep until inputEpoch changes. A notify can be LOST if main
    // published a frame before the worker entered wait — hence the short
    // timeout, and the decision to process is made by EPOCHS (output < input),
    // not by the fact of waking: a lost frame will be picked up via the timeout.
    Atomics.wait(headerI, H_INPUT_EPOCH, lastInput, 50)
    if (stopped) break
    if ((Atomics.load(headerI, H_CMD_FLAGS) & CMD_STOP) !== 0) break
    const input = Atomics.load(headerI, H_INPUT_EPOCH)
    const output = Atomics.load(headerI, H_OUTPUT_EPOCH)
    if (output >= input) {
      lastInput = input
      continue // this frame is already processed
    }
    lastInput = input
    const frameMs = runScenePipeline(views, input & 1)
    Atomics.store(headerI, H_OUTPUT_EPOCH, input)
    hooks.onFrame?.(input, frameMs)
  }
  return handle
}
