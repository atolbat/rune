/**
 * GpuTimer — WebGPU реализация через timestamp-query feature.
 *
 * Контракт (GpuTimer из @rune/core):
 *  - begin(): вызывается в StatsCollector.beginFrame ( ДО кадрового рендера).
 *    Мапит readBuffer прошлого кадра (если есть pending resolve) и читает
 *    результат асинхронно в lastResult.
 *  - end(): noop на уровне timer — на самом деле writeTimestamp(END) делает
 *    GPUFacade через GpuTimerHandle.onEndPass в момент endPass(). Здесь
 *    noop, чтобы совместить с интерфейсом WebGL2 timer'а (где end() тоже
 *    закрывает query).
 *  - result(): возвращает lastResult (ms) или null если:
 *    • первый кадр (нет pending resolve)
 *    • GPU device lost
 *    • mapAsync failed
 *    • feature недоступен
 *
 * WebGPU timestamp-query — асинхронный:
 *   frame N: writeTimestamp(BEGIN) в beginPass → draw → writeTimestamp(END) в endPass
 *           → resolveQuerySet(BEGIN..END → resolveBuffer) в submit
 *           → copyBuffer resolveBuffer → readBuffer
 *   frame N+1: begin() дёргает mapAsync на readBuffer → читает 2 BigInt64
 *             (start_ns, end_ns) → gpuMs = (end - start) / 1e6
 *
 * Ограничения:
 *  - Chrome 113+ поддерживает timestamp-query (не на всех платформах).
 *  - В headless-тестах (mock GPUDevice) — feature нет, createGpuGpuTimer
 *    вернёт null.
 *  - mapAsync — async, результат приходит через микротаски. Если к моменту
 *    result() map ещё не завершён — отдаём previous lastResult (или null).
 */

import type { GpuTimer } from '@rune/core'

/** Handle, который GPUFacade дёргает в нужные моменты для writeTimestamp.
 *  Сам WebGpuTimer реализует и GpuTimer (core), и GpuTimerHandle. */
export interface GpuTimerHandle {
  /** Вызывается GPUFacade после beginRenderPass. Пишет BEGIN-stamp в pass.
   *  pass.writeTimestamp(querySet, BEGIN_INDEX). */
  onBeginPass(pass: GPURenderPassEncoder): void
  /** Вызывается GPUFacade ДО pass.end(). Пишет END-stamp в pass. */
  onEndPass(pass: GPURenderPassEncoder): void
  /** Вызывается GPUFacade ДО encoder.finish() (в submit). resolveQuerySet +
   *  copyBuffer. Без этого timestamps остаются в querySet и недоступны CPU. */
  onSubmit(encoder: GPUCommandEncoder): void
}

/** Создаёт WebGPU GpuTimer если device имеет feature 'timestamp-query'.
 *  Иначе возвращает null — caps.has('timestamp-query') будет false,
 *  renderer не подключает timer, gpuMs = null в stats.
 *
 * @param device — реальный GPUDevice (не mock; mock вернёт null).
 */
export function createGpuGpuTimer(device: GPUDevice): { timer: GpuTimer; handle: GpuTimerHandle } | null {
  // Проверяем feature через try/catch — features.has может бросать на старых browsers.
  let hasTimestampQuery = false
  try {
    hasTimestampQuery = device.features.has('timestamp-query' as GPUFeatureName)
  } catch {
    return null
  }
  if (!hasTimestampQuery) return null

  // 2 timestamp slots: BEGIN (0) и END (1).
  let querySet: GPUQuerySet
  try {
    querySet = device.createQuerySet({ type: 'timestamp', count: 2 })
  } catch {
    return null
  }

  // GPUBufferUsage — глобальный enum в браузере (Chrome 113+). В headless
  // окружении без WebGPU его нет. Числовые fallback'и взяты из WebGPU spec
  // (GPUBufferUsage.{MAP_READ=0x1, COPY_DST=0x8, COPY_SRC=0x4, QUERY_RESOLVE=0x20}).
  const MAP_READ = (globalThis as { GPUBufferUsage?: { MAP_READ?: number } }).GPUBufferUsage?.MAP_READ ?? 0x1
  const COPY_DST = (globalThis as { GPUBufferUsage?: { COPY_DST?: number } }).GPUBufferUsage?.COPY_DST ?? 0x8
  const COPY_SRC = (globalThis as { GPUBufferUsage?: { COPY_SRC?: number } }).GPUBufferUsage?.COPY_SRC ?? 0x4
  const QUERY_RESOLVE = (globalThis as { GPUBufferUsage?: { QUERY_RESOLVE?: number } }).GPUBufferUsage?.QUERY_RESOLVE ?? 0x20

  let resolveBuffer: GPUBuffer
  let readBuffer: GPUBuffer
  try {
    // resolveBuffer: GPUQuerySet → buffer (BigInt64Array × 2 = 16 bytes).
    // usage QUERY_RESOLVE + COPY_SRC: resolveQuerySet пишет сюда, copy —
    // во второй buffer для mapAsync.
    resolveBuffer = device.createBuffer({
      size: 16,
      usage: QUERY_RESOLVE | COPY_SRC,
    })
    // readBuffer: конечный пункт для CPU-чтения. mapAsync(READ) → ArrayBuffer.
    readBuffer = device.createBuffer({
      size: 16,
      usage: COPY_DST | MAP_READ,
    })
  } catch {
    return null
  }

  // GPUMapMode — глобальный enum в браузере. В headless нет. READ = 0x1.
  const MAP_READ_MODE = (globalThis as { GPUMapMode?: { READ?: number } }).GPUMapMode?.READ ?? 0x1

  let lastResult: number | null = null
  let pendingResolve = false
  let mapping = false
  let alive = true

  // begin() — мапит readBuffer предыдущего кадра. Если map завершилась —
  // читаем start_ns и end_ns как BigInt64, считаем ms.
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
      // device lost или map failed — деактивируем
      alive = false
    })
  }

  function safeEnd(): void {
    // На уровне timer — noop. END-stamp пишет GPUFacade через handle.onEndPass.
  }

  function safeResult(): number | null {
    if (!alive) return null
    return lastResult
  }

  // ─── GpuTimerHandle реализация ─────────────────────────────────────────
  function onBeginPass(pass: GPURenderPassEncoder): void {
    if (!alive) return
    try {
      // writeTimestamp на pass — между beginRenderPass и любым draw.
      // BEGIN_INDEX = 0.
      ;(pass as unknown as { writeTimestamp: (set: GPUQuerySet, idx: number) => void })
        .writeTimestamp(querySet, 0)
    } catch {
      // Некоторые браузеры имеют feature, но не реализовали writeTimestamp на pass.
      // Деактивируем — будет null result.
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
