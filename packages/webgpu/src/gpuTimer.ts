/**
 * GpuTimer — WebGPU implementation via the timestamp-query feature.
 *
 * Contract (GpuTimer from @rune/core):
 *  - begin(): called in StatsCollector.beginFrame ( BEFORE frame rendering).
 *    Maps the previous frame's readBuffer (if there is a pending resolve)
 *    and reads the result asynchronously into lastResult.
 *  - end(): noop at the timer level — actually writeTimestamp(END) is done
 *    by GPUFacade via GpuTimerHandle.onEndPass at endPass(). Here it is
 *    a noop to stay compatible with the WebGL2 timer interface (where
 *    end() also closes the query).
 *  - result(): returns lastResult (ms) or null if:
 *    • first frame (no pending resolve)
 *    • GPU device lost
 *    • mapAsync failed
 *    • feature unavailable
 *
 * WebGPU timestamp-query — asynchronous:
 *   frame N: writeTimestamp(BEGIN) in beginPass → draw → writeTimestamp(END) in endPass
 *           → resolveQuerySet(BEGIN..END → resolveBuffer) in submit
 *           → copyBuffer resolveBuffer → readBuffer
 *   frame N+1: begin() triggers mapAsync on readBuffer → reads 2 BigInt64
 *             (start_ns, end_ns) → gpuMs = (end - start) / 1e6
 *
 * Limitations:
 *  - Chrome 113+ supports timestamp-query (not on all platforms).
 *  - In headless tests (mock GPUDevice) — no feature, createGpuGpuTimer
 *    returns null.
 *  - mapAsync is async, the result arrives via microtasks. If by the time
 *    result() is called the map is not finished — we return the previous
 *    lastResult (or null).
 */

import type { GpuTimer } from '@rune/core'

/** Handle that GPUFacade invokes at the right moments for writeTimestamp.
 *  WebGpuTimer itself implements both GpuTimer (core) and GpuTimerHandle. */
export interface GpuTimerHandle {
  /** Called by GPUFacade after beginRenderPass. Writes the BEGIN stamp into the pass.
   *  pass.writeTimestamp(querySet, BEGIN_INDEX). */
  onBeginPass(pass: GPURenderPassEncoder): void
  /** Called by GPUFacade BEFORE pass.end(). Writes the END stamp into the pass. */
  onEndPass(pass: GPURenderPassEncoder): void
  /** Called by GPUFacade BEFORE encoder.finish() (in submit). resolveQuerySet +
   *  copyBuffer. Without this, timestamps stay in the querySet and are
   *  inaccessible to the CPU. */
  onSubmit(encoder: GPUCommandEncoder): void
}

/** Creates a WebGPU GpuTimer if the device has the 'timestamp-query' feature.
 *  Otherwise returns null — caps.has('timestamp-query') will be false,
 *  the renderer does not wire the timer, gpuMs = null in stats.
 *
 * @param device — a real GPUDevice (not a mock; a mock returns null).
 */
export function createGpuGpuTimer(device: GPUDevice): { timer: GpuTimer; handle: GpuTimerHandle } | null {
  // Check the feature via try/catch — features.has may throw on older browsers.
  try {
    if (!device.features.has('timestamp-query' as GPUFeatureName)) return null
  } catch {
    return null
  }

  // 2 timestamp slots: BEGIN (0) and END (1).
  let querySet: GPUQuerySet
  try {
    querySet = device.createQuerySet({ type: 'timestamp', count: 2 })
  } catch {
    return null
  }

  // GPUBufferUsage — a global browser enum (Chrome 113+). In a headless
  // environment without WebGPU it is absent. The numeric fallbacks are
  // taken from the WebGPU spec
  // (GPUBufferUsage.{MAP_READ=0x1, COPY_DST=0x8, COPY_SRC=0x4, QUERY_RESOLVE=0x20}).
  const MAP_READ = (globalThis as { GPUBufferUsage?: { MAP_READ?: number } }).GPUBufferUsage?.MAP_READ ?? 0x1
  const COPY_DST = (globalThis as { GPUBufferUsage?: { COPY_DST?: number } }).GPUBufferUsage?.COPY_DST ?? 0x8
  const COPY_SRC = (globalThis as { GPUBufferUsage?: { COPY_SRC?: number } }).GPUBufferUsage?.COPY_SRC ?? 0x4
  const QUERY_RESOLVE = (globalThis as { GPUBufferUsage?: { QUERY_RESOLVE?: number } }).GPUBufferUsage?.QUERY_RESOLVE ?? 0x20

  let resolveBuffer: GPUBuffer
  let readBuffer: GPUBuffer
  try {
    // resolveBuffer: GPUQuerySet → buffer (BigInt64Array × 2 = 16 bytes).
    // usage QUERY_RESOLVE + COPY_SRC: resolveQuerySet writes here, the copy —
    // into a second buffer for mapAsync.
    resolveBuffer = device.createBuffer({
      size: 16,
      usage: QUERY_RESOLVE | COPY_SRC,
    })
    // readBuffer: the final destination for CPU reading. mapAsync(READ) → ArrayBuffer.
    readBuffer = device.createBuffer({
      size: 16,
      usage: COPY_DST | MAP_READ,
    })
  } catch {
    return null
  }

  // GPUMapMode — a global browser enum. Absent in headless. READ = 0x1.
  const MAP_READ_MODE = (globalThis as { GPUMapMode?: { READ?: number } }).GPUMapMode?.READ ?? 0x1

  let lastResult: number | null = null
  let pendingResolve = false
  let mapping = false
  let alive = true

  // begin() — maps the previous frame's readBuffer. If the map completed —
  // read start_ns and end_ns as BigInt64, compute ms.
  function safeBegin(): void {
    if (!alive) return
    if (!pendingResolve || mapping) return
    mapping = true
    readBuffer.mapAsync(MAP_READ_MODE).then(() => {
      try {
        const view = new BigInt64Array(readBuffer.getMappedRange())
        const start = Number(view[0])
        const end = Number(view[1])
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          lastResult = (end - start) / 1e6
        }
        readBuffer.unmap()
      } catch {
        try { readBuffer.unmap() } catch { /* noop */ }
      } finally {
        mapping = false
        pendingResolve = false
      }
    }).catch(() => {
      mapping = false
      pendingResolve = false
      // device lost or map failed — deactivate
      alive = false
    })
  }

  function safeEnd(): void {
    // At the timer level — noop. The END stamp is written by GPUFacade via handle.onEndPass.
  }

  function safeResult(): number | null {
    if (!alive) return null
    return lastResult
  }

  // ─── GpuTimerHandle implementation ─────────────────────────────────────────
  function onBeginPass(pass: GPURenderPassEncoder): void {
    if (!alive) return
    try {
      // writeTimestamp on the pass — between beginRenderPass and any draw.
      // BEGIN_INDEX = 0.
      ;(pass as unknown as { writeTimestamp: (set: GPUQuerySet, idx: number) => void })
        .writeTimestamp(querySet, 0)
    } catch {
      // Some browsers have the feature but did not implement writeTimestamp on the pass.
      // Deactivate — the result will be null.
      alive = false
    }
  }

  function onEndPass(pass: GPURenderPassEncoder): void {
    if (!alive) return
    try {
      ;(pass as unknown as { writeTimestamp: (set: GPUQuerySet, idx: number) => void })
        .writeTimestamp(querySet, 1)
    } catch {
      alive = false
    }
  }

  function onSubmit(encoder: GPUCommandEncoder): void {
    if (!alive) return
    try {
      // resolveQuerySet: querySet[0..2) → resolveBuffer, offset 0
      ;(encoder as unknown as {
        resolveQuerySet: (set: GPUQuerySet, first: number, count: number, dst: GPUBuffer, offset: number) => void
      }).resolveQuerySet(querySet, 0, 2, resolveBuffer, 0)
      // copy resolveBuffer → readBuffer (mapAsync target)
      encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, 16)
      pendingResolve = true
    } catch {
      alive = false
    }
  }

  const timer: GpuTimer = {
    begin: safeBegin,
    end: safeEnd,
    result: safeResult,
  }
  const handle: GpuTimerHandle = { onBeginPass, onEndPass, onSubmit }
  return { timer, handle }
}
