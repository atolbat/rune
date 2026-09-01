import { describe, expect, it } from 'bun:test'
import { createSegmentStore } from '../src/tape/segments.ts'
import { createLiveCommand } from '../src/live/liveCommand.ts'
import { buildFrame } from '../src/live/frameBuilder.ts'
import { createTapeWriter, writerView } from '../src/tape/index.ts'
import { OpCode } from '../src/tape/opcodes.ts'
import { signal } from '../src/signal/signal.ts'

describe('live-команды и сегментный кэш', () => {
  it('чистый кадр реплеит кэш без повторного record', () => {
    const segments = createSegmentStore(16)
    let records = 0
    const live = createLiveCommand(segments, writer => {
      records++
      writer.emit(OpCode.Draw, 1, 0, 3, 1)
    })
    const writer = createTapeWriter(8)

    buildFrame([live], writer)
    expect(records).toBe(1)
    expect(writerView(writer).count).toBe(1)

    writer.reset()
    buildFrame([live], writer) // чистый: реплей сегмента
    expect(records).toBe(1)
    expect(writerView(writer).count).toBe(1)
    expect(segments.hits).toBe(1)
  })

  it('every(2): половина кадров без эмита', () => {
    const segments = createSegmentStore(16)
    const live = createLiveCommand(segments, writer => writer.emit(OpCode.Draw, 1, 0, 3, 1)).every(2)
    const writer = createTapeWriter(8)
    let emitted = 0
    for (let frame = 0; frame < 10; frame++) {
      writer.reset()
      buildFrame([live], writer)
      if (writerView(writer).count > 0) emitted++
    }
    expect(emitted).toBe(5)
  })

  it('грязная зависимость заставляет перезаписать сегмент', () => {
    const segments = createSegmentStore(16)
    const spin = signal(0)
    let records = 0
    const live = createLiveCommand(
      segments,
      writer => { records++; writer.emit(OpCode.Draw, spin.value, 0, 3, 1) },
      [spin],
    )
    const writer = createTapeWriter(8)
    buildFrame([live], writer)
    buildFrame([live], writer)
    expect(records).toBe(1) // чисто
    spin.value = 5
    writer.reset()
    buildFrame([live], writer)
    expect(records).toBe(2) // перезапись
    expect(writerView(writer).a[0]).toBe(5)
  })

  it('инвалидация руками тоже перезаписывает', () => {
    const segments = createSegmentStore(16)
    let records = 0
    const live = createLiveCommand(segments, writer => { records++; writer.emit(OpCode.Draw, 1, 0, 3, 1) })
    const writer = createTapeWriter(8)
    buildFrame([live], writer)
    live.invalidate()
    buildFrame([live], writer)
    expect(records).toBe(2)
  })

  it('длинная команда (>64 опов) не обрезается: сегмент целиком', () => {
    // Регрессия: скретч-писатель молча выбрасывал операции после 64-й —
    // «команда без сегмента» теряла хвост без всякой диагностики.
    const segments = createSegmentStore(16)
    const OPS = 200
    const live = createLiveCommand(segments, writer => {
      for (let at = 0; at < OPS; at++) writer.emit(OpCode.Draw, at, 0, 0, 0)
    })
    const writer = createTapeWriter(8)
    buildFrame([live], writer)
    expect(writerView(writer).count).toBe(OPS)

    writer.reset()
    buildFrame([live], writer) // чистый кадр: реплей полного сегмента
    expect(writerView(writer).count).toBe(OPS)
    expect(writerView(writer).a[OPS - 1]).toBe(OPS - 1)
  })
})
