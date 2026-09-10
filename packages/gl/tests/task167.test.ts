// Task 167 — THE SYNC-POINT PASS: the GL error drain's cadence.
//
// The regression being pinned: getError is a forced pipeline flush (the
// driver must complete every submitted command before answering — a live
// CDP profile of the GPU-Embers TF tier: 84.6% of sampled CPU time blocked
// inside the once-per-frame drain). The contracts:
//   1. PROBE CADENCE — a healthy page calls getError once per 8 frames,
//      not once per frame.
//   2. STICKY FLAG — an error raised in frame 1 still surfaces at the
//      frame-8 probe (the GL error flag is sticky: it sits set until
//      getError retrieves it, new errors are discarded while one pends).
//   3. HUNTING MODE — once an error is seen, EVERY frame drains until a
//      clean drain (the old diagnostic precision, exactly when it matters).
//   4. SPAM GUARD — a persistent error reports once, not per frame.
//   5. DISPOSE DRAIN — a tail error (raised after the last probe, before
//      dispose) surfaces at dispose; an already-reported error does not.
//   6. HEADLESS PARITY — an injected facade (rawContext === null) never
//      calls getError at all (the historical contract, unchanged).

import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/webgl2Renderer.ts'
import { createRecordingGL } from '@rune/webgl2'

/** A raw-context canvas whose getError is scriptable: `queue` holds codes
 *  the mock will hand out ONE per getError call (then NO_ERROR), `raise`
 *  pushes a code onto the queue mid-run (the sticky-flag model), and
 *  `getErrorCalls` counts every call (the cadence oracle). The raw surface
 *  is the minimal full-frame set (an EMPTY frame: resize → viewport →
 *  bindTarget → clear — everything a frame with zero commands touches). */
function errorDrainCanvas(): {
  canvas: HTMLCanvasElement
  getErrorCalls: () => number
  raise: (code: number) => void
  loseCalls: () => number
} {
  let errorCalls = 0
  let lose = 0
  const queue: number[] = []
  const raw = {
    // constants the facade reads off the context
    COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256,
    TEXTURE_2D: 3553, DEPTH_TEST: 2929, CULL_FACE: 2884, BLEND: 3042,
    FRAMEBUFFER: 36009, ARRAY_BUFFER: 0x8892, FUNC_ADD: 32774, ONE: 1, ZERO: 0,
    drawingBufferWidth: 800, drawingBufferHeight: 600,
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context' ? { loseContext: () => { lose++ } }
        : name === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: 0x91b1 }
          : null,
    getParameter: () => 4096,
    viewport: () => {},
    // the empty-frame surface
    bindFramebuffer: () => {},
    clearColor: () => {},
    clearDepth: () => {},
    depthMask: () => {},
    clear: () => {},
    getError: () => {
      errorCalls++
      return queue.length > 0 ? queue.shift()! : 0
    },
  }
  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    getContext: () => raw,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement
  return { canvas, getErrorCalls: () => errorCalls, raise: code => queue.push(code), loseCalls: () => lose }
}

function makeRenderer(canvas: HTMLCanvasElement, errors: string[]) {
  return createWebGL2Renderer({
    canvas,
    observeResize: false,
    now: () => 0,
    requestFrame: () => () => {},
    onGlError: message => errors.push(message),
  })
}

const INVALID_ENUM = 0x500
const INVALID_VALUE = 0x501 // a DIFFERENT code, for the key-change path

describe('Task 167: the GL error drain cadence (the sync-point pass)', () => {
  it('probe cadence — a healthy page calls getError once per 8 frames, not per frame', () => {
    const { canvas, getErrorCalls } = errorDrainCanvas()
    const renderer = makeRenderer(canvas, [])
    expect(getErrorCalls()).toBe(0) // boot: no drain
    for (let frame = 0; frame < 7; frame++) renderer.step(16)
    expect(getErrorCalls()).toBe(0) // frames 1..7: no probe yet
    renderer.step(16) // frame 8 — the probe
    expect(getErrorCalls()).toBe(1)
    for (let frame = 0; frame < 7; frame++) renderer.step(16)
    expect(getErrorCalls()).toBe(1) // frames 9..15: quiet
    renderer.step(16) // frame 16 — the next probe
    expect(getErrorCalls()).toBe(2)
    renderer.stop()
  })

  it('sticky flag — an error raised in frame 1 surfaces at the frame-8 probe', () => {
    const { canvas, raise } = errorDrainCanvas()
    const errors: string[] = []
    const renderer = makeRenderer(canvas, errors)
    renderer.step(16) // frame 1
    raise(INVALID_ENUM) // the error flag sets — it SITS there
    for (let frame = 0; frame < 6; frame++) renderer.step(16)
    expect(errors.length).toBe(0) // frames 2..7: the flag waits, undrained
    renderer.step(16) // frame 8: the probe retrieves it
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('GL error')
    expect(errors[0]).toContain('INVALID_ENUM')
    renderer.stop()
  })

  it('hunting mode — an error snaps the drain to every frame until clean', () => {
    const { canvas, raise, getErrorCalls } = errorDrainCanvas()
    const errors: string[] = []
    const renderer = makeRenderer(canvas, errors)
    for (let frame = 0; frame < 8; frame++) renderer.step(16)
    const probeCalls = getErrorCalls() // 1 (the frame-8 probe was clean)
    raise(INVALID_ENUM)
    for (let frame = 0; frame < 7; frame++) renderer.step(16)
    expect(getErrorCalls()).toBe(probeCalls) // frames 9..15: the flag waits for the next probe
    renderer.step(16) // frame 16 — the probe SEES the error: report + hunting ON
    // (the drain made TWO getError calls: the error code, then the NO_ERROR
    // that ends the loop)
    expect(getErrorCalls()).toBe(probeCalls + 2)
    expect(errors.length).toBe(1)
    renderer.step(16) // frame 17: hunting — a drain per frame, clean (the flag was
    // retrieved) → THE CLEAN DRAIN ITSELF DISARMS hunting
    renderer.step(16) // frame 18: already back on the tick gate — no drain
    expect(getErrorCalls()).toBe(probeCalls + 3)
    expect(errors.length).toBe(1) // no new reports — the flag was already retrieved
    for (let frame = 0; frame < 6; frame++) renderer.step(16)
    expect(getErrorCalls()).toBe(probeCalls + 3) // frames 19..23: back on the probe cadence
    renderer.step(16) // frame 24: the next probe
    expect(getErrorCalls()).toBe(probeCalls + 4)
    renderer.stop()
  })

  it('spam guard — a persistent error reports once, not every hunting frame', () => {
    const { canvas, raise } = errorDrainCanvas()
    const errors: string[] = []
    const renderer = makeRenderer(canvas, errors)
    raise(INVALID_ENUM)
    raise(INVALID_ENUM) // the mock hands out both queued codes on consecutive
    // getError calls — a real driver DISCARDS the second while one pends;
    // either way the report lands ONCE (the drain loop retrieves the set)
    for (let frame = 0; frame < 8; frame++) renderer.step(16) // frame 8: the probe reports the storm, hunting ON
    expect(errors.length).toBe(1) // one report for the whole storm
    for (let frame = 0; frame < 3; frame++) renderer.step(16) // hunting drains: clean, quiet
    expect(errors.length).toBe(1)
    // a DIFFERENT error later → a new key → a new report (the guard keys on the code set)
    for (let frame = 0; frame < 5; frame++) renderer.step(16) // reach the next probe (frame 16)
    raise(INVALID_VALUE)
    for (let frame = 0; frame < 8; frame++) renderer.step(16) // the frame-24 probe sees it
    expect(errors.length).toBe(2)
    expect(errors[1]).toContain('INVALID_VALUE')
    renderer.stop()
  })

  it('dispose drain — a tail error surfaces at dispose; an already-reported one does not', () => {
    const { canvas, raise } = errorDrainCanvas()
    const errors: string[] = []
    const renderer = makeRenderer(canvas, errors)
    for (let frame = 0; frame < 3; frame++) renderer.step(16) // no probe hit (frames 1..3)
    raise(INVALID_ENUM) // the tail error — after the last probe, before dispose
    renderer.dispose()
    expect(errors.some(e => e.includes('drained at dispose'))).toBe(true)
    expect(errors.some(e => e.includes('INVALID_ENUM'))).toBe(true)

    // the second renderer: the error IS reported by the probe (hunting) →
    // the dispose drain must NOT repeat it
    const second = errorDrainCanvas()
    const errors2: string[] = []
    const renderer2 = makeRenderer(second.canvas, errors2)
    for (let frame = 0; frame < 8; frame++) renderer2.step(16)
    second.raise(INVALID_ENUM)
    for (let frame = 0; frame < 8; frame++) renderer2.step(16) // the frame-16 probe reports it
    expect(errors2.length).toBe(1)
    expect(errors2[0]).not.toContain('drained at dispose') // reported by the probe, not dispose
    renderer2.dispose()
    expect(errors2.length).toBe(1) // no duplicate dispose report (the queue is empty)
  })

  it('headless parity — an injected facade never calls getError', () => {
    const { gl } = createRecordingGL()
    const canvas = {
      clientWidth: 800, clientHeight: 600, width: 0, height: 0,
      getContext: () => gl,
      addEventListener: () => {}, removeEventListener: () => {},
    } as unknown as HTMLCanvasElement
    const errors: string[] = []
    const renderer = createWebGL2Renderer({
      canvas,
      createGL: () => gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      onGlError: message => errors.push(message),
    })
    for (let frame = 0; frame < 16; frame++) renderer.step(16)
    // rawContext is null on the injected path — no drain, no getError, no
    // reports: the historical headless contract, byte for byte.
    expect(errors.length).toBe(0)
    renderer.stop()
  })
})
