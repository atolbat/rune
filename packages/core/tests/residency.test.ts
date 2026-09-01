import { describe, test, expect } from 'bun:test'
import { estimateTextureBytes, selectLRUEvictions, textureFormatBytesPerPixel } from '../src/journal/residency.ts'

const entry = (id: number, bytes: number, lastUse: number) => ({ id, bytes, lastUse })

describe('estimateTextureBytes — оценка GPU-памяти', () => {
  test('плоская RGBA8: w*h*4', () => {
    expect(estimateTextureBytes(256, 256)).toBe(256 * 256 * 4)
    expect(estimateTextureBytes(512, 256, 1)).toBe(512 * 256 * 4)
  })

  test('mip-chain: ≤ base × 4/3, растёт с числом уровней', () => {
    const base = 256 * 256 * 4
    const full = estimateTextureBytes(256, 256, 9)
    expect(full).toBeGreaterThan(base)
    expect(full).toBeLessThanOrEqual(Math.ceil(base * 4 / 3))
    // меньше уровней — меньше байт (мономотонность по уровням)
    expect(estimateTextureBytes(256, 256, 2)).toBeLessThan(full)
    expect(estimateTextureBytes(256, 256, 1)).toBe(base)
  })

  test('mipLevels больше физического максимума — клампится', () => {
    // 256×256: максимум 9 уровней; 99 уровней не должны дать больше ×4/3
    const base = 256 * 256 * 4
    expect(estimateTextureBytes(256, 256, 99)).toBe(estimateTextureBytes(256, 256, 9))
    expect(estimateTextureBytes(256, 256, 99)).toBeLessThanOrEqual(Math.ceil(base * 4 / 3))
  })
})

describe('Task 67 — HDR-форматы в оценке GPU-памяти', () => {
  test('textureFormatBytesPerPixel: 8-бит — 4, half-float — 8, float — 16', () => {
    expect(textureFormatBytesPerPixel()).toBe(4)
    expect(textureFormatBytesPerPixel('rgba8unorm')).toBe(4)
    expect(textureFormatBytesPerPixel('canvas')).toBe(4) // bgra8unorm
    expect(textureFormatBytesPerPixel('rgba16float')).toBe(8)
    expect(textureFormatBytesPerPixel('rgba32float')).toBe(16)
  })

  test('rgba16float: w*h*8 (2× от RGBA8)', () => {
    expect(estimateTextureBytes(100, 100, 1, 'rgba16float')).toBe(100 * 100 * 8)
    expect(estimateTextureBytes(100, 100, 1, 'rgba16float')).toBe(2 * estimateTextureBytes(100, 100))
  })

  test('rgba32f: w*h*16 (4× от RGBA8)', () => {
    expect(estimateTextureBytes(100, 100, 1, 'rgba32float')).toBe(100 * 100 * 16)
    expect(estimateTextureBytes(100, 100, 1, 'rgba32float')).toBe(4 * estimateTextureBytes(100, 100))
  })

  test('mip-chain HDR: база × 4/3 от ФОРМАТА, не от RGBA8', () => {
    const base16 = 100 * 100 * 8
    const mips = estimateTextureBytes(100, 100, 9, 'rgba16float')
    expect(mips).toBeGreaterThan(base16)
    expect(mips).toBeLessThanOrEqual(Math.ceil(base16 * 4 / 3))
    // отношение к RGBA8-цепи — ×2 с точностью округления ceil (±1 байт):
    // ceil(2x) и 2·ceil(x) могут расходиться на единицу.
    const rgba8Mips = estimateTextureBytes(100, 100, 9)
    expect(Math.abs(mips - 2 * rgba8Mips)).toBeLessThanOrEqual(1)
    // точное значение: 100×100 → кламп уровней = 7 (1+log2(100)).
    expect(mips).toBe(Math.ceil(100 * 100 * 8 * (1 - Math.pow(4, -7)) / 0.75))
  })
})

describe('selectLRUEvictions — чистая LRU-политика', () => {
  test('в бюджете — никого не трогаем', () => {
    const sel = selectLRUEvictions([entry(1, 100, 5), entry(2, 100, 3)], 200)
    expect(sel.evictIds).toEqual([])
    expect(sel.freedBytes).toBe(0)
    expect(sel.residentBytes).toBe(200)
  })

  test('ровно в бюджет — тоже без вытеснения (бюджет — потолок)', () => {
    const sel = selectLRUEvictions([entry(1, 100, 5), entry(2, 100, 3)], 200)
    expect(sel.evictIds).toEqual([])
  })

  test('сверх бюджета — вытесняет LRU-первыми, минимальным числом', () => {
    // lastUse: id3=1 (самый старый), id1=2, id2=3 (самый свежий)
    const sel = selectLRUEvictions([entry(1, 100, 2), entry(2, 100, 3), entry(3, 100, 1)], 200)
    // 300 > 200 → вытеснить минимум: LRU (id3) освобождает 100 → 200 ≤ 200
    expect(sel.evictIds).toEqual([3])
    expect(sel.freedBytes).toBe(100)
    expect(sel.residentBytes).toBe(200)
  })

  test('бюджет 0 — выталкивает ВСЁ незапиненное в LRU-порядке', () => {
    const sel = selectLRUEvictions([entry(1, 50, 9), entry(2, 30, 7), entry(3, 20, 8)], 0)
    expect(sel.evictIds).toEqual([2, 3, 1]) // по lastUse: 7, 8, 9
    expect(sel.freedBytes).toBe(100)
    expect(sel.residentBytes).toBe(0)
  })

  test('pinned неприкосновенен, даже если он самый старый', () => {
    // id1 — сцена (pinned), но использовалась давнее всех
    const sel = selectLRUEvictions(
      [entry(1, 100, 1), entry(2, 100, 5), entry(3, 100, 6)],
      150,
      new Set([1]),
    )
    // сумма 300 > 150; pinned id1 остаётся; выталкиваем LRU незапиненных:
    // id2 (lastUse=5) → 200 > 150 → id3 → 100 ≤ 150
    expect(sel.evictIds).toEqual([2, 3])
    expect(sel.residentBytes).toBe(100) // только pinned id1
  })

  test('pinned не влезает в бюджет — вытесняем что можем, превышение остаётся честно', () => {
    const sel = selectLRUEvictions(
      [entry(1, 300, 1), entry(2, 100, 5)],
      100,
      new Set([1]),
    )
    // Вытеснять можно только id2: 300 → всё ещё > 100. План: вытеснить id2.
    expect(sel.evictIds).toEqual([2])
    expect(sel.residentBytes).toBe(300) // pinned превышает бюджет — честно
  })

  test('одинаковый lastUse — детерминизм по id', () => {
    const sel = selectLRUEvictions([entry(7, 10, 5), entry(3, 10, 5), entry(5, 10, 5)], 10)
    expect(sel.evictIds).toEqual([3, 5]) // id по возрастанию
  })

  test('пустой список / пустой бюджет по умолчанию (без pinned)', () => {
    expect(selectLRUEvictions([], 0).evictIds).toEqual([])
    expect(selectLRUEvictions([], 0).residentBytes).toBe(0)
  })

  test('bytes=0 (неизвестный размер) — вытесняется по LRU, сумму не двигает', () => {
    const sel = selectLRUEvictions([entry(1, 0, 1), entry(2, 100, 2)], 50)
    // 100 > 50 → вытеснять: LRU id1 (0 байт) не помогает → id2
    expect(sel.evictIds).toEqual([1, 2])
    expect(sel.freedBytes).toBe(100)
    expect(sel.residentBytes).toBe(0)
  })
})
