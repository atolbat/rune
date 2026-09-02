import { describe, expect, it } from 'bun:test'
import { measureFrameBuilders } from '../bench/frameBench.ts'

describe('segment benchmark (smoke)', () => {
  it('the cache is at least 5× faster than a full rewrite', () => {
    // 32 ops/command — a representative draw command (uniform resolve +
    // value-compare per op; cache replay skips this work).
    const result = measureFrameBuilders(300, 32, 8, 5)
    expect(result.speedup).toBeGreaterThan(5)
  })
})
