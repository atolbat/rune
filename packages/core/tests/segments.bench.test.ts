import { describe, expect, it } from 'bun:test'
import { measureFrameBuilders } from '../bench/frameBench.ts'

describe('бенчмарк сегментов (smoke)', () => {
  it('кэш быстрее полной перезаписи минимум в 5 раз', () => {
    // 32 опс/команду — репрезентативная draw-команда (юниформ-резолв +
    // value-compare на каждый опс; кэш-реплей пропускает эту работу).
    const result = measureFrameBuilders(300, 32, 8, 5)
    expect(result.speedup).toBeGreaterThan(5)
  })
})
