import { describe, expect, it } from 'bun:test'
import { measureFrameBuilders } from '../bench/frameBench.ts'

describe('segment benchmark (smoke)', () => {
  it('the cache is at least 4× faster than a full rewrite', () => {
    // 32 ops/command — a representative draw command (uniform resolve +
    // value-compare per op; cache replay skips this work).
    // The ratio is hardware-dependent (record cost vs replay memcpy):
    // shared CI runners measure ~4.5×, dev machines 5–10× — the smoke
    // keeps a conservative 4× margin; best-of-9 smooths scheduler noise.
    const result = measureFrameBuilders(300, 32, 8, 9)
    expect(result.speedup).toBeGreaterThan(4)
  })
})
