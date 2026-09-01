import { describe, expect, it } from 'bun:test'
import { createFrequencyArena, createUniformSet, signal, OpCode, createTapeWriter, createSegmentStore, createLiveCommand, buildFrame } from '../src/index.ts'

describe('frequencyArena (идея №3 досье)', () => {
  it('frame- и draw-зоны независимы: dirty изолированы', () => {
    const arena = createFrequencyArena()
    const camera = createUniformSet('camera', { u_viewProj: 'mat4' }, { frequency: 'frame' })
    camera.attach(type => arena.alloc(type, 'frame'))
    const materials = createUniformSet('material', { u_tint: 'vec4' }, { frequency: 'draw' })
    materials.attach(type => arena.alloc(type, 'draw'))

    expect(camera.offsets.u_viewProj).toBeDefined()
    expect(materials.offsets.u_tint).toBeDefined()
    // Смещения в РАЗНЫХ аренах — обе от нуля допустимы
    expect(arena.frame.usedBytes).toBe(64)
    expect(arena.draw.usedBytes).toBe(16)
  })

  it('frame-данные грузятся один раз; draw-данные — при изменениях', () => {
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

    // Кадр 1: обе зоны грязные
    cam.write(writeInto('frame'))
    mat.write(writeInto('draw'))
    expect(arena.frameRanges().length).toBe(1)
    expect(arena.drawRanges().length).toBe(1)
    arena.clearDirty()

    // Кадр 2: НИЧЕГО не изменилось — загрузок нет
    cam.write(writeInto('frame'))
    mat.write(writeInto('draw'))
    expect(arena.frameRanges().length).toBe(0) // value-compare: те же значения
    expect(arena.drawRanges().length).toBe(0)

    // Кадр 3: сменилось время — только frame-зона грязная
    t.value = 2
    cam.write(writeInto('frame'))
    mat.write(writeInto('draw'))
    expect(arena.frameRanges().length).toBe(1)
    expect(arena.drawRanges().length).toBe(0) // draw-зона чиста — НЕ грузится
  })
})

describe('live().every(n) (идея №1 досье)', () => {
  it('команда с every(2) эмитится через кадр', () => {
    const store = createSegmentStore(8)
    let recordings = 0
    const dep = signal(0)
    const live = createLiveCommand(
      store,
      w => { recordings++; w.emit(OpCode.Draw, 1, 6, 1, 0) },
      [dep],
    ).every(2)

    const out = createTapeWriter(16)
    // Кадры 1-4: эмит то есть, то нет
    const counts: number[] = []
    for (let frame = 0; frame < 4; frame++) {
      out.reset()
      buildFrame([live], out)
      counts.push(out.count)
    }
    // every(2): половина кадров без эмита
    expect(counts.filter(c => c === 1).length).toBe(2)
    expect(counts.filter(c => c === 0).length).toBe(2)
    expect(recordings).toBeLessThanOrEqual(2) // перезаписи только в активные кадры
  })

  it('every(1) — обычное поведение (каждый кадр)', () => {
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
