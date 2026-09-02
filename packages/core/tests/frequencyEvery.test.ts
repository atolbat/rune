import { describe, expect, it } from 'bun:test'
import { createFrequencyArena, createUniformSet, signal, OpCode, createTapeWriter, createSegmentStore, createLiveCommand, buildFrame } from '../src/index.ts'

describe('frequencyArena (dossier idea #3)', () => {
  it('frame- and draw-zones are independent: dirty flags are isolated', () => {
    const arena = createFrequencyArena()
    const camera = createUniformSet('camera', { u_viewProj: 'mat4' }, { frequency: 'frame' })
    camera.attach(type => arena.alloc(type, 'frame'))
    const materials = createUniformSet('material', { u_tint: 'vec4' }, { frequency: 'draw' })
    materials.attach(type => arena.alloc(type, 'draw'))

    expect(camera.offsets.u_viewProj).toBeDefined()
    expect(materials.offsets.u_tint).toBeDefined()
    // Offsets in DIFFERENT arenas — both starting from zero are valid
    expect(arena.frame.usedBytes).toBe(64)
    expect(arena.draw.usedBytes).toBe(16)
  })

  it('frame data is uploaded once; draw data — on changes', () => {
    const arena = createFrequencyArena()
    const cam = createUniformSet('camera', { u_time: 'float' }, { frequency: 'frame' })
    cam.attach(t => arena.alloc(t, 'frame'))
    const mat = createUniformSet('mat', { u_alpha: 'float' }, { frequency: 'draw' })
    mat.attach(t => arena.alloc(t, 'draw'))

    const t = signal(1)
    const a = signal(0.5)
    cam.link({ u_time: t })
    mat.link({ u_alpha: a })

    const writeInto = (target: 'frame' | 'draw') => (offset: number, value: number) => {
      const zone = target === 'frame' ? arena.frame : arena.draw
      zone.writeFloat({ index: 0, offset, size: 4, kind: 'f32' } as never, value)
    }

    // Frame 1: both zones are dirty
    cam.write(writeInto('frame'))
    mat.write(writeInto('draw'))
    expect(arena.frameRanges().length).toBe(1)
    expect(arena.drawRanges().length).toBe(1)
    arena.clearDirty()

    // Frame 2: NOTHING changed — no uploads
    cam.write(writeInto('frame'))
    mat.write(writeInto('draw'))
    expect(arena.frameRanges().length).toBe(0) // value-compare: the same values
    expect(arena.drawRanges().length).toBe(0)

    // Frame 3: the time changed — only the frame zone is dirty
    t.value = 2
    cam.write(writeInto('frame'))
    mat.write(writeInto('draw'))
    expect(arena.frameRanges().length).toBe(1)
    expect(arena.drawRanges().length).toBe(0) // the draw zone is clean — NOT uploaded
  })
})

describe('live().every(n) (dossier idea #1)', () => {
  it('a command with every(2) is emitted every other frame', () => {
    const store = createSegmentStore(8)
    let recordings = 0
    const dep = signal(0)
    const live = createLiveCommand(
      store,
      w => { recordings++; w.emit(OpCode.Draw, 1, 6, 1, 0) },
      [dep],
    ).every(2)

    const out = createTapeWriter(16)
    // Frames 1-4: the emit alternates on and off
    const counts: number[] = []
    for (let frame = 0; frame < 4; frame++) {
      out.reset()
      buildFrame([live], out)
      counts.push(out.count)
    }
    // every(2): half of the frames have no emit
    expect(counts.filter(c => c === 1).length).toBe(2)
    expect(counts.filter(c => c === 0).length).toBe(2)
    expect(recordings).toBeLessThanOrEqual(2) // rewrites only on active frames
  })

  it('every(1) — the normal behavior (every frame)', () => {
    const store = createSegmentStore(8)
    const dep = signal(0)
    const live = createLiveCommand(store, w => w.emit(OpCode.Draw, 1, 6, 1, 0), [dep]).every(1)
    const out = createTapeWriter(8)
    const counts: number[] = []
    for (let frame = 0; frame < 3; frame++) {
      out.reset()
      buildFrame([live], out)
      counts.push(out.count)
    }
    expect(counts).toEqual([1, 1, 1])
  })
})
