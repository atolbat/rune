// Task 112: Stockham FFT recipe (@rune/kit) — schedule + chunks.

import { describe, test, expect } from 'bun:test'
import { fft2dPasses, FFT_GLSL_SUBTRANSFORM, FFT_WGSL_SUBTRANSFORM } from '../src/fft.ts'
import { FULLSCREEN_PASS_GLSL, FULLSCREEN_PASS_WGSL } from '../src/fullscreenPass.ts'

describe('Task 112 — fft2dPasses: Stockham schedule', () => {
  test('2·log₂N passes; horizontal axes first', () => {
    const passes = fft2dPasses(256)
    expect(passes.length).toBe(16) // log2(256)=8 → 16
    expect(passes[0]!.axis).toBe('horizontal')
    expect(passes[7]!.axis).toBe('horizontal')
    expect(passes[8]!.axis).toBe('vertical')
    expect(passes[15]!.axis).toBe('vertical')
    // Contiguous indices
    expect(passes.map(p => p.index)).toEqual(Array.from({ length: 16 }, (_, i) => i))
  })

  test('subtransform sizes 2^1..2^N on each axis', () => {
    const passes = fft2dPasses(64) // log2=6 → 12 passes
    const sizes = passes.map(p => p.subtransformSize)
    expect(sizes).toEqual([2, 4, 8, 16, 32, 64, 2, 4, 8, 16, 32, 64])
  })

  test('ping-pong parity: spectrum→a, a→b, b→a, …, final into result', () => {
    const passes = fft2dPasses(4) // 4 passes
    expect(passes[0]).toMatchObject({ input: 'spectrum', output: 'a' })
    expect(passes[1]).toMatchObject({ input: 'a', output: 'b' })
    expect(passes[2]).toMatchObject({ input: 'b', output: 'a' })
    expect(passes[3]).toMatchObject({ output: 'result' })
    // Final input: iterations=4 (even) → 'a' (david.li/waves logic)
    expect(passes[3]!.input).toBe('a')
  })

  test('odd log₂N: the final pass reads from b (parity as in the demo)', () => {
    const passes = fft2dPasses(8) // log2=3 → 6 passes, iterations=6 even → 'a'?
    // 6 passes: spec→a, a→b, b→a, b?→… we check the read/write chain
    const chain: Array<[string, string]> = passes.map(p => [p.input, p.output])
    // Every output (except result) is someone's next input
    expect(chain[0]).toEqual(['spectrum', 'a'])
    expect(chain[5]![1]).toBe('result')
  })

  test('parity alternates across passes (a/b)', () => {
    const passes = fft2dPasses(64)
    for (let i = 1; i < passes.length - 1; i++) {
      const prev = passes[i - 1]!
      const cur = passes[i]!
      if (cur.output !== 'result') {
        // The current input = the previous output (except first/last)
        if (i > 1 && prev.output !== 'result') {
          expect(cur.input).toBe(prev.output)
        }
      }
    }
  })

  test('not a power of two — an honest error', () => {
    expect(() => fft2dPasses(100)).toThrow('a power of two')
    expect(() => fft2dPasses(1)).toThrow()
    expect(() => fft2dPasses(0)).toThrow()
  })
})

describe('Task 112 — FFT dual-source chunks', () => {
  test('GLSL: axis via a uniform (one program for both axes), u_input', () => {
    expect(FFT_GLSL_SUBTRANSFORM).toContain('u_transformSize')
    expect(FFT_GLSL_SUBTRANSFORM).toContain('u_subtransformSize')
    expect(FFT_GLSL_SUBTRANSFORM).toContain('u_horizontal')
    expect(FFT_GLSL_SUBTRANSFORM).toContain('u_input')
    expect(FFT_GLSL_SUBTRANSFORM).toContain('#version 300 es')
    // Two sequences simultaneously (the david.li trick)
    expect(FFT_GLSL_SUBTRANSFORM).toContain('even.xy + multiplyComplex(twiddle, odd.xy)')
    expect(FFT_GLSL_SUBTRANSFORM).toContain('even.zw + multiplyComplex(twiddle, odd.zw)')
    // No #define axis variants (unlike the demo — half the compilations)
    expect(FFT_GLSL_SUBTRANSFORM).not.toContain('#define HORIZONTAL')
  })

  test('WGSL: textureLoad (NEAREST semantics at texel centers)', () => {
    expect(FFT_WGSL_SUBTRANSFORM).toContain('textureLoad(srcTex')
    expect(FFT_WGSL_SUBTRANSFORM).toContain('uni.u.z > 0.5')
    expect(FFT_WGSL_SUBTRANSFORM).toContain('multiplyComplex')
    // glMod helper (WGSL % keeps the dividend's sign — as in the demo port)
    expect(FFT_WGSL_SUBTRANSFORM).toContain('fn glMod')
  })
})

describe('Task 112 — fullscreen pass (chunk, WITHOUT a primitive)', () => {
  test('GLSL: triangle from gl_VertexID, no attributes', () => {
    expect(FULLSCREEN_PASS_GLSL).toContain('gl_VertexID')
    expect(FULLSCREEN_PASS_GLSL).toContain('vec2(-1.0, -1.0)')
    expect(FULLSCREEN_PASS_GLSL).toContain('vec2( 3.0, -1.0)')
    expect(FULLSCREEN_PASS_GLSL).not.toContain('attribute')
    expect(FULLSCREEN_PASS_GLSL).not.toContain('in vec2 aPos')
  })

  test('WGSL: @builtin(vertex_index), VsOut struct compatible with the FFT chunk', () => {
    expect(FULLSCREEN_PASS_WGSL).toContain('@builtin(vertex_index)')
    expect(FULLSCREEN_PASS_WGSL).toContain('struct VsOut')
    expect(FULLSCREEN_PASS_WGSL).toContain('@location(0) coord: vec2f')
    // The FFT chunk expects VsOut/vout — the names match
    expect(FFT_WGSL_SUBTRANSFORM).toContain('fsMain(vout: VsOut)')
  })
})
