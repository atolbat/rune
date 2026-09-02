import { describe, expect, test } from 'bun:test'
import { fftPassPlan } from '../src/gpu/stockham.ts'
import type { FftPass, FftPassInput } from '../src/gpu/stockham.ts'

describe('fftPassPlan — plan shape', () => {
  test('2·log₂N passes; 256 → 16, 512 → 18, 1024 → 20', () => {
    expect(fftPassPlan(256).length).toBe(16)
    expect(fftPassPlan(512).length).toBe(18)
    expect(fftPassPlan(1024).length).toBe(20)
  })

  test('horizontal — the first half, vertical — the second', () => {
    for (const n of [256, 512, 1024]) {
      const plan = fftPassPlan(n)
      const log2n = plan.length / 2
      for (let i = 0; i < plan.length; i++) {
        expect(plan[i].horizontal).toBe(i < log2n)
        expect(plan[i].index).toBe(i)
      }
    }
  })

  test('subtransform sizes: 2,4,…,N on each axis (Stockham)', () => {
    for (const n of [256, 512]) {
      const plan = fftPassPlan(n)
      const log2n = plan.length / 2
      for (let k = 0; k < log2n; k++) {
        expect(plan[k].subtransformSize).toBe(2 ** (k + 1))
        expect(plan[log2n + k].subtransformSize).toBe(2 ** (k + 1))
      }
    }
  })

  test('the first pass reads the spectrum into ping, the last one writes displacement', () => {
    for (const n of [256, 512, 1024]) {
      const plan = fftPassPlan(n)
      expect(plan[0].input).toBe('spectrum')
      expect(plan[0].target).toBe('pingTransform')
      expect(plan[plan.length - 1].target).toBe('displacement')
    }
  })

  test('odd chain length (512): the last pass reads ping; even (256/1024): ping', () => {
    // 2·log₂(512)=18 → even → ping; 256→16 and 1024→20 → even → ping.
    expect(fftPassPlan(512)[17].input).toBe('pingTransform')
    expect(fftPassPlan(256)[15].input).toBe('pingTransform')
    expect(fftPassPlan(1024)[19].input).toBe('pingTransform')
  })
})

describe('fftPassPlan — ping-pong invariants (Task 114 anti-regression)', () => {
  test('CHAIN: every pass reads what the previous one wrote', () => {
    // Exactly this was broken in the WebGL2 port for even log₂N (N=256):
    // the first vertical pass read a stale texture.
    for (const n of [8, 16, 256, 512, 1024]) {
      const plan = fftPassPlan(n)
      for (let i = 1; i < plan.length; i++) {
        // the previous target is always ping/pong (displacement is written only
        // by the last pass, there are no readers after it); TS does not know this.
        expect(plan[i].input).toBe(plan[i - 1].target as FftPassInput)
      }
    }
  })

  test('no pass reads its own target texture', () => {
    for (const n of [256, 512, 1024]) {
      const plan: readonly FftPass[] = fftPassPlan(n)
      for (const pass of plan) {
        expect(pass.input === pass.target).toBe(false)
      }
    }
  })

  test('the horizontal→vertical junction continues the chain (N=256: pong→pong)', () => {
    const plan = fftPassPlan(256)
    expect(plan[7].target).toBe('pongTransform')
    expect(plan[8].input).toBe('pongTransform')
    expect(plan[8].horizontal).toBe(false)
  })

  test('invalid resolutions are rejected', () => {
    expect(() => fftPassPlan(0)).toThrow()
    expect(() => fftPassPlan(1)).toThrow()
    expect(() => fftPassPlan(100)).toThrow() // not a power of two
    expect(() => fftPassPlan(3.5)).toThrow()
    expect(() => fftPassPlan(-512)).toThrow()
  })
})
