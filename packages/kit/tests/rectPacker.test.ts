import { test, expect } from 'bun:test'
import { createRectPacker } from '../src/rectPacker.ts'
import type { RectSlot } from '../src/rectPacker.ts'

test('shelf packer — packs uniform tiles', () => {
  const packer = createRectPacker(256, 256, { algorithm: 'shelf' })
  const items = Array.from({ length: 16 }, (_, i) => ({ id: `t${i}`, w: 64, h: 64 }))
  const slots = packer.pack(items)
  expect(slots).not.toBeNull()
  expect(slots!.length).toBe(16)
  // a 4x4 grid fits exactly
  expect(slots!.every(s => s.x >= 0 && s.y >= 0 && s.x < 256 && s.y < 256)).toBe(true)
})

test('shelf packer — returns null on too big', () => {
  const packer = createRectPacker(64, 64, { algorithm: 'shelf' })
  const slots = packer.pack([{ id: 'big', w: 128, h: 128 }])
  expect(slots).toBeNull()
})

test('shelf packer — padding adds gap', () => {
  const packer = createRectPacker(256, 256, { algorithm: 'shelf', padding: 2 })
  const slots = packer.pack([
    { id: 'a', w: 64, h: 64 },
    { id: 'b', w: 64, h: 64 },
  ])
  expect(slots).not.toBeNull()
  const a = slots!.find(s => s.id === 'a')!
  const b = slots!.find(s => s.id === 'b')!
  // there must be a gap between a and b (2 padding + the padding itself)
  expect(b.x).toBeGreaterThan(a.x)
  expect(b.x - (a.x + a.w)).toBeGreaterThanOrEqual(2)
})

test('maxrects packer — packs mixed sizes', () => {
  const packer = createRectPacker(256, 256, { algorithm: 'maxrects' })
  const items = [
    { id: 'big', w: 128, h: 128 },
    { id: 'mid', w: 64, h: 64 },
    { id: 'mid2', w: 64, h: 64 },
    { id: 'small', w: 32, h: 32 },
    { id: 'tiny', w: 16, h: 16 },
  ]
  const slots = packer.pack(items)
  expect(slots).not.toBeNull()
  expect(slots!.length).toBe(5)
  // All slots within the atlas bounds
  expect(slots!.every(s => s.x >= 0 && s.y >= 0 && s.x + s.w <= 256 && s.y + s.h <= 256)).toBe(true)
})

test('maxrects packer — no overlap', () => {
  const packer = createRectPacker(128, 128, { algorithm: 'maxrects', padding: 1 })
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `r${i}`, w: 16 + (i % 3) * 8, h: 16 + (i % 2) * 16,
  }))
  const slots = packer.pack(items)
  expect(slots).not.toBeNull()
  // Check that no two slots overlap
  for (let i = 0; i < slots!.length; i++) {
    for (let j = i + 1; j < slots!.length; j++) {
      const a = slots![i]
      const b = slots![j]
      const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
      expect(overlap).toBe(false)
    }
  }
})

test('usedArea — accumulates packed area', () => {
  const packer = createRectPacker(256, 256, { algorithm: 'shelf' })
  packer.pack([
    { id: 'a', w: 64, h: 64 },
    { id: 'b', w: 64, h: 64 },
  ])
  expect(packer.usedArea).toBe(64 * 64 * 2)
})

test('maxrects — null when not enough space', () => {
  const packer = createRectPacker(64, 64, { algorithm: 'maxrects' })
  const slots = packer.pack([
    { id: 'a', w: 48, h: 48 },
    { id: 'b', w: 48, h: 48 }, // won't fit after the first one
  ])
  expect(slots).toBeNull()
})

// ─── Task 184: the INCREMENTAL contract (pack() was stateless — the second
// call silently overlapped the first, the atlas docstring promised free space)
// ─────────────────────────────────────────────────────────────────────────────

function assertNoOverlap(slots: RectSlot[]): void {
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]
      const b = slots[j]
      const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
      expect(overlap).toBe(false)
    }
  }
}

test('shelf — repeated packs fill FREE space, never overlap (the incremental contract)', () => {
  const packer = createRectPacker(256, 256, { algorithm: 'shelf' })
  const first = packer.pack(Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, w: 64, h: 64 })))
  expect(first).not.toBeNull()
  const second = packer.pack(Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, w: 64, h: 64 })))
  expect(second).not.toBeNull()
  // both batches live in the same atlas without overlapping each other
  assertNoOverlap([...first!, ...second!])
  // 16 tiles = the exact fill: nothing more fits
  const third = packer.pack([{ id: 'c', w: 64, h: 64 }])
  expect(third).toBeNull()
  expect(packer.usedArea).toBe(256 * 256)
})

test('maxrects — repeated packs fill FREE space, never overlap (the incremental contract)', () => {
  const packer = createRectPacker(256, 256, { algorithm: 'maxrects' })
  const first = packer.pack([
    { id: 'a', w: 128, h: 128 },
    { id: 'b', w: 128, h: 128 },
    { id: 'c', w: 64, h: 64 },
  ])
  expect(first).not.toBeNull()
  const second = packer.pack([
    { id: 'd', w: 64, h: 64 },
    { id: 'e', w: 128, h: 64 },
  ])
  expect(second).not.toBeNull()
  assertNoOverlap([...first!, ...second!])
  expect(packer.usedArea).toBe(128 * 128 * 2 + 64 * 64 * 2 + 128 * 64)
})

test('shelf — a failed pack is ATOMIC: state rolls back, a smaller batch still fits', () => {
  const packer = createRectPacker(256, 256, { algorithm: 'shelf' })
  // 15 of the 16 cells
  const first = packer.pack(Array.from({ length: 15 }, (_, i) => ({ id: `a${i}`, w: 64, h: 64 })))
  expect(first).not.toBeNull()
  const areaAfterFirst = packer.usedArea
  // two tiles do not fit — null, and NOTHING changed
  const fail = packer.pack([{ id: 'x', w: 64, h: 64 }, { id: 'y', w: 64, h: 64 }])
  expect(fail).toBeNull()
  expect(packer.usedArea).toBe(areaAfterFirst)
  // the last free cell is still there for a single tile
  const last = packer.pack([{ id: 'z', w: 64, h: 64 }])
  expect(last).not.toBeNull()
  expect(packer.usedArea).toBe(256 * 256)
})

test('maxrects — a failed pack is ATOMIC: state rolls back, a smaller batch still fits', () => {
  const packer = createRectPacker(128, 128, { algorithm: 'maxrects' })
  const first = packer.pack([
    { id: 'a', w: 96, h: 96 },
    { id: 'b', w: 32, h: 96 },
  ])
  expect(first).not.toBeNull()
  const areaAfterFirst = packer.usedArea
  // the 128×32 bottom strip is all that is left; a 64×64 tile does not fit
  const fail = packer.pack([{ id: 'x', w: 64, h: 64 }])
  expect(fail).toBeNull()
  expect(packer.usedArea).toBe(areaAfterFirst)
  // the 32-wide strip is still intact
  const last = packer.pack([{ id: 'z', w: 32, h: 32 }])
  expect(last).not.toBeNull()
  assertNoOverlap([...first!, ...last!])
})

test('shelf — an item wider than the atlas fails instead of placing out of bounds (the OOB bug)', () => {
  const packer = createRectPacker(256, 256, { algorithm: 'shelf' })
  // wide but SHORT: the row-wrap used to assume the next row fits it and
  // placed the slot BEYOND the right edge (x + w > width)
  const slots = packer.pack([{ id: 'wide', w: 300, h: 10 }])
  expect(slots).toBeNull()
})

test('pack of an empty batch — [] and the state untouched', () => {
  const packer = createRectPacker(256, 256, { algorithm: 'shelf' })
  expect(packer.pack([])).toEqual([])
  const first = packer.pack([{ id: 'a', w: 64, h: 64 }])
  expect(first).not.toBeNull()
  expect(packer.pack([])).toEqual([])
  const second = packer.pack([{ id: 'b', w: 64, h: 64 }])
  expect(second).not.toBeNull()
  assertNoOverlap([...first!, ...second!])
})
