import { describe, expect, it } from 'bun:test'
import { createFanout, pickFanoutMode } from '../src/fanout.ts'
import type { AnyCanvas } from '../src/canvasHelpers.ts'

// Headless-тесты без DOM-канвасов: логика фан-аута покрыта через инъекцию
// copy (счёт вызовов, порядок, состав целей) + чистую pickFanoutMode.
// Реальные drawImage/transfer-пути — бенч demo/bench-present.html (браузер).

/** Фейк канваса-цели: просто идентичность для инъецированной копии. */
function fakeCanvas(name: string): AnyCanvas {
  return { name, width: 64, height: 64 } as unknown as AnyCanvas
}

/** Фейк передаваемого источника: OffscreenCanvas-duck-typing. */
function fakeOffscreen(name: string): AnyCanvas {
  return {
    name,
    width: 256,
    height: 256,
    transferToImageBitmap: () => ({ close: () => {} }),
  } as unknown as AnyCanvas
}

/** Фейк видимого WebGL-канваса (HTMLCanvasElement: transfer НЕТ). */
function fakeHtmlCanvas(name: string): AnyCanvas {
  return { name, width: 256, height: 256 } as unknown as AnyCanvas
}

describe('pickFanoutMode', () => {
  it('auto: одна цель + OffscreenCanvas-источник → bitmap', () => {
    expect(pickFanoutMode(fakeOffscreen('src'), [fakeCanvas('one')])).toBe('bitmap')
  })

  it('auto: HTMLCanvasElement-источник → 2d (transferToImageBitmap нет)', () => {
    expect(pickFanoutMode(fakeHtmlCanvas('src'), [fakeCanvas('one')])).toBe('2d')
  })

  it('auto: много целей → 2d даже с передаваемым источником (transfer потребляет битмап)', () => {
    expect(pickFanoutMode(fakeOffscreen('src'), [fakeCanvas('a'), fakeCanvas('b')])).toBe('2d')
  })

  it('auto: ноль целей → 2d (деградация до безопасного режима)', () => {
    expect(pickFanoutMode(fakeOffscreen('src'), [])).toBe('2d')
  })

  it('явные режимы проходят как есть', () => {
    expect(pickFanoutMode(fakeHtmlCanvas('src'), [], '2d')).toBe('2d')
    expect(pickFanoutMode(fakeOffscreen('src'), [fakeCanvas('one')], 'bitmap')).toBe('bitmap')
  })
})

describe('createFanout: режим 2d (инъецированная копия)', () => {
  it('copy() зовёт копию для каждой цели в порядке добавления', () => {
    const calls: string[] = []
    const a = fakeCanvas('a')
    const b = fakeCanvas('b')
    const fan = createFanout(fakeHtmlCanvas('src'), [a, b], {
      copy: (_src, dst) => calls.push((dst as unknown as { name: string }).name),
    })
    fan.copy()
    fan.copy()
    expect(calls).toEqual(['a', 'b', 'a', 'b'])
  })

  it('add/remove меняют состав целей; remove идемпотентен', () => {
    const calls: string[] = []
    const a = fakeCanvas('a')
    const b = fakeCanvas('b')
    const fan = createFanout(fakeHtmlCanvas('src'), [a], {
      copy: (_src, dst) => calls.push((dst as unknown as { name: string }).name),
    })
    fan.add(b)
    fan.remove(a)
    fan.remove(a) // повтор — no-op
    fan.copy()
    expect(calls).toEqual(['b'])
    expect(fan.targets).toEqual([b])
  })

  it('add дедуплицирует ту же цель', () => {
    const a = fakeCanvas('a')
    const fan = createFanout(fakeHtmlCanvas('src'), [a], { copy: () => {} })
    fan.add(a)
    expect(fan.targets).toEqual([a])
  })

  it('dispose: copy() — no-op, dispose идемпотентен', () => {
    let copies = 0
    const fan = createFanout(fakeHtmlCanvas('src'), [fakeCanvas('a')], {
      copy: () => { copies++ },
    })
    fan.dispose()
    fan.dispose()
    fan.copy()
    expect(copies).toBe(0)
    expect(fan.targets).toEqual([])
  })

  it('add после dispose — no-op', () => {
    const fan = createFanout(fakeHtmlCanvas('src'), [], { copy: () => {} })
    fan.dispose()
    fan.add(fakeCanvas('late'))
    expect(fan.targets).toEqual([])
  })

  it('copy без целей — легальный no-op', () => {
    const fan = createFanout(fakeHtmlCanvas('src'), [], { copy: () => { throw new Error('не должно зваться') } })
    fan.copy()
  })
})

describe('createFanout: режим bitmap (гварды)', () => {
  it('непередаваемый источник + mode bitmap → честная ошибка', () => {
    expect(() => createFanout(fakeHtmlCanvas('src'), [fakeCanvas('one')], { mode: 'bitmap' }))
      .toThrow(/OffscreenCanvas/)
  })

  it('две цели + mode bitmap → честная ошибка (transfer потребляет битмап)', () => {
    expect(() => createFanout(fakeOffscreen('src'), [fakeCanvas('a'), fakeCanvas('b')], { mode: 'bitmap' }))
      .toThrow(/одна цель/)
  })

  it('auto выбрал bitmap: вторая цель через add → честная ошибка', () => {
    const fan = createFanout(fakeOffscreen('src'), [fakeCanvas('one')], { copy: () => {} })
    expect(fan.mode).toBe('bitmap')
    expect(() => fan.add(fakeCanvas('two'))).toThrow(/mode:'2d'/)
  })

  it('auto bitmap с инъекцией: copy зовётся на единственную цель', () => {
    const calls: string[] = []
    const fan = createFanout(fakeOffscreen('src'), [fakeCanvas('only')], {
      copy: (_src, dst) => calls.push((dst as unknown as { name: string }).name),
    })
    fan.copy()
    expect(calls).toEqual(['only'])
  })
})
