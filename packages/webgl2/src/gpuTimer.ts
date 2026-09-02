/**
 * GpuTimer — a WebGL2 implementation via EXT_disjoint_timer_query_webgl2.
 *
 * Contract (GpuTimer from @rune/core):
 *  - begin(): gl.beginQuery(TIME_ELAPSED_EXT, query). Marks the query as started.
 *  - end(): gl.endQuery(TIME_ELAPSED_EXT). Closes the query.
 *  - result(): gl.getQueryObject(query, QUERY_RESULT_EXT) — nanoseconds.
 *    null if: the query is not ready yet (AVAILABLE=false), the GPU is disjoint (reset),
 *    or the extension is unavailable.
 *
 * Asynchrony: result() returns the result of the PREVIOUS frame. Typical pattern:
 *   frame N: begin() → ...draw... → end()
 *   frame N+1: result() // reads frame N
 *
 * Disjoint: GPU reset (driver crash, power state). If disjoint=true —
 * the result is invalid, we discard it and restart in the next frame.
 *
 * Limitations:
 *  - The extension is NOT available on iOS Safari (an Apple restriction). caps.has
 *    ('timestamp-query') → false → the renderer does not attach a timer.
 *  - In headless tests (mock GL) there is no extension, createGLGpuTimer returns null.
 *
 * Safety: even if the extension is available, in some environments
 * (Safari, Mali mobile drivers) the extension may be returned by getExtension
 * but throw on beginQuery. Hence it is wrapped in try/catch — on any error
 * the timer is deactivated (setGpuTimer(null) is called by the renderer).
 */

import type { GpuTimer } from '@rune/core'

// The type of the EXT_disjoint_timer_query_webgl2 extension. The real WebGL object
// provides the methods: createQueryEXT, deleteQueryEXT, beginQueryEXT,
// endQueryEXT, getQueryObjectEXT, isQueryEXT. All with the EXT suffix.
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
 * Creates a WebGL2 GpuTimer if the EXT_disjoint_timer_query_webgl2 extension
 * is available. Otherwise returns null — caps.has('timestamp-query') will be false,
 * the renderer does not attach a timer, gpuMs = null in stats.
 *
 * @param gl — a real WebGL2RenderingContext (not a mock; a mock returns null).
 */
export function createGLGpuTimer(gl: WebGL2RenderingContext): GpuTimer | null {
  const extOrNull = gl.getExtension('EXT_disjoint_timer_query_webgl2') as ExtDisjointTimerQuery | null
  if (extOrNull === null) return null
  // const with a non-null type: the closures below (safeBegin/safeEnd/safeResult)
  // keep the narrowing (otherwise TS sees `ext` as | null inside callbacks).
  const ext: ExtDisjointTimerQuery = extOrNull
  // 2 queries: one active (the current frame), one completed (the previous frame).
  // Ping-pong is needed because getQueryObject blocks until AVAILABLE=true —
  // and that takes at least 1 frame. With 2 queries: in begin() we create a new one if
  // the previous one was end()'ed; in result() we read the completed one and swap.
  let active: WebGLQuery | null = null
  let pending: WebGLQuery | null = null
  let lastResult: number | null = null
  let alive = true

  function safeBegin(): void {
    if (!alive) return
    try {
      if (active !== null) {
        // Already started in this frame — do nothing (a repeated begin = a GL error)
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
      // pending → free it (if any); active → becomes pending
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
      // disjoint=true → GPU reset, the result is invalid
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as number
      if (disjoint !== 0) {
        // Reset — it will start anew in the next frame
        ext.deleteQueryEXT(pending)
        pending = null
        lastResult = null
        return null
      }
      const available = ext.getQueryObjectEXT(pending, ext.QUERY_RESULT_AVAILABLE_EXT) as number
      if (!available) {
        // The result is not ready yet — return the previous value (or null)
        return lastResult
      }
      // The result is ready — nanoseconds → milliseconds
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
