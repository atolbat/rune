import { describe, expect, it } from 'bun:test'
import { measureFrameBuilders } from '../bench/frameBench.ts'

describe('segment benchmark (smoke)', () => {
  it('the cache is at least 3× faster than a full rewrite', () => {
    // 32 ops/command — a representative draw command (uniform resolve +
    // value-compare per op; cache replay skips this work).
    // The ratio is hardware-dependent (record cost vs replay memcpy):
    // shared CI runners measure ~4.5× best-of, dev machines 5–10× — but a
    // CONTENDED runner can shave a whole rep window (the CI test suite
    // only started running at all after Task 173b fixed the typecheck
    // wall, and this smoke flaked on its first CI appearance at 4×).
    // The smoke's subject is the MECHANISM: a broken cache replays the
    // full record path (ratio ~1×), a working one is multiples faster —
    // 3× keeps that verdict decisive with CI-contention headroom;
    // best-of-12 smooths scheduler noise.
    const result = measureFrameBuilders(300, 32, 8, 12)
    expect(result.speedup).toBeGreaterThan(3)
  })
})
