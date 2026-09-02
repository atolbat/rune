import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import { replayJournalOn } from '../src/journalGl.ts'
import { createJournal } from '@rune/core'
import { createRecordingGL } from '@rune/webgl2'
import type { GLImageSource } from '@rune/webgl2'

/**
 * Journal integration with WebGL2Renderer:
 * 1. createWebGL2Renderer({ journal }) — wraps the GLFacade with the withJournal decorator
 * 2. All long-lived create* ops are written to the journal automatically
 * 3. replayJournalOn(journal, newGL, sourceFor) — restores the state on a fresh facade
 *
 * Device-loss recovery scenario:
 * 1. The user created a texture, a program, a buffer, a target — the Journal recorded it
 * 2. The device was lost (the old GLFacade died)
 * 3. A new GLFacade is created (via createGL)
 * 4. replayJournalOn(journal, newGL) — recreates all resources in the right order
 *
 * The texImage2DFromSource source is not serialized — during replay the user
 * passes a sourceFor(kind) callback that returns a ready source.
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

function fakeBitmap(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close: () => {} } as unknown as ImageBitmap
}

describe('Journal integration with WebGL2Renderer', () => {
  it('createTexture/createProgram/createBuffer/createTarget are written to the journal automatically', () => {
    const journal = createJournal()
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      journal,
    })

    // surface creates a texture (target) — it must be recorded
    renderer.surface({ width: 64, height: 64, depth: true })
    // command() — compiles the spec; createProgram+createBuffer lazily in the executor

    // surface recorded createTexture + createTarget
    const texOps = journal.entries().filter(op => op.kind === 'createTexture')
    const targetOps = journal.entries().filter(op => op.kind === 'createTarget')
    expect(texOps.length).toBe(1)
    expect(targetOps.length).toBe(1)
    renderer.stop()
  })

  it('texture.uploadImage(source) writes a texImage2DFromSource op into the journal', () => {
    const journal = createJournal()
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      journal,
    })
    const tex = renderer.texture(32, 32)
    // Clear the journal before uploadImage to isolate
    journal.reset()
    tex.uploadImage(fakeBitmap(32, 32) as GLImageSource)
    const uploadOps = journal.entries().filter(op => op.kind === 'texImage2DFromSource')
    expect(uploadOps.length).toBe(1)
    const op = uploadOps[0] as Extract<typeof uploadOps[number], { kind: 'texImage2DFromSource' }>
    expect(op.textureId).toBe(tex.textureId)
    expect(op.sourceKind).toBe('ImageBitmap')
    expect(op.flipY).toBe(false) // default
    renderer.stop()
  })

  it('replayJournalOn restores resources on a fresh facade in the right order', () => {
    // Phase 1: the first renderer created resources, the journal recorded them
    const journal = createJournal()
    const oldRecording = createRecordingGL()
    const oldRenderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => oldRecording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      journal,
    })
    const surf = oldRenderer.surface({ width: 64, height: 64, depth: true })
    const tex = oldRenderer.texture(16, 16)
    tex.uploadImage(fakeBitmap(16, 16) as GLImageSource, { flipY: false })
    // compact() — remove garbage (there should be no create+destroy pairs here,
    // but it is safe)
    journal.compact()
    const originalOps = journal.entries().slice()
    oldRenderer.stop()

    // Phase 2: "the device is lost" — we create a NEW facade and replay it
    const newRecording = createRecordingGL()
    const sourceFor = (kind: string): GLImageSource | null => {
      if (kind === 'ImageBitmap') return fakeBitmap(16, 16) as GLImageSource
      return null
    }
    replayJournalOn(journal, newRecording.gl, sourceFor)

    // All create ops arrived: createTexture (×2 — surface + manual), createTarget, texImage2DFromSource
    const newCreateTex = newRecording.calls.filter(c => c.startsWith('createTexture')).length
    const newCreateTarget = newRecording.calls.filter(c => c.startsWith('createTarget')).length
    const newTexImage = newRecording.calls.filter(c => c.startsWith('texImage2DFromSource')).length

    // surface creates createTexture + createTarget; the manual texture — another createTexture
    expect(newCreateTex).toBeGreaterThanOrEqual(2)
    expect(newCreateTarget).toBe(1)
    expect(newTexImage).toBe(1)
    // texImage2DFromSource in the journal with flipY=false
    const newTexImageCall = newRecording.calls.find(c => c.startsWith('texImage2DFromSource'))
    expect(newTexImageCall).toContain('flipY=false')

    // The original journal did not mutate during replay (snapshot semantics implicitly via append-only)
    expect(journal.entries().length).toBe(originalOps.length)
  })

  it('replayJournalOn without sourceFor: texImage2DFromSource is skipped (without an exception)', () => {
    const journal = createJournal()
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      journal,
    })
    const tex = renderer.texture(8, 8)
    tex.uploadImage(fakeBitmap(8, 8) as GLImageSource)
    renderer.stop()

    // a fresh facade, WITHOUT sourceFor
    const newRecording = createRecordingGL()
    expect(() => replayJournalOn(journal, newRecording.gl)).not.toThrow()
    // createTexture — arrived; texImage2DFromSource — skipped
    expect(newRecording.calls.some(c => c.startsWith('createTexture'))).toBe(true)
    expect(newRecording.calls.some(c => c.startsWith('texImage2DFromSource'))).toBe(false)
  })

  it('snapshot+replay: restore from a snapshot, the original keeps growing', () => {
    // Scenario #41 resume-snapshot: fix the journal state,
    // keep working, then restore from the snapshot
    const journal = createJournal()
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      journal,
    })
    renderer.surface({ width: 64, height: 64, depth: true })
    const snap = journal.snapshot()
    // After the snapshot — more resources
    renderer.texture(32, 32)

    // Replay the snapshot only (without the second texture)
    const newRecording = createRecordingGL()
    const snapJournal = {
      replay: (apply: (op: never) => void) => { snap.ops.forEach(op => apply(op as never)) },
    }
    replayJournalOn(snapJournal as never, newRecording.gl)
    const newTex = newRecording.calls.filter(c => c.startsWith('createTexture')).length
    const newTarget = newRecording.calls.filter(c => c.startsWith('createTarget')).length
    // snap contained 1 texture (surface) + 1 target
    expect(newTex).toBe(1)
    expect(newTarget).toBe(1)
    renderer.stop()
  })

  it('Task 61: JSON round-trip replay — createBuffer with plain-object data does not crash and reaches the facade as Float32Array', () => {
    // Regression "Unhandled rejection: op.data.slice is not a function":
    // worker migration serializes the journal to JSON. JSON.stringify(Float32Array)
    // gives {"0":v0,...}; after JSON.parse createBuffer.data — a plain object.
    // The live path: record() normalizes it into a Float32Array, replayJournalOn
    // passes the correct type to the facade, a repeated snapshot() does not throw.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 32, height: 32 })
    journal.record({ kind: 'createProgram', id: 1, vertex: 'V', fragment: 'F' })
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([1, 2, 3, 4, 5, 6]) })

    // Worker migration: JSON → postMessage → JSON.parse → a new journal
    const json = JSON.stringify(journal.snapshot().ops)
    const parsed = JSON.parse(json) as { kind: string; data?: unknown }[]
    // The JSON itself has indeed "rotted": data — a plain object without .slice
    const parsedBuf = parsed.find(op => op.kind === 'createBuffer')!
    expect(typeof (parsedBuf.data as { slice?: unknown }).slice).toBe('undefined')

    const workerJournal = createJournal()
    for (const op of parsed as never[]) workerJournal.record(op)

    // A repeated snapshot (a second device-loss) — used to crash on op.data.slice
    expect(() => workerJournal.snapshot()).not.toThrow()

    // Replay on a fresh facade — does not throw, the buffer arrives with length 6
    const newRecording = createRecordingGL()
    expect(() => replayJournalOn(workerJournal, newRecording.gl)).not.toThrow()
    const bufCall = newRecording.calls.find(c => c.startsWith('createBuffer'))
    expect(bufCall).toBe('createBuffer(6)')
  })
})
