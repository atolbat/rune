// REGRESSION (demo-10, "empty frame 2+"): glClear is masked by depthMask.
// A fullscreen pass leaves depthMask(false); if clear() of the target or
// canvas does not raise the mask — the depth is NOT cleared, and the next
// frame's scene z-fights with the previous one (an empty canvas / blobs on the back).
// The mock GL records the depthMask → clear order.

import { describe, expect, test } from 'bun:test'
import { createRealGL } from '../src/realGL.ts'

interface CallLog {
  readonly calls: string[]
  readonly gl: WebGL2RenderingContext
}

function mockGL(): CallLog {
  const calls: string[] = []
  let texture = 0
  let fbo = 0
  let renderbuffer = 0
  const gl = {
    // Constants that realGL reads from the context
    FRAMEBUFFER: 36009,
    FRAMEBUFFER_COMPLETE: 36053,
    COLOR_ATTACHMENT0: 36064,
    DEPTH_ATTACHMENT: 36096,
    RENDERBUFFER: 36161,
    DEPTH_COMPONENT16: 33189,
    TEXTURE_2D: 3553,
    DEPTH_TEST: 2929,
    CULL_FACE: 2884,
    LESS: 513,
    LEQUAL: 515,
    BACK: 1029,
    FRONT: 1028,
    COLOR_BUFFER_BIT: 16384,
    DEPTH_BUFFER_BIT: 256,
    createTexture: () => ({ id: ++texture }),
    bindTexture: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    createFramebuffer: () => ({ id: ++fbo }),
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    createRenderbuffer: () => ({ id: ++renderbuffer }),
    bindRenderbuffer: () => {},
    renderbufferStorage: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => 36053, // FRAMEBUFFER_COMPLETE
    viewport: () => {},
    clearColor: () => {},
    clearDepth: () => calls.push('clearDepth'),
    depthMask: (write: boolean) => calls.push(`depthMask(${write ? 1 : 0})`),
    clear: (bits: number) => calls.push(`clear(${bits})`),
    enable: () => {},
    disable: () => {},
    depthFunc: () => {},
    cullFace: () => {},
  } as unknown as WebGL2RenderingContext
  return { calls, gl }
}

describe('realGL: clear is masked by depthMask (demo-10 regression)', () => {
  test('bindTarget(surface, clear) raises depthMask BEFORE the depth clear', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const textureId = facade.createTexture(64, 64)
    const targetId = facade.createTarget(textureId, 64, 64, true, [0, 0, 0, 1])
    calls.length = 0

    // Simulation of the previous pass: depthMask(false) left over from a fullscreen pass
    facade.setDepthMode('always', false)
    calls.length = 0

    facade.bindTarget(targetId, true)
    const maskAt = calls.indexOf('depthMask(1)')
    const clearAt = calls.findIndex(call => call.startsWith('clear('))
    expect(maskAt).toBeGreaterThanOrEqual(0)
    expect(clearAt).toBeGreaterThan(maskAt) // the mask is raised BEFORE the clear
    // And the depth is indeed included in the clear (COLOR|DEPTH = 16640)
    expect(calls[clearAt]).toBe('clear(16640)')
  })

  test('clear() of the canvas with depth also raises depthMask', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    facade.setDepthMode('always', false) // after a fullscreen pass
    calls.length = 0

    facade.clear([0.1, 0.1, 0.1, 1], 1)
    const maskAt = calls.indexOf('depthMask(1)')
    const clearAt = calls.findIndex(call => call.startsWith('clear('))
    expect(maskAt).toBeGreaterThanOrEqual(0)
    expect(clearAt).toBeGreaterThan(maskAt)
  })

  test('clear() without depth does not touch the mask (a color clear is not masked)', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    calls.length = 0
    facade.clear([0.1, 0.1, 0.1, 1], null)
    expect(calls.filter(call => call.startsWith('depthMask(')).length).toBe(0)
    expect(calls.some(call => call.startsWith('clear('))).toBe(true)
  })

  test('a repeated bindTarget of the same target without clear — a no-op', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const textureId = facade.createTexture(32, 32)
    const targetId = facade.createTarget(textureId, 32, 32, false, [0, 0, 0, 1])
    calls.length = 0
    facade.bindTarget(targetId, false)
    const afterFirst = calls.length
    facade.bindTarget(targetId, false) // skip: the same target, no clear
    expect(calls.length).toBe(afterFirst)
  })
})
