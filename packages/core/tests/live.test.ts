import { describe, expect, it } from 'bun:test'
import { createSegmentStore } from '../src/tape/segments.ts'
import { createLiveCommand } from '../src/live/liveCommand.ts'
import { buildFrame } from '../src/live/frameBuilder.ts'
import { createTapeWriter, writerView } from '../src/tape/index.ts'
import { OpCode } from '../src/tape/opcodes.ts'
import { signal } from '../src/signal/signal.ts'

describe('live commands and the segment cache', () => {
  it('a clean frame replays the cache without a repeated record', () => {
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
    buildFrame([live], writer) // clean: segment replay
    expect(records).toBe(1)
    expect(writerView(writer).count).toBe(1)
    expect(segments.hits).toBe(1)
  })

  it('every(2): half of the frames without an emit', () => {
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

  it('a dirty dependency forces a segment rewrite', () => {
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
    expect(records).toBe(1) // clean
    spin.value = 5
    writer.reset()
    buildFrame([live], writer)
    expect(records).toBe(2) // rewrite
    expect(writerView(writer).a[0]).toBe(5)
  })

  it('manual invalidation also rewrites', () => {
    const segments = createSegmentStore(16)
    let records = 0
    const live = createLiveCommand(segments, writer => { records++; writer.emit(OpCode.Draw, 1, 0, 3, 1) })
    const writer = createTapeWriter(8)
    buildFrame([live], writer)
    live.invalidate()
    buildFrame([live], writer)
    expect(records).toBe(2)
  })

  it('a long command (>64 ops) is not truncated: the segment in full', () => {
    // Regression: the scratch writer silently dropped ops after the 64th —
    // a "command without a segment" lost its tail without any diagnostics.
    const segments = createSegmentStore(16)
    const OPS = 200
    const live = createLiveCommand(segments, writer => {
      for (let at = 0; at < OPS; at++) writer.emit(OpCode.Draw, at, 0, 0, 0)
    })
    const writer = createTapeWriter(8)
    buildFrame([live], writer)
    expect(writerView(writer).count).toBe(OPS)

    writer.reset()
    buildFrame([live], writer) // clean frame: replay of the full segment
    expect(writerView(writer).count).toBe(OPS)
    expect(writerView(writer).a[OPS - 1]).toBe(OPS - 1)
  })
})
