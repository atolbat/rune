// REGRESSION (демо-10, «пустой кадр 2+»): glClear маскируется depthMask.
// Полноэкранный проход оставляет depthMask(false); если clear() цели или
// канваса не поднимет маску — глубина НЕ чистится, и сцена следующего
// кадра z-fighting'ит с прошлым (пустой канвас / блобы на спине).
// Мок-GL фиксирует порядок depthMask → clear.

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
    // Константы, которые realGL читает с контекста
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

describe('realGL: clear маскируется depthMask (регрессия демо-10)', () => {
  test('bindTarget(поверхность, clear) поднимает depthMask ДО clear глубины', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const textureId = facade.createTexture(64, 64)
    const targetId = facade.createTarget(textureId, 64, 64, true, [0, 0, 0, 1])
    calls.length = 0

    // Симуляция прошлого прохода: depthMask(false) остался от полноэкранного
    facade.setDepthMode('always', false)
    calls.length = 0

    facade.bindTarget(targetId, true)
    const maskAt = calls.indexOf('depthMask(1)')
    const clearAt = calls.findIndex(call => call.startsWith('clear('))
    expect(maskAt).toBeGreaterThanOrEqual(0)
    expect(clearAt).toBeGreaterThan(maskAt) // маска поднята ДО очистки
    // И глубина действительно входит в очистку (COLOR|DEPTH = 16640)
    expect(calls[clearAt]).toBe('clear(16640)')
  })

  test('clear() канваса с глубиной тоже поднимает depthMask', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    facade.setDepthMode('always', false) // после полноэкранного прохода
    calls.length = 0

    facade.clear([0.1, 0.1, 0.1, 1], 1)
    const maskAt = calls.indexOf('depthMask(1)')
    const clearAt = calls.findIndex(call => call.startsWith('clear('))
    expect(maskAt).toBeGreaterThanOrEqual(0)
    expect(clearAt).toBeGreaterThan(maskAt)
  })

  test('clear() без глубины не трогает маску (цветовая очистка не маскируется)', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    calls.length = 0
    facade.clear([0.1, 0.1, 0.1, 1], null)
    expect(calls.filter(call => call.startsWith('depthMask(')).length).toBe(0)
    expect(calls.some(call => call.startsWith('clear('))).toBe(true)
  })

  test('повторный bindTarget той же цели без clear — no-op', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const textureId = facade.createTexture(32, 32)
    const targetId = facade.createTarget(textureId, 32, 32, false, [0, 0, 0, 1])
    calls.length = 0
    facade.bindTarget(targetId, false)
    const afterFirst = calls.length
    facade.bindTarget(targetId, false) // skip: та же цель, без очистки
    expect(calls.length).toBe(afterFirst)
  })
})
