/**
 * GpuTimer — WebGL2 реализация через EXT_disjoint_timer_query_webgl2.
 *
 * Контракт (GpuTimer из @rune/core):
 *  - begin(): gl.beginQuery(TIME_ELAPSED_EXT, query). Помечает что query запущен.
 *  - end(): gl.endQuery(TIME_ELAPSED_EXT). Закрывает query.
 *  - result(): gl.getQueryObject(query, QUERY_RESULT_EXT) — nanoseconds.
 *    null если: query ещё не готов (AVAILABLE=false), GPU disjoint (reset),
 *    или расширение недоступно.
 *
 * Асинхронность: result() возвращает результат ПРЕДЫДУЩЕГО кадра. Типичный паттерн:
 *   frame N: begin() → ...draw... → end()
 *   frame N+1: result() // читает N-й кадр
 *
 * Disjoint: GPU reset (driver crash, power state). Если disjoint=true —
 * результат невалиден, отбрасываем, пере-запускаем в следующем кадре.
 *
 * Ограничения:
 *  - Расширение НЕ доступно на iOS Safari (ограничение Apple). caps.has
 *    ('timestamp-query') → false → renderer не подключает timer.
 *  - В headless-тестах (mock GL) — расширения нет, createGLGpuTimer вернёт null.
 *
 * Безопасность: даже если расширение доступно, в некоторых окружениях
 * (Safari, Mali mobile drivers) расширение может вернуться из getExtension
 * но бросать на beginQuery. Поэтому обёрнуто в try/catch — на любую ошибку
 * timer деактивируется (setGpuTimer(null) вызывается рендерером).
 */

import type { GpuTimer } from '@rune/core'

// Тип расширения EXT_disjoint_timer_query_webgl2. Реальный объект WebGL
// предоставляет методы: createQueryEXT, deleteQueryEXT, beginQueryEXT,
// endQueryEXT, getQueryObjectEXT, isQueryEXT. Все с суффиксом EXT.
interface ExtDisjointTimerQuery {
  QUERY_COUNTER_BITS_EXT: number
  TIME_ELAPSED_EXT: number
  TIMESTAMP_EXT: number
  GPU_DISJOINT_EXT: number
  QUERY_RESULT_AVAILABLE_EXT: number
  QUERY_RESULT_EXT: number
  createQueryEXT(): WebGLQuery | null
  deleteQueryEXT(query: WebGLQuery): void
  beginQueryEXT(target: number, query: WebGLQuery): void
  endQueryEXT(target: number): void
  getQueryObjectEXT(query: WebGLQuery, pname: number): unknown
  isQueryEXT(value: unknown): boolean
}

/**
 * Создаёт WebGL2 GpuTimer если расширение EXT_disjoint_timer_query_webgl2
 * доступно. Иначе возвращает null — caps.has('timestamp-query') будет false,
 * renderer не подключает timer, gpuMs = null в stats.
 *
 * @param gl — реальный WebGL2RenderingContext (не mock; mock вернёт null).
 */
export function createGLGpuTimer(gl: WebGL2RenderingContext): GpuTimer | null {
  const extOrNull = gl.getExtension('EXT_disjoint_timer_query_webgl2') as ExtDisjointTimerQuery | null
  if (extOrNull === null) return null
  // const с не-null типом: замыкания ниже (safeBegin/safeEnd/safeResult)
  // сохраняют narrowing (иначе TS видит `ext` как | null внутри колбэков).
  const ext: ExtDisjointTimerQuery = extOrNull
  // 2 query: один активный (текущий кадр), один завершённый (предыдущий кадр).
  // Ping-pong нужен потому что getQueryObject блокирует до AVAILABLE=true —
  // а это занимает минимум 1 кадр. С 2 query: в begin() создаём новый если
  // предыдущий end()'нут; в result() читаем завершённый, swap.
  let active: WebGLQuery | null = null
  let pending: WebGLQuery | null = null
  let lastResult: number | null = null
  let alive = true

  function safeBegin(): void {
    if (!alive) return
    try {
      if (active !== null) {
        // Уже начат в этом кадре — ничего не делаем (повтор begin = GL error)
        return
      }
      active = ext.createQueryEXT()
      if (active === null) {
        alive = false
        return
      }
      ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, active)
    } catch {
      alive = false
    }
  }

  function safeEnd(): void {
    if (!alive) return
    try {
      if (active === null) return
      ext.endQueryEXT(ext.TIME_ELAPSED_EXT)
      // pending → освобождаем (если был); active → становится pending
      if (pending !== null) {
        ext.deleteQueryEXT(pending)
      }
      pending = active
      active = null
    } catch {
      alive = false
    }
  }

  function safeResult(): number | null {
    if (!alive || pending === null) return lastResult
    try {
      // disjoint=true → GPU reset, результат невалиден
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as number
      if (disjoint !== 0) {
        // Сбрасываем — в следующем кадре начнётся заново
        ext.deleteQueryEXT(pending)
        pending = null
        lastResult = null
        return null
      }
      const available = ext.getQueryObjectEXT(pending, ext.QUERY_RESULT_AVAILABLE_EXT) as number
      if (!available) {
        // Результат ещё не готов — отдаём предыдущее значение (или null)
        return lastResult
      }
      // Результат готов — наносекунды → миллисекунды
      const ns = ext.getQueryObjectEXT(pending, ext.QUERY_RESULT_EXT) as number
      lastResult = typeof ns === 'number' && Number.isFinite(ns) ? ns / 1e6 : null
      return lastResult
    } catch {
      alive = false
      return null
    }
  }

  return {
    begin: safeBegin,
    end: safeEnd,
    result: safeResult,
  }
}
