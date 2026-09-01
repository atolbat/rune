/** Тесты раскладки буфера сцены (Task 81). */
import { describe, expect, it } from 'bun:test'
import {
  buildSceneViews,
  createSceneBuffer,
  freeListWord,
  H_CAPACITY,
  H_CAMERA_MAX,
  H_GROUP_MAX,
  H_INT_WORDS,
  H_MAX_INSTANCES,
  SCENE_MAGIC,
  sceneBitsWords,
} from '../src/index.ts'

describe('createSceneBuffer / buildSceneViews', () => {
  it('заголовок согласован с опциями', () => {
    const buffer = createSceneBuffer({ capacity: 100, cameraMax: 2, groupMax: 8, maxInstances: 50 })
    const views = buildSceneViews(buffer)
    expect(views.capacity).toBe(100)
    expect(views.cameraMax).toBe(2)
    expect(views.groupMax).toBe(8)
    expect(views.maxInstances).toBe(50)
    expect(views.headerI[0]).toBe(SCENE_MAGIC)
    expect(views.bitsWords).toBe(sceneBitsWords(100))
    expect(views.bits.length).toBe(2 * 2 * sceneBitsWords(100))
  })

  it('размер буфера = int-регион + float-регион', () => {
    const buffer = createSceneBuffer({ capacity: 64, cameraMax: 1, groupMax: 4, maxInstances: 64 })
    const views = buildSceneViews(buffer)
    expect(buffer.byteLength).toBeGreaterThanOrEqual((views.headerI[H_INT_WORDS] + 0) * 4)
    expect(views.instPool.length).toBe(2 * 1 * 64 * 16)
  })

  it('SAB-режим: один буфер — два набора views (main и воркер)', () => {
    const buffer = createSceneBuffer({ capacity: 16, shared: true })
    expect(buffer instanceof SharedArrayBuffer).toBe(true)
    const a = buildSceneViews(buffer)
    const b = buildSceneViews(buffer)
    a.pos[0] = 42
    expect(b.pos[0]).toBe(42)
  })

  it('чужой буфер отклоняется по магии', () => {
    const bad = new ArrayBuffer(256) // нули — магия не совпадёт
    expect(() => buildSceneViews(bad)).toThrow('магия')
  })

  it('усечённый буфер отклоняется', () => {
    const buffer = createSceneBuffer({ capacity: 128 })
    // Копия заголовка, но буфер меньше требуемого.
    const cut = new ArrayBuffer(128)
    new Int32Array(cut).set(new Int32Array(buffer, 0, 32))
    expect(() => buildSceneViews(cut)).toThrow()
  })

  it('слоты начинаются свободными; дефолты TRS — identity', () => {
    const buffer = createSceneBuffer({ capacity: 4 })
    const views = buildSceneViews(buffer)
    for (let i = 0; i < 4; i++) {
      expect(views.quat[i * 4 + 3]).toBe(1)
      expect(views.scale[i * 3]).toBe(1)
      expect(views.group[i]).toBe(-1)
    }
    // Свободный список покрывает все слоты (через полный int-вью).
    const full = new Int32Array(buffer)
    const freeList = freeListWord(views)
    expect(full[freeList]).toBe(0)
    expect(full[freeList + 1]).toBe(4)
  })
})
