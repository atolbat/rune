import { describe, expect, it } from 'bun:test'
import { createFanout, pickFanoutMode } from '../src/fanout.ts'
import type { AnyCanvas } from '../src/canvasHelpers.ts'

// Headless tests without DOM canvases: the fan-out logic is covered via a copy
// injection (call count, order, target composition) + the pure pickFanoutMode.
// The real drawImage/transfer paths — the demo/bench-present.html bench (browser).

/** Fake target canvas: just identity for the injected copy. */
function fakeCanvas(name: string): AnyCanvas {
  return { name, width: 64, height: 64 } as unknown as AnyCanvas
}

/** Fake transferable source: OffscreenCanvas duck-typing. */
function fakeOffscreen(name: string): AnyCanvas {
  return {
    name,
    width: 256,
    height: 256,
    transferToImageBitmap: () => ({ close: () => {} }),
  } as unknown as AnyCanvas
}

/** Fake visible WebGL canvas (HTMLCanvasElement: NO transfer). */
function fakeHtmlCanvas(name: string): AnyCanvas {
  return { name, width: 256, height: 256 } as unknown as AnyCanvas
}

describe('pickFanoutMode', () => {
  it('auto: one target + OffscreenCanvas source → bitmap', () => {
    expect(pickFanoutMode(fakeOffscreen('src'), [fakeCanvas('one')])).toBe('bitmap')
  })

  it('auto: HTMLCanvasElement source → 2d (no transferToImageBitmap)', () => {
    expect(pickFanoutMode(fakeHtmlCanvas('src'), [fakeCanvas('one')])).toBe('2d')
  })

  it('auto: many targets → 2d even with a transferable source (transfer consumes the bitmap)', () => {
    expect(pickFanoutMode(fakeOffscreen('src'), [fakeCanvas('a'), fakeCanvas('b')])).toBe('2d')
  })

  it('auto: zero targets → 2d (degradation to the safe mode)', () => {
    expect(pickFanoutMode(fakeOffscreen('src'), [])).toBe('2d')
  })

  it('explicit modes pass through as is', () => {
    expect(pickFanoutMode(fakeHtmlCanvas('src'), [], '2d')).toBe('2d')
    expect(pickFanoutMode(fakeOffscreen('src'), [fakeCanvas('one')], 'bitmap')).toBe('bitmap')
  })
})

describe('createFanout: 2d mode (injected copy)', () => {
  it('copy() calls the copy for each target in add order', () => {
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

  it('add/remove change the target composition; remove is idempotent', () => {
    const calls: string[] = []
    const a = fakeCanvas('a')
    const b = fakeCanvas('b')
    const fan = createFanout(fakeHtmlCanvas('src'), [a], {
      copy: (_src, dst) => calls.push((dst as unknown as { name: string }).name),
    })
    fan.add(b)
    fan.remove(a)
    fan.remove(a) // repeated — no-op
    fan.copy()
    expect(calls).toEqual(['b'])
    expect(fan.targets).toEqual([b])
  })

  it('add deduplicates the same target', () => {
    const a = fakeCanvas('a')
    const fan = createFanout(fakeHtmlCanvas('src'), [a], { copy: () => {} })
    fan.add(a)
    expect(fan.targets).toEqual([a])
  })

  it('dispose: copy() — no-op, dispose is idempotent', () => {
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

  it('add after dispose — no-op', () => {
    const fan = createFanout(fakeHtmlCanvas('src'), [], { copy: () => {} })
    fan.dispose()
    fan.add(fakeCanvas('late'))
    expect(fan.targets).toEqual([])
  })

  it('copy without targets — a legal no-op', () => {
    const fan = createFanout(fakeHtmlCanvas('src'), [], { copy: () => { throw new Error('should not be called') } })
    fan.copy()
  })
})

describe('createFanout: bitmap mode (guards)', () => {
  it('non-transferable source + mode bitmap → an honest error', () => {
    expect(() => createFanout(fakeHtmlCanvas('src'), [fakeCanvas('one')], { mode: 'bitmap' }))
      .toThrow(/OffscreenCanvas/)
  })

  it('two targets + mode bitmap → an honest error (transfer consumes the bitmap)', () => {
    expect(() => createFanout(fakeOffscreen('src'), [fakeCanvas('a'), fakeCanvas('b')], { mode: 'bitmap' }))
      .toThrow(/exactly one target/)
  })

  it('auto chose bitmap: a second target via add → an honest error', () => {
    const fan = createFanout(fakeOffscreen('src'), [fakeCanvas('one')], { copy: () => {} })
    expect(fan.mode).toBe('bitmap')
    expect(() => fan.add(fakeCanvas('two'))).toThrow(/mode:'2d'/)
  })

  it('auto bitmap with injection: copy is called on the single target', () => {
    const calls: string[] = []
    const fan = createFanout(fakeOffscreen('src'), [fakeCanvas('only')], {
      copy: (_src, dst) => calls.push((dst as unknown as { name: string }).name),
    })
    fan.copy()
    expect(calls).toEqual(['only'])
  })
})
