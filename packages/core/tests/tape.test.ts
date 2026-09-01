import { describe, expect, it } from 'bun:test'
import { createTapeWriter, writerView } from '../src/tape/index.ts'
import { OpCode } from '../src/tape/opcodes.ts'

describe('ленты', () => {
  it('emit → view: колонки согласованы', () => {
    const writer = createTapeWriter(4)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    writer.emit(OpCode.Draw, 7, 0, 36, 1)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    const view = writerView(writer)
    expect(view.count).toBe(3)
    expect(view.op[0]).toBe(OpCode.BeginPass)
    expect(view.op[1]).toBe(OpCode.Draw)
    expect(view.a[1]).toBe(7)
    expect(view.c[1]).toBe(36)
    expect(view.d[1]).toBe(1)
  })

  it('reset очищает ленту без аллокаций', () => {
    const writer = createTapeWriter(4)
    writer.emit(OpCode.Draw, 1, 0, 3, 1)
    writer.reset()
    expect(writerView(writer).count).toBe(0)
  })

  it('рост колонок вдвое без потери данных', () => {
    const writer = createTapeWriter(2)
    for (let at = 0; at < 10; at++) writer.emit(OpCode.Draw, at, 0, 3, 1)
    const view = writerView(writer)
    expect(view.count).toBe(10)
    expect(view.a[9]).toBe(9)
  })
})
