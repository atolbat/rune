import { describe, expect, it } from 'bun:test'
import { withJournal } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createJournal } from '@rune/core'
import type { GLFacade } from '@rune/webgl2'
import type { Journal } from '@rune/core'

/**
 * Task 197: the depthBits axis through the journal decorator — the
 * surface({ depthBits: 32 }) Hi-Z parity anchor must not be swallowed by
 * the withJournal wrap (the decorator forwards the 6th argument and the
 * op carries it; absent — the historical 5-arg op, byte-compatible).
 */

describe('journalGl Task 197: createTarget depthBits forward', () => {
  it('depthBits=32 reaches the raw facade and rides the journal op', () => {
    const recording = createRecordingGL()
    const journal = createJournal() as Journal
    const wrapped: GLFacade = withJournal(recording.gl, journal)
    recording.gl.createTexture(64, 64, { format: 'r32f' })

    const id = wrapped.createTarget(1, 64, 64, true, [0, 0, 0, 1], 32)

    expect(id).toBeGreaterThan(0)
    expect(recording.calls).toContain('createTarget(1,64,64,depth,d32)')
    const op = journal.entries().find(e => e.kind === 'createTarget')
    expect(op).toBeDefined()
    expect((op as { depthBits?: number }).depthBits).toBe(32)
  })

  it('absent — the historical op shape (no depthBits field)', () => {
    const recording = createRecordingGL()
    const journal = createJournal() as Journal
    const wrapped: GLFacade = withJournal(recording.gl, journal)
    recording.gl.createTexture(64, 64)

    wrapped.createTarget(1, 64, 64, true, [0, 0, 0, 1])

    expect(recording.calls).toContain('createTarget(1,64,64,depth)')
    const op = journal.entries().find(e => e.kind === 'createTarget') as Record<string, unknown>
    expect(op).toBeDefined()
    expect('depthBits' in op).toBe(false)
  })
})
