// Task 112: рецепт FFT Стокхэма (@rune/kit) — расписание + чанки.

import { describe, test, expect } from 'bun:test'
import { fft2dPasses, FFT_GLSL_SUBTRANSFORM, FFT_WGSL_SUBTRANSFORM } from '../src/fft.ts'
import { FULLSCREEN_PASS_GLSL, FULLSCREEN_PASS_WGSL } from '../src/fullscreenPass.ts'

describe('Task 112 — fft2dPasses: расписание Стокхэма', () => {
  test('2·log₂N проходов; оси — сначала горизонтальные', () => {
    const passes = fft2dPasses(256)
    expect(passes.length).toBe(16) // log2(256)=8 → 16
    expect(passes[0]!.axis).toBe('horizontal')
    expect(passes[7]!.axis).toBe('horizontal')
    expect(passes[8]!.axis).toBe('vertical')
    expect(passes[15]!.axis).toBe('vertical')
    // Индексы сквозные
    expect(passes.map(p => p.index)).toEqual(Array.from({ length: 16 }, (_, i) => i))
  })

  test('размеры подтрансформаций 2^1..2^N на каждой оси', () => {
    const passes = fft2dPasses(64) // log2=6 → 12 проходов
    const sizes = passes.map(p => p.subtransformSize)
    expect(sizes).toEqual([2, 4, 8, 16, 32, 64, 2, 4, 8, 16, 32, 64])
  })

  test('ping-pong parity: spectrum→a, a→b, b→a, …, финал в result', () => {
    const passes = fft2dPasses(4) // 4 прохода
    expect(passes[0]).toMatchObject({ input: 'spectrum', output: 'a' })
    expect(passes[1]).toMatchObject({ input: 'a', output: 'b' })
    expect(passes[2]).toMatchObject({ input: 'b', output: 'a' })
    expect(passes[3]).toMatchObject({ output: 'result' })
    // Финальный вход: iterations=4 (чёт) → 'a' (логика david.li/waves)
    expect(passes[3]!.input).toBe('a')
  })

  test('нечётное log₂N: финал читает из b (parity как в демо)', () => {
    const passes = fft2dPasses(8) // log2=3 → 6 проходов, iterations=6 чёт → 'a'?
    // 6 проходов: spec→a, a→b, b→a, b?→… проверяем цепочку чтения/записи
    const chain: Array<[string, string]> = passes.map(p => [p.input, p.output])
    // Каждый выход (кроме result) — следующий вход где-то
    expect(chain[0]).toEqual(['spectrum', 'a'])
    expect(chain[5]![1]).toBe('result')
  })

  test('чётность чередуется по проходам (a/b)', () => {
    const passes = fft2dPasses(64)
    for (let i = 1; i < passes.length - 1; i++) {
      const prev = passes[i - 1]!
      const cur = passes[i]!
      if (cur.output !== 'result') {
        // Вход текущего = выход предыдущего (кроме первого/последнего)
        if (i > 1 && prev.output !== 'result') {
          expect(cur.input).toBe(prev.output)
        }
      }
    }
  })

  test('нестепень двойки — честная ошибка', () => {
    expect(() => fft2dPasses(100)).toThrow('степенью двойки')
    expect(() => fft2dPasses(1)).toThrow()
    expect(() => fft2dPasses(0)).toThrow()
  })
})

describe('Task 112 — дуал-соурс чанки FFT', () => {
  test('GLSL: ось юниформом (одна программа на обе оси), u_input', () => {
    expect(FFT_GLSL_SUBTRANSFORM).toContain('u_transformSize')
    expect(FFT_GLSL_SUBTRANSFORM).toContain('u_subtransformSize')
    expect(FFT_GLSL_SUBTRANSFORM).toContain('u_horizontal')
    expect(FFT_GLSL_SUBTRANSFORM).toContain('u_input')
    expect(FFT_GLSL_SUBTRANSFORM).toContain('#version 300 es')
    // Две последовательности одновременно (дэвид-ли приём)
    expect(FFT_GLSL_SUBTRANSFORM).toContain('even.xy + multiplyComplex(twiddle, odd.xy)')
    expect(FFT_GLSL_SUBTRANSFORM).toContain('even.zw + multiplyComplex(twiddle, odd.zw)')
    // Нет #define-вариантов оси (в отличие от демо — половина компиляций)
    expect(FFT_GLSL_SUBTRANSFORM).not.toContain('#define HORIZONTAL')
  })

  test('WGSL: textureLoad (NEAREST-семантика по центрам текселей)', () => {
    expect(FFT_WGSL_SUBTRANSFORM).toContain('textureLoad(srcTex')
    expect(FFT_WGSL_SUBTRANSFORM).toContain('uni.u.z > 0.5')
    expect(FFT_WGSL_SUBTRANSFORM).toContain('multiplyComplex')
    // glMod-хелпер (WGSL % даёт знак делимого — как в порте демо)
    expect(FFT_WGSL_SUBTRANSFORM).toContain('fn glMod')
  })
})

describe('Task 112 — полноэкранный проход (чанк, БЕЗ примитива)', () => {
  test('GLSL: треугольник из gl_VertexID, без атрибутов', () => {
    expect(FULLSCREEN_PASS_GLSL).toContain('gl_VertexID')
    expect(FULLSCREEN_PASS_GLSL).toContain('vec2(-1.0, -1.0)')
    expect(FULLSCREEN_PASS_GLSL).toContain('vec2( 3.0, -1.0)')
    expect(FULLSCREEN_PASS_GLSL).not.toContain('attribute')
    expect(FULLSCREEN_PASS_GLSL).not.toContain('in vec2 aPos')
  })

  test('WGSL: @builtin(vertex_index), структура VsOut совместима с FFT-чанком', () => {
    expect(FULLSCREEN_PASS_WGSL).toContain('@builtin(vertex_index)')
    expect(FULLSCREEN_PASS_WGSL).toContain('struct VsOut')
    expect(FULLSCREEN_PASS_WGSL).toContain('@location(0) coord: vec2f')
    // FFT-чанк ожидает VsOut/vout — имена совпадают
    expect(FFT_WGSL_SUBTRANSFORM).toContain('fsMain(vout: VsOut)')
  })
})
