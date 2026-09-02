import { describe, expect, it } from 'bun:test'
import { createJournal } from '../src/journal/journal.ts'
import type { DeclOp } from '../src/journal/journal.ts'

/**
 * Journal (M1, §9.5 P3): a registry of long-lived declarations with replay.
 *
 * Contract: Journal.replay = switchBackend = device-loss recovery =
 * = worker migration — one mechanism for three scenarios.
 *
 * These are tests of the primitive itself — without realGL integration.
 * Integration tests (recording via WebGL2Renderer) live in a separate file.
 */

describe('Journal — declaration registry primitive', () => {
  it('record + replay: ops come in record order', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64 })
    journal.record({ kind: 'createProgram', id: 1, vertex: 'V', fragment: 'F' })
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([1, 2, 3]) })

    const seen: string[] = []
    journal.replay(op => { seen.push(op.kind) })
    expect(seen).toEqual(['createTexture', 'createProgram', 'createBuffer'])
    expect(journal.size).toBe(3)
  })

  it('replay is idempotent — a repeated call yields the same sequence', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 8, height: 8 })
    journal.record({ kind: 'destroyTexture', id: 1 })

    const seen1: number[] = []
    journal.replay(op => { if ('id' in op) seen1.push(op.id) })
    const seen2: number[] = []
    journal.replay(op => { if ('id' in op) seen2.push(op.id) })
    expect(seen1).toEqual(seen2)
  })

  it('compact removes create→destroy pairs (heap compaction #13)', () => {
    const journal = createJournal()
    // texture 1: created and destroyed — a pair
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64 })
    journal.record({ kind: 'destroyTexture', id: 1 })
    // texture 2: created, still alive — keep it
    journal.record({ kind: 'createTexture', id: 2, width: 128, height: 128 })
    // program 1: destroyed without create — an anomaly, keep it for audit
    journal.record({ kind: 'destroyProgram', id: 7 })

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'destroyProgram'])
  })

  it('compact does not touch a repeated create of the same id after destroy', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 5, width: 8, height: 8 })
    journal.record({ kind: 'destroyTexture', id: 5 })
    journal.record({ kind: 'createTexture', id: 5, width: 16, height: 16 }) // re-creation

    journal.compact()
    // create 8x8 + destroy 5 — a pair, drop it; the second create 16x16 remains
    expect(journal.entries()).toEqual([
      { kind: 'createTexture', id: 5, width: 16, height: 16 },
    ])
  })

  it('snapshot — a deep copy: mutating the original does not change the snapshot', () => {
    const journal = createJournal()
    const data = new Float32Array([1, 2, 3])
    journal.record({ kind: 'createBuffer', id: 1, data })
    journal.record({ kind: 'createTexture', id: 1, width: 8, height: 8 })

    const snap = journal.snapshot()
    // Add one more op to the original — the snapshot must not change
    journal.record({ kind: 'destroyTexture', id: 1 })
    expect(snap.ops.length).toBe(2)
    expect(journal.size).toBe(3)

    // Mutating the source Float32Array must not change the snapshot copy
    data[0] = 999
    const snapBuffer = snap.ops.find(op => op.kind === 'createBuffer') as Extract<DeclOp, { kind: 'createBuffer' }>
    expect(snapBuffer.data[0]).toBe(1) // snapshot is isolated
  })

  it('evict(predicate) removes ops matching the predicate (#14 lazy re-declaration)', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64 })
    journal.record({ kind: 'createTexture', id: 2, width: 128, height: 128 })
    journal.record({ kind: 'createTexture', id: 3, width: 256, height: 256 })

    // Remove only the small textures (64x64)
    journal.evict(op => op.kind === 'createTexture' && op.width === 64)
    const ids = journal.entries().map(op => 'id' in op ? op.id : -1)
    expect(ids).toEqual([2, 3])
  })

  it('reset clears the journal to an empty state', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 8, height: 8 })
    expect(journal.size).toBe(1)
    journal.reset()
    expect(journal.size).toBe(0)
    expect(journal.entries()).toEqual([])
  })

  it('entries() returns a readonly slice — cannot be mutated from outside', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 8, height: 8 })
    const entries = journal.entries() as DeclOp[]
    // push returns a new number, but it is not applied to journal (readonly-typed return)
    // Check that entries is just a slice array and the original lives separately:
    expect(() => entries.push({ kind: 'destroyTexture', id: 999 } as DeclOp)).not.toThrow()
    // journal.size did not change — the push did not reach the original array
    expect(journal.size).toBe(1)
  })

  it('replay end-to-end into a mock sink — all declarations arrive', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64 })
    journal.record({ kind: 'createProgram', id: 1, vertex: 'attribute vec2 a; void main(){}', fragment: 'precision mediump float; void main(){}' })
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([0, 0, 1, 0, 0, 1]) })
    journal.record({ kind: 'createTarget', id: 1, textureId: 1, width: 64, height: 64, depth: true, color: [0.1, 0.1, 0.1, 1] })
    journal.record({ kind: 'texImage2DFromSource', textureId: 1, sourceKind: 'ImageBitmap', flipY: false })

    const calls: string[] = []
    journal.replay(op => {
      switch (op.kind) {
        case 'createTexture': calls.push(`createTexture(${op.width}x${op.height})→id=${op.id}`); break
        case 'createProgram': calls.push(`createProgram(vs=${op.vertex.length},fs=${op.fragment.length})→id=${op.id}`); break
        case 'createBuffer': calls.push(`createBuffer(${op.data.length} floats)→id=${op.id}`); break
        case 'createTarget': calls.push(`createTarget(tex=${op.textureId},${op.width}x${op.height},depth=${op.depth})→id=${op.id}`); break
        case 'texImage2DFromSource': calls.push(`texImage2DFromSource(tex=${op.textureId},${op.sourceKind},flipY=${op.flipY})`); break
        default: /* destroy ops — not expected in this test */ break
      }
    })
    expect(calls).toEqual([
      'createTexture(64x64)→id=1',
      'createProgram(vs=31,fs=38)→id=1',
      'createBuffer(6 floats)→id=1',
      'createTarget(tex=1,64x64,depth=true)→id=1',
      'texImage2DFromSource(tex=1,ImageBitmap,flipY=false)',
    ])
  })

  it('order of "all four resources": a typical device-loss recovery cycle', () => {
    // Scenario: the user created a texture, a program, a buffer, a target;
    // then the device is lost. Journal.replay must recreate ALL
    // four resources in the correct order (createTexture → createProgram →
    // createBuffer → createTarget, because target depends on texture).
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 800, height: 600 })
    journal.record({ kind: 'createProgram', id: 1, vertex: 'vs', fragment: 'fs' })
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array(36) })
    journal.record({ kind: 'createTarget', id: 1, textureId: 1, width: 800, height: 600, depth: true, color: [0, 0, 0, 1] })

    // A mock of the new facade: counts create ops
    const recreated: string[] = []
    journal.replay(op => {
      if (op.kind.startsWith('create')) recreated.push(op.kind)
    })
    expect(recreated).toEqual(['createTexture', 'createProgram', 'createBuffer', 'createTarget'])
  })

  // ─── Task 56: sub-mip views (createTextureView / destroyTextureView) ──────

  it('Task 56: createTextureView is recorded and read back via replay', () => {
    // Scenario: the user created a mip-chain texture + a sub-mip view.
    // After device loss journal.replay must recreate both.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 256, height: 256, options: { mipLevels: 9 } })
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 1, baseMipLevel: 2, mipLevelCount: 3 })

    const recreated: string[] = []
    journal.replay(op => {
      if (op.kind === 'createTextureView') recreated.push(`view id=${op.id} tex=${op.textureId} mip=${op.baseMipLevel}+${op.mipLevelCount}`)
      else if (op.kind === 'createTexture') recreated.push(`texture id=${op.id} ${op.width}x${op.height} mip=${op.options?.mipLevels ?? 1}`)
    })
    expect(recreated).toEqual([
      'texture id=1 256x256 mip=9',
      'view id=1000000 tex=1 mip=2+3',
    ])
  })

  it('Task 56: compact removes create→destroy textureView pairs', () => {
    // Scenario: the view was created and immediately destroyed in one session —
    // compact must remove both ops (as for createTexture).
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64, options: { mipLevels: 7 } })
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 1, baseMipLevel: 1, mipLevelCount: 2 })
    journal.record({ kind: 'destroyTextureView', id: 1_000_000 }) // a pair — both get removed
    journal.record({ kind: 'createTextureView', id: 1_000_001, textureId: 1, baseMipLevel: 3 }) // a live view

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'createTextureView'])
    const view = journal.entries().find(op => op.kind === 'createTextureView') as Extract<DeclOp, { kind: 'createTextureView' }>
    expect(view.id).toBe(1_000_001) // the second view remains, not destroyed
  })

  it('Task 56: snapshot isolates createTextureView ops (deep copy)', () => {
    // Scenario: the snapshot must contain the createTextureView ops as is.
    // Deep copy — adding new ops to the original does not touch the snapshot.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64, options: { mipLevels: 7 } })
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 1, baseMipLevel: 2, mipLevelCount: 3 })

    const snap = journal.snapshot()
    expect(snap.ops.length).toBe(2)
    // Add one more op to the original — the snapshot must not change
    journal.record({ kind: 'destroyTextureView', id: 1_000_000 })
    expect(snap.ops.length).toBe(2)
    expect(journal.size).toBe(3)
  })

  it('Task 56: evict removes createTextureView by predicate (lazy re-declaration)', () => {
    // Scenario: the user decides to drop all sub-views with baseMipLevel ≥ 5
    // (e.g. deep mips with low priority). evict must remove
    // only those, leaving the rest.
    const journal = createJournal()
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 1, baseMipLevel: 2 })
    journal.record({ kind: 'createTextureView', id: 1_000_001, textureId: 1, baseMipLevel: 5 })
    journal.record({ kind: 'createTextureView', id: 1_000_002, textureId: 1, baseMipLevel: 8 })

    journal.evict(op => op.kind === 'createTextureView' && (op.baseMipLevel ?? 0) >= 5)
    const ids = journal.entries()
      .filter(op => op.kind === 'createTextureView')
      .map(op => (op as { id: number }).id)
    expect(ids).toEqual([1_000_000]) // only the view with baseMipLevel=2 remains
  })

  // ── Task 61: JSON round-trip (worker migration) + compact prune ──────────────

  it('Task 61: record normalizes createBuffer.data from a JSON round-trip (plain-object → Float32Array)', () => {
    // Worker migration scenario: JSON.stringify(Float32Array) yields
    // {"0":v0,"1":v1,...}, JSON.parse — a plain object without .slice().
    // Regression: "Unhandled rejection: op.data.slice is not a function".
    const journal = createJournal()
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([1.5, 2.5, 3.5]) })

    const json = JSON.stringify(journal.snapshot().ops)
    const parsed = JSON.parse(json) as DeclOp[]

    // The parsed op is a plain object (JSON itself does not store the type)
    const parsedBuf = parsed.find(op => op.kind === 'createBuffer') as { data: unknown }
    expect(parsedBuf.data instanceof Float32Array).toBe(false)

    // record() normalizes it back into a Float32Array
    const workerJournal = createJournal()
    for (const op of parsed) workerJournal.record(op)
    const restored = workerJournal.entries().find(op => op.kind === 'createBuffer') as { data: Float32Array }
    expect(restored.data instanceof Float32Array).toBe(true)
    expect(Array.from(restored.data)).toEqual([1.5, 2.5, 3.5])
  })

  it('Task 61: record normalizes createBuffer.data from number[]', () => {
    const journal = createJournal()
    journal.record({ kind: 'createBuffer', id: 1, data: [4, 5, 6] as unknown as Float32Array })
    const buf = journal.entries()[0] as { data: Float32Array }
    expect(buf.data instanceof Float32Array).toBe(true)
    expect(Array.from(buf.data)).toEqual([4, 5, 6])
  })

  it('Task 61: snapshot() does not crash on a journal built from JSON round-trip ops', () => {
    // Full cycle: live journal → JSON → worker journal → snapshot again.
    // Previously the second snapshot crashed: op.data.slice is not a function.
    const journal = createJournal()
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([9, 8, 7]) })
    journal.record({ kind: 'createTexture', id: 1, width: 32, height: 32 })

    const json = JSON.stringify(journal.snapshot().ops)
    const workerJournal = createJournal()
    for (const op of JSON.parse(json) as DeclOp[]) workerJournal.record(op)

    // Main assert: the second snapshot does not throw and yields a correct copy
    const snap2 = workerJournal.snapshot()
    expect(snap2.ops.length).toBe(2)
    const buf = snap2.ops.find(op => op.kind === 'createBuffer') as { data: Float32Array }
    expect(buf.data instanceof Float32Array).toBe(true)
    expect(Array.from(buf.data)).toEqual([9, 8, 7])
  })

  it('Task 61: compact removes texImage2DFromSource of a destroyed texture', () => {
    // Scenario: a texture was created, filled with a full upload, destroyed.
    // The create+destroy pair goes away (existing behavior), and the dependent
    // texImage2DFromSource must go away too — otherwise replay will crash on
    // a nonexistent textureId.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 5, width: 64, height: 64 })
    journal.record({ kind: 'texImage2DFromSource', textureId: 5, sourceKind: 'ImageBitmap', flipY: false })
    journal.record({ kind: 'destroyTexture', id: 5 })

    journal.compact()
    expect(journal.entries()).toEqual([])
  })

  it('Task 61: compact keeps texImage2DFromSource of a live texture', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 5, width: 64, height: 64 })
    journal.record({ kind: 'texImage2DFromSource', textureId: 5, sourceKind: 'ImageBitmap', flipY: true })
    journal.record({ kind: 'createTexture', id: 6, width: 64, height: 64 })
    journal.record({ kind: 'destroyTexture', id: 6 })

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'texImage2DFromSource'])
  })

  it('Task 61: compact removes createTextureView and createTarget of a dead texture (+ their destroy)', () => {
    // A view/target on a destroyed texture is not restored; its own
    // destroy ops are dropped too (no orphans left behind).
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 3, width: 64, height: 64, options: { mipLevels: 4 } })
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 3, baseMipLevel: 1 })
    journal.record({ kind: 'createTarget', id: 10, textureId: 3, width: 64, height: 64, depth: false, color: [0, 0, 0, 1] })
    journal.record({ kind: 'destroyTextureView', id: 1_000_000 })
    journal.record({ kind: 'destroyTarget', id: 10 })
    journal.record({ kind: 'destroyTexture', id: 3 })

    journal.compact()
    expect(journal.entries()).toEqual([])
  })

  it('Task 61: compact keeps view/target of a live texture', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 3, width: 64, height: 64, options: { mipLevels: 4 } })
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 3, baseMipLevel: 1, mipLevelCount: 2 })
    journal.record({ kind: 'createTarget', id: 11, textureId: 3, width: 64, height: 64, depth: false, color: [0, 0, 0, 1] })

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'createTextureView', 'createTarget'])
  })

  it('Task 61: compact — destroy→create texture re-creation removes the texImage of the dead incarnation', () => {
    // The id is reused after destroy (re-creation): the LAST
    // create survives (the new incarnation), while texImage2DFromSource stood BEFORE it —
    // the content belonged to the dead 32x32 incarnation and is not restored.
    // Otherwise replay would run the upload BEFORE the texture create.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 7, width: 32, height: 32 })
    journal.record({ kind: 'texImage2DFromSource', textureId: 7, sourceKind: 'ImageBitmap', flipY: false })
    journal.record({ kind: 'destroyTexture', id: 7 })
    journal.record({ kind: 'createTexture', id: 7, width: 64, height: 64 })

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture'])
    const tex = journal.entries()[0] as { width: number; height: number }
    expect(tex.width).toBe(64) // the new incarnation survived, not the old one
  })

  it('Task 61: compact — a repeat upload AFTER re-creation is kept', () => {
    // create → texImage → destroy → create → texImage: the second upload stands
    // after the last create — it is alive and replays.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 7, width: 32, height: 32 })
    journal.record({ kind: 'texImage2DFromSource', textureId: 7, sourceKind: 'ImageBitmap', flipY: false })
    journal.record({ kind: 'destroyTexture', id: 7 })
    journal.record({ kind: 'createTexture', id: 7, width: 64, height: 64 })
    journal.record({ kind: 'texImage2DFromSource', textureId: 7, sourceKind: 'ImageBitmap', flipY: true })

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'texImage2DFromSource'])
  })
})
