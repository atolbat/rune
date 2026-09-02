import { test, expect } from 'bun:test'
import { createRectPacker } from '../src/rectPacker.ts'

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
