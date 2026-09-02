import { describe, expect, it } from 'bun:test'
import { createLayoutGuard } from '../src/transport/layoutGuard.ts'

describe('layoutGuard (anti-DPR loop)', () => {
  it('same size — ignore', () => {
    const guard = createLayoutGuard()
    expect(guard.classify(800, 600).verdict).toBe('apply')
    expect(guard.classify(800, 600).verdict).toBe('ignore')
  })

  it('a new size — apply', () => {
    const guard = createLayoutGuard()
    guard.classify(800, 600)
    expect(guard.classify(1024, 768).verdict).toBe('apply')
  })

  it('sawtooth A→B→A→B — runaway (the DPR incident)', () => {
    const guard = createLayoutGuard()
    guard.classify(800, 600)
    guard.classify(801, 600)
    guard.classify(800, 600)
    expect(guard.classify(801, 600).verdict).toBe('runaway')
  })
})
