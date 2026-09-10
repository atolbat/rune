// Task 167 — the primitive-mode mapping: 'lines' / 'points' /
// 'triangle-strip' reach the GL enums they name. Before the fix every mode
// drew TRIANGLES (the ternary's both branches were gl.TRIANGLES — a
// copy-paste fossil); the facade type (PrimitiveKind) promised all four.
// The executor only emits 'triangles' today, so this pins the facade
// contract without changing anyone's pixels.

import { describe, expect, test } from 'bun:test'
import { createRealGL } from '../src/realGL.ts'

interface DrawLog {
  readonly draws: string[]
  readonly gl: WebGL2RenderingContext
}

function drawMockGL(): DrawLog {
  const draws: string[] = []
  const gl = {
    // the four draw targets (real GL enum values)
    TRIANGLES: 4, TRIANGLE_STRIP: 5, LINES: 1, POINTS: 0,
    COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256,
    TEXTURE_2D: 3553, DEPTH_TEST: 2929, CULL_FACE: 2884, BLEND: 3042,
    FRAMEBUFFER: 36009, FUNC_ADD: 32774, ONE: 1, ZERO: 0,
    drawingBufferWidth: 800, drawingBufferHeight: 600,
    getExtension: () => null,
    getParameter: () => 4096,
    viewport: () => {},
    bindFramebuffer: () => {},
    clearColor: () => {},
    clearDepth: () => {},
    depthMask: () => {},
    clear: () => {},
    drawArrays: (target: number, first: number, count: number) =>
      draws.push(`drawArrays(${target},${first},${count})`),
    drawArraysInstanced: (target: number, first: number, count: number, instances: number) =>
      draws.push(`drawArraysInstanced(${target},${first},${count},${instances})`),
  } as unknown as WebGL2RenderingContext
  return { draws, gl }
}

describe('Task 167: realGL.drawArrays maps the primitive mode to its GL enum', () => {
  test('triangles → gl.TRIANGLES (the historical behavior, unchanged)', () => {
    const { draws, gl } = drawMockGL()
    const facade = createRealGL(gl)
    facade.drawArrays('triangles', 0, 6, 1)
    expect(draws).toEqual(['drawArrays(4,0,6)'])
  })

  test('lines → gl.LINES (was silently TRIANGLES)', () => {
    const { draws, gl } = drawMockGL()
    const facade = createRealGL(gl)
    facade.drawArrays('lines', 0, 2, 1)
    expect(draws).toEqual(['drawArrays(1,0,2)'])
  })

  test('points → gl.POINTS (was silently TRIANGLES)', () => {
    const { draws, gl } = drawMockGL()
    const facade = createRealGL(gl)
    facade.drawArrays('points', 0, 1, 1)
    expect(draws).toEqual(['drawArrays(0,0,1)'])
  })

  test('triangle-strip → gl.TRIANGLE_STRIP (was silently TRIANGLES)', () => {
    const { draws, gl } = drawMockGL()
    const facade = createRealGL(gl)
    facade.drawArrays('triangle-strip', 0, 4, 1)
    expect(draws).toEqual(['drawArrays(5,0,4)'])
  })

  test('instanced draws carry the mapped target too', () => {
    const { draws, gl } = drawMockGL()
    const facade = createRealGL(gl)
    facade.drawArrays('lines', 0, 2, 100)
    facade.drawArrays('triangles', 0, 6, 100)
    expect(draws).toEqual(['drawArraysInstanced(1,0,2,100)', 'drawArraysInstanced(4,0,6,100)'])
  })
})
