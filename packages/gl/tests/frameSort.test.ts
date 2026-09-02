/**
 * frameSort.test.ts — Task 86: the frame sort key.
 *
 * Properties: pass order (opaque → sky → mirror → transparent → overlay),
 * pipeline over depth, depth over mesh, opaque — front-to-back,
 * transparent — back-to-front (bucket inversion), stability of equal keys.
 */
import { describe, expect, test } from 'bun:test'
import {
  sortFrameEntries,
  packFrameKey,
  quantizeDepth,
  type FrameEntry,
} from '../src/frameSort.ts'

interface Item { readonly name: string }

function entry(name: string, pass: FrameEntry<unknown>['pass'], pipeline: number, depth: number, mesh: number): FrameEntry<Item> {
  return { cmd: { name }, pass, pipeline, depth, mesh }
}

describe('packFrameKey', () => {
  test('pass order dominates over everything', () => {
    const opaque = packFrameKey(entry('a', 'opaque', 255, 4095, 255), 0)
    const sky = packFrameKey(entry('b', 'sky', 0, 0, 0), 0)
    const mirror = packFrameKey(entry('c', 'mirror', 0, 0, 0), 0)
    const transparent = packFrameKey(entry('d', 'transparent', 0, 0, 0), 0)
    const overlay = packFrameKey(entry('e', 'overlay', 0, 0, 0), 0)
    expect(opaque).toBeLessThan(sky)
    expect(sky).toBeLessThan(mirror)
    expect(mirror).toBeLessThan(transparent)
    expect(transparent).toBeLessThan(overlay)
  })

  test('pipeline outranks depth and mesh', () => {
    const lowPipe = packFrameKey(entry('a', 'opaque', 1, 4095, 255), 0)
    const highPipe = packFrameKey(entry('b', 'opaque', 2, 0, 0), 0)
    expect(lowPipe).toBeLessThan(highPipe)
  })

  test('depth outranks mesh', () => {
    const near = packFrameKey(entry('a', 'opaque', 1, 10, 255), 0)
    const far = packFrameKey(entry('b', 'opaque', 1, 20, 0), 0)
    expect(near).toBeLessThan(far)
  })

  test('opaque: closer — smaller key (front-to-back)', () => {
    const near = packFrameKey(entry('a', 'opaque', 1, 5, 1), 0)
    const far = packFrameKey(entry('b', 'opaque', 1, 3000, 1), 0)
    expect(near).toBeLessThan(far)
  })

  test('transparent: FARTHER — smaller key (back-to-front)', () => {
    const far = packFrameKey(entry('a', 'transparent', 1, 3000, 1), 0)
    const near = packFrameKey(entry('b', 'transparent', 1, 5, 1), 0)
    expect(far).toBeLessThan(near)
  })

  test('keys are safe numbers (40 bits)', () => {
    const max = packFrameKey(entry('a', 'overlay', 255, 4095, 255), 255)
    expect(Number.isSafeInteger(max)).toBe(true)
  })
})

describe('sortFrameEntries', () => {
  test('full order: passes → pipeline → depth → mesh → insertion', () => {
    const entries = [
      entry('pip', 'overlay', 5, 0, 0),
      entry('water', 'transparent', 3, 3000, 1), // a far transparent one
      entry('crystal', 'transparent', 3, 100, 2), // a near transparent one
      entry('sky', 'sky', 4, 0, 0),
      entry('mirror', 'mirror', 2, 0, 0),
      entry('far-tree', 'opaque', 1, 3000, 7),
      entry('near-tree', 'opaque', 1, 100, 7),
      entry('terrain', 'opaque', 0, 500, 1),
      entry('near-terrain2', 'opaque', 0, 100, 2),
    ]
    const out: Item[] = []
    sortFrameEntries(entries, out)
    expect(out.map(e => e.name)).toEqual([
      'near-terrain2', // opaque, pipeline 0, depth 100
      'terrain',       // opaque, pipeline 0, depth 500
      'near-tree',     // opaque, pipeline 1, depth 100
      'far-tree',      // opaque, pipeline 1, depth 3000
      'sky',
      'mirror',
      'water',         // transparent: the FAR one first (back-to-front)
      'crystal',       // transparent: the near one later
      'pip',
    ])
  })

  test('stability: equal keys keep insertion order', () => {
    const entries = [
      entry('first', 'opaque', 1, 100, 1),
      entry('second', 'opaque', 1, 100, 1),
      entry('third', 'opaque', 1, 100, 1),
    ]
    const out: Item[] = []
    sortFrameEntries(entries, out)
    expect(out.map(e => e.name)).toEqual(['first', 'second', 'third'])
  })

  test('an empty frame — empty output', () => {
    const out: Item[] = []
    sortFrameEntries<Item>([], out)
    expect(out).toEqual([])
  })

  test('repeated calls on the same scratch do not corrupt the result', () => {
    const a = [entry('a', 'opaque', 1, 100, 1), entry('b', 'sky', 0, 0, 0)]
    const b = [entry('x', 'overlay', 0, 0, 0), entry('y', 'opaque', 9, 0, 0)]
    const out1: Item[] = []
    const out2: Item[] = []
    sortFrameEntries(a, out1)
    sortFrameEntries(b, out2)
    expect(out1.map(e => e.name)).toEqual(['a', 'b'])
    expect(out2.map(e => e.name)).toEqual(['y', 'x'])
  })
})

describe('quantizeDepth', () => {
  test('quantization into [0, 4095] with clamping', () => {
    expect(quantizeDepth(0, 100)).toBe(0)
    expect(quantizeDepth(50, 100)).toBe(Math.round(0.5 * 4095))
    expect(quantizeDepth(100, 100)).toBe(4095)
    expect(quantizeDepth(500, 100)).toBe(4095)
    expect(quantizeDepth(-5, 100)).toBe(0)
  })
})

// ═══ Task 87: allocation-free sorting — radix path (n > 64), count ═══

describe('sortFrameEntries Task 87 (insertion + radix)', () => {
  test('count: only the first count entries are sorted (pool without slice)', () => {
    const entries = [
      entry('c-far', 'opaque', 1, 3000, 1),
      entry('a-near', 'opaque', 1, 10, 1),
      entry('b-mid', 'opaque', 1, 100, 1),
    ]
    const out: Item[] = []
    sortFrameEntries(entries, out, 2)
    expect(out.length).toBe(2)
    expect(out.map(e => e.name)).toEqual(['a-near', 'c-far'])
  })

  test('radix path (n > 64): the same order as the reference key sort', () => {
    // 300 entries — more than INSERTION_THRESHOLD → LSD radix
    const rnd = (() => { let a = 42; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 } })()
    const passes = ['opaque', 'sky', 'mirror', 'transparent', 'overlay'] as const
    const entries: FrameEntry<{ name: string }>[] = []
    for (let i = 0; i < 300; i++) {
      entries.push(entry(`e${i}`, passes[Math.floor(rnd() * 5)]!, Math.floor(rnd() * 256), Math.floor(rnd() * 4096), Math.floor(rnd() * 256)))
    }
    // reference: key + stable tie-break by index
    const reference = entries
      .map((e, i) => ({ cmd: e.cmd, key: packFrameKey(e, i) }))
      .sort((a, b) => a.key - b.key || 0)
      .map(x => x.cmd.name)
    const out: { name: string }[] = []
    sortFrameEntries(entries, out, 300)
    expect(out.length).toBe(300)
    expect(out.map(e => e.name)).toEqual(reference)
  })

  test('radix path: stability of equal keys at large n', () => {
    // 100 IDENTICAL keys — insertion order must be preserved
    const entries: FrameEntry<{ name: string }>[] = []
    for (let i = 0; i < 100; i++) entries.push(entry(`keep-${i}`, 'opaque', 3, 777, 5))
    const out: { name: string }[] = []
    sortFrameEntries(entries, out, 100)
    expect(out.map(e => e.name)).toEqual(entries.map(e => e.cmd.name))
  })

  test('alternating large and small frames on shared scratches', () => {
    const big: FrameEntry<{ name: string }>[] = []
    for (let i = 0; i < 80; i++) big.push(entry(`b${i}`, 'opaque', i % 7, (i * 37) % 4096, i % 5))
    const outBig: { name: string }[] = []
    sortFrameEntries(big, outBig, 80)
    const small = [entry('s2', 'sky', 0, 0, 0), entry('s1', 'opaque', 1, 5, 0)]
    const outSmall: { name: string }[] = []
    sortFrameEntries(small, outSmall, 2)
    expect(outSmall.map(e => e.name)).toEqual(['s1', 's2'])
    // big is still consistent when re-sorted
    const outBig2: { name: string }[] = []
    sortFrameEntries(big, outBig2, 80)
    expect(outBig2.map(e => e.name)).toEqual(outBig.map(e => e.name))
  })
})
