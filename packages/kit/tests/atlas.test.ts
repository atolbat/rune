import { test, expect } from 'bun:test'
import { createAtlas } from '../src/atlas.ts'
import type { AtlasTexture } from '../src/atlas.ts'
import type { RectSlot } from '../src/rectPacker.ts'

/** A fake carrier texture: records every upload, nothing GPU-side. */
function fakeTexture(width: number, height: number): AtlasTexture & { uploads: Array<{ x: number; y: number; source: unknown }> } {
  const uploads: Array<{ x: number; y: number; source: unknown }> = []
  return {
    textureId: 7,
    width,
    height,
    uploads,
    uploadSubImage(x: number, y: number, source: unknown) {
      uploads.push({ x, y, source })
    },
    dispose() { /* nothing to release in the fake */ },
  }
}

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

test('atlas — repeated pack() calls fill FREE space (the incremental contract)', () => {
  const tex = fakeTexture(256, 256)
  const atlas = createAtlas(tex)
  const first = atlas.pack(Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, w: 64, h: 64 })))
  expect(first).not.toBeNull()
  const second = atlas.pack(Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, w: 64, h: 64 })))
  expect(second).not.toBeNull()
  // the two batches coexist in the same atlas without overlapping
  assertNoOverlap([...first!, ...second!])
  expect(atlas.slots().length).toBe(16)
  // full — a third batch does not fit, the atlas stays usable
  expect(atlas.pack([{ id: 'c', w: 64, h: 64 }])).toBeNull()
  expect(atlas.slot('a0')).not.toBeNull()
  expect(atlas.slot('b7')).not.toBeNull()
})

test('atlas — slot lookup by id and by object', () => {
  const tex = fakeTexture(128, 128)
  const atlas = createAtlas(tex)
  const [slot] = atlas.pack([{ id: 'hero', w: 32, h: 32 }])!
  expect(atlas.slot('hero')).toBe(slot)
  expect(atlas.slot('missing')).toBeNull()
})

test('atlas — upload routes to the slot origin', () => {
  const tex = fakeTexture(128, 128)
  const atlas = createAtlas(tex)
  const [slot] = atlas.pack([{ id: 'hero', w: 32, h: 32 }])!
  const pixels = { __fake: 'source' }
  atlas.upload('hero', pixels)
  atlas.upload(slot, pixels)
  expect(tex.uploads).toEqual([
    { x: slot.x, y: slot.y, source: pixels },
    { x: slot.x, y: slot.y, source: pixels },
  ])
})

test('atlas — view() is the slot UV rect', () => {
  const tex = fakeTexture(256, 256)
  const atlas = createAtlas(tex)
  const [slot] = atlas.pack([{ id: 'hero', w: 64, h: 64 }])!
  const view = atlas.view('hero')
  expect(view.uvOffset).toEqual([slot.x / 256, slot.y / 256])
  expect(view.uvScale).toEqual([64 / 256, 64 / 256])
  expect(view.width).toBe(64)
  expect(view.height).toBe(64)
})

test('atlas — a failed pack leaves the atlas intact (atomicity passes through)', () => {
  const tex = fakeTexture(128, 128)
  const atlas = createAtlas(tex)
  const first = atlas.pack([{ id: 'a', w: 64, h: 64 }, { id: 'b', w: 64, h: 64 }])!
  // 128×64 used, a 64-row free: a 128-tall batch cannot fit
  expect(atlas.pack([{ id: 'x', w: 64, h: 128 }])).toBeNull()
  // the atlas is still usable — the state rolled back
  const second = atlas.pack([{ id: 'c', w: 64, h: 64 }, { id: 'd', w: 64, h: 64 }])
  expect(second).not.toBeNull()
  assertNoOverlap([...first, ...second!])
})

test('atlas — upload/view of an unpacked slot throws', () => {
  const tex = fakeTexture(64, 64)
  const atlas = createAtlas(tex)
  expect(() => atlas.upload('nope', {})).toThrow(/not packed/)
  expect(() => atlas.view('nope')).toThrow(/not packed/)
})

test('atlas — dispose(): texture disposed, later pack throws', () => {
  const tex = fakeTexture(64, 64)
  let disposed = false
  tex.dispose = () => { disposed = true }
  const atlas = createAtlas(tex)
  atlas.pack([{ id: 'a', w: 16, h: 16 }])
  atlas.dispose()
  atlas.dispose() // idempotent
  expect(disposed).toBe(true)
  expect(() => atlas.pack([{ id: 'b', w: 16, h: 16 }])).toThrow(/disposed/)
})
