import { describe, expect, test } from 'bun:test'
import { fftPassPlan } from '../src/gpu/stockham.ts'
import type { FftPass, FftPassInput } from '../src/gpu/stockham.ts'

describe('fftPassPlan — форма плана', () => {
  test('2·log₂N проходов; 256 → 16, 512 → 18, 1024 → 20', () => {
    expect(fftPassPlan(256).length).toBe(16)
    expect(fftPassPlan(512).length).toBe(18)
    expect(fftPassPlan(1024).length).toBe(20)
  })

  test('горизонталь — первая половина, вертикаль — вторая', () => {
    for (const n of [256, 512, 1024]) {
      const plan = fftPassPlan(n)
      const log2n = plan.length / 2
      for (let i = 0; i < plan.length; i++) {
        expect(plan[i].horizontal).toBe(i < log2n)
        expect(plan[i].index).toBe(i)
      }
    }
  })

  test('субтрансформ-размеры: 2,4,…,N на каждой оси (Стокхэм)', () => {
    for (const n of [256, 512]) {
      const plan = fftPassPlan(n)
      const log2n = plan.length / 2
      for (let k = 0; k < log2n; k++) {
        expect(plan[k].subtransformSize).toBe(2 ** (k + 1))
        expect(plan[log2n + k].subtransformSize).toBe(2 ** (k + 1))
      }
    }
  })

  test('первый проход читает спектр в ping, последний пишет displacement', () => {
    for (const n of [256, 512, 1024]) {
      const plan = fftPassPlan(n)
      expect(plan[0].input).toBe('spectrum')
      expect(plan[0].target).toBe('pingTransform')
      expect(plan[plan.length - 1].target).toBe('displacement')
    }
  })

  test('нечётная длина цепочки (512): последний читает ping, чётная (256/1024): ping', () => {
    // 2·log₂(512)=18 → even → ping; 256→16 и 1024→20 → even → ping.
    expect(fftPassPlan(512)[17].input).toBe('pingTransform')
    expect(fftPassPlan(256)[15].input).toBe('pingTransform')
    expect(fftPassPlan(1024)[19].input).toBe('pingTransform')
  })
})

describe('fftPassPlan — инварианты ping-pong (анти-регрессия Task 114)', () => {
  test('ЦЕПОЧКА: каждый проход читает то, что записал предыдущий', () => {
    // Именно это нарушалось в WebGL2-порте при log₂N чётном (N=256):
    // первый вертикальный проход читал протухшую текстуру.
    for (const n of [8, 16, 256, 512, 1024]) {
      const plan = fftPassPlan(n)
      for (let i = 1; i < plan.length; i++) {
        // предыдущая цель — всегда ping/pong (displacement пишет только
        // последний проход, за ним читателей нет); TS этого не знает.
        expect(plan[i].input).toBe(plan[i - 1].target as FftPassInput)
      }
    }
  })

  test('нет прохода, читающего свою целевую текстуру', () => {
    for (const n of [256, 512, 1024]) {
      const plan: readonly FftPass[] = fftPassPlan(n)
      for (const pass of plan) {
        expect(pass.input === pass.target).toBe(false)
      }
    }
  })

  test('стык горизонталь→вертикаль продолжает цепочку (N=256: pong→pong)', () => {
    const plan = fftPassPlan(256)
    expect(plan[7].target).toBe('pongTransform')
    expect(plan[8].input).toBe('pongTransform')
    expect(plan[8].horizontal).toBe(false)
  })

  test('невалидные разрешения отклоняются', () => {
    expect(() => fftPassPlan(0)).toThrow()
    expect(() => fftPassPlan(1)).toThrow()
    expect(() => fftPassPlan(100)).toThrow() // не степень двойки
    expect(() => fftPassPlan(3.5)).toThrow()
    expect(() => fftPassPlan(-512)).toThrow()
  })
})
