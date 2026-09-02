/**
 * strategy.ts — when to offload the scene to a worker (Task 81).
 *
 * No dogmas — only measured constants (bench.ts of this package,
 * bun 1.3.14, a 4-core container; on other hardware re-calibrate
 * measureScenePipeline). The main measured facts:
 *
 *   • the dirty pipeline is nearly free at rest: 100k nodes = 0.5 ms;
 *   • the full pipeline with animation: ~160 ns per animated node + ~5 ns per node;
 *   • bridge synchronization (publish+take) ≈ 1 µs — not an argument;
 *   • BUT worker latency (wake+pipeline+poll) is 1.3–2 ms at
 *     ≤100k nodes and ~12 ms at 1M — by wall-clock the worker is MORE
 *     EXPENSIVE than a local run (the in-thread pipeline is ~2.5× slower + wake);
 *   • overlap works: with 3 ms of main work the worker makes it in 90% of frames
 *     at ≤100k nodes; at 1M it does not (0%).
 *
 * Conclusion (honest): the worker is NOT about reducing frame latency, but
 * about freeing main-thread time when the pipeline costs more than ~1 ms AND
 * main is busy with other work (rendering/GPU submits). Below the threshold — T0 locally.
 *
 * Honesty rule: without a SAB (isolation not granted) the scene worker is
 * unavailable — recommendation T0, as in the core transport ladder (§7.2).
 */
import type { Camera } from './camera.ts'
import type { Scene } from './scene.ts'

/** Static part of the pipeline per node, ns (updateWorld checks+refit+cull). */
export const STATIC_NS_PER_NODE = 5.4

/** Animation part: setLocalTR + world-chain recomputation, ns/node. */
export const ANIMATED_NS_PER_NODE = 160

/** Instance compaction, ns (at ~50% visibility). */
export const INSTANCE_NS = 20

/** Bridge synchronization (publish+take), ms — practically free. */
export const WORKER_SYNC_MS = 0.002

/** The pipeline in a worker is slower than local (measured at 100k–1M). */
export const WORKER_PIPELINE_INFLATION = 2.5

/** Minimum main-time gain at which the worker "makes sense". */
export const MIN_GAIN_MS = 1.0

export interface SceneStrategyInputs {
  /** Live scene nodes. */
  readonly nodeCount: number
  /** Nodes whose local TRS changes every frame. */
  readonly animatedNodes: number
  /** Visible instances per frame (all cameras). */
  readonly visibleInstances?: number
  readonly cameraCount: number
  /** Whether SAB + worker are available. */
  readonly workerAvailable: boolean
  /** Frame budget, ms (default 16.7). */
  readonly frameBudgetMs?: number
}

export interface SceneStrategy {
  readonly offloadToWorker: boolean
  /** Honest explanation of the decision (for logs/diagnostics). */
  readonly reason: string
  /** Estimated main cost of the pipeline, ms. */
  readonly estimatedPipelineMs: number
  /** Estimated worker time for the same pipeline, ms. */
  readonly estimatedWorkerMs: number
}

/** Estimate of the pipeline cost (ms) from the measured model. */
export function estimatePipelineMs(inputs: SceneStrategyInputs): number {
  const cameras = Math.max(1, inputs.cameraCount)
  const visible = inputs.visibleInstances ?? 0
  const base =
    inputs.nodeCount * STATIC_NS_PER_NODE +
    inputs.animatedNodes * ANIMATED_NS_PER_NODE +
    visible * INSTANCE_NS
  // cull is linear in cameras, transforms are not.
  return (base * (1 + (cameras - 1) * 0.35)) / 1e6
}

/** Recommendation: whether to offload the scene pipeline to a worker. */
export function recommendSceneStrategy(inputs: SceneStrategyInputs): SceneStrategy {
  const budget = inputs.frameBudgetMs ?? 16.7
  const pipelineMs = estimatePipelineMs(inputs)
  const workerMs = pipelineMs * WORKER_PIPELINE_INFLATION + 1.3 // + wake/poll

  if (!inputs.workerAvailable) {
    return {
      offloadToWorker: false,
      reason: 'SAB/worker unavailable — T0 pipeline (core transport ladder)',
      estimatedPipelineMs: pipelineMs,
      estimatedWorkerMs: workerMs,
    }
  }
  if (pipelineMs < WORKER_SYNC_MS + MIN_GAIN_MS) {
    return {
      offloadToWorker: false,
      reason: `pipeline ~${pipelineMs.toFixed(2)} ms < threshold ${MIN_GAIN_MS} ms: synchronization and latency do not pay off, local is cheaper`,
      estimatedPipelineMs: pipelineMs,
      estimatedWorkerMs: workerMs,
    }
  }
  if (workerMs > budget) {
    return {
      offloadToWorker: false,
      reason: `worker needs ~${workerMs.toFixed(1)} ms > frame budget ${budget} ms: the thread cannot make it in time, overlap impossible`,
      estimatedPipelineMs: pipelineMs,
      estimatedWorkerMs: workerMs,
    }
  }
  return {
    offloadToWorker: true,
    reason: `pipeline ~${pipelineMs.toFixed(2)} ms: the worker frees main (handles it in ~${workerMs.toFixed(1)} ms < ${budget} ms), overlap with rendering`,
    estimatedPipelineMs: pipelineMs,
    estimatedWorkerMs: workerMs,
  }
}

/**
 * Calibration on a live scene: median pipeline run time (ms).
 * Use it for an automatic decision on the user's hardware.
 */
export function measureScenePipeline(
  scene: Scene,
  cameras: readonly Camera[],
  opts: { runs?: number } = {},
): number {
  const runs = opts.runs ?? 7
  scene.pack()
  // JIT + dirt warm-up. cull(reuse): the numbers are not read here — the
  // scratch result keeps the measured frames allocation-free (Task 113).
  for (let i = 0; i < runs; i++) {
    scene.updateWorld()
    scene.refitGroupBounds()
    scene.cull(cameras, { reuse: true })
    for (let k = 0; k < cameras.length; k++) scene.collectInstances(k)
  }
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    scene.updateWorld()
    scene.refitGroupBounds()
    scene.cull(cameras, { reuse: true })
    for (let k = 0; k < cameras.length; k++) scene.collectInstances(k)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)]
}
