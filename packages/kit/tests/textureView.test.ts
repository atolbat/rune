import { test, expect } from 'bun:test'
import { createTextureView, type ViewableTexture } from '../src/textureView.ts'

const parent: ViewableTexture = { textureId: 1, width: 2048, height: 2048 }

test('default view covers whole parent', () => {
  const v = createTextureView(parent)
  expect(v.textureId).toBe(1)
  expect(v.uvOffset[0]).toBeCloseTo(0)
  expect(v.uvOffset[1]).toBeCloseTo(0)
  expect(v.uvScale[0]).toBeCloseTo(1)
  expect(v.uvScale[1]).toBeCloseTo(1)
  expect(v.width).toBe(2048)
  expect(v.height).toBe(2048)
})

test('sub-region — top-left 64x64 of 2048 atlas', () => {
  const v = createTextureView(parent, {
    origin: { x: 0, y: 0 },
    size: { width: 64, height: 64 },
  })
  expect(v.uvOffset).toEqual([0, 0])
  expect(v.uvScale[0]).toBeCloseTo(64 / 2048)
  expect(v.width).toBe(64)
  expect(v.height).toBe(64)
})

test('sub-region — interior slot', () => {
  const v = createTextureView(parent, {
    origin: { x: 128, y: 256 },
    size: { width: 64, height: 64 },
  })
  expect(v.uvOffset[0]).toBeCloseTo(128 / 2048)
  expect(v.uvOffset[1]).toBeCloseTo(256 / 2048)
  expect(v.uvScale[0]).toBeCloseTo(64 / 2048)
  expect(v.uvScale[1]).toBeCloseTo(64 / 2048)
})

test('out of bounds — throws RangeError', () => {
  expect(() => createTextureView(parent, {
    origin: { x: 2000, y: 2000 },
    size: { width: 100, height: 100 }, // 2000+100 > 2048
  })).toThrow(RangeError)
})

test('negative origin — throws RangeError', () => {
  expect(() => createTextureView(parent, {
    origin: { x: -1, y: 0 },
    size: { width: 64, height: 64 },
  })).toThrow(RangeError)
})

test('clamps size to at least 1x1', () => {
  const v = createTextureView(parent, { size: { width: 0, height: 0 } })
  expect(v.width).toBe(1)
  expect(v.height).toBe(1)
})

test('dispose is idempotent no-op', () => {
  const v = createTextureView(parent, { size: { width: 64, height: 64 } })
  v.dispose()
  v.dispose() // must not throw
  expect(v.textureId).toBe(1) // on WebGL2 — the same textureId
})
