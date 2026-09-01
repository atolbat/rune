/**
 * zeroAlloc.test.ts — Task 87: горячий кадр без аллокаций + A/B-режимы.
 *
 * Проверяем ПОВЕДЕНИЕ новых безаллокационных путей (паритет со старыми):
 *   • scene.cull({ out }) — переиспользуемые записи статистики = те же числа;
 *   • masks=false — битсет ПОБИТОВО равен brute (A/B «до Task 85», только
 *     дороже: planeTests не меньше);
 *   • scene.updateWorld(true) — принудительный пересчёт = байт-в-байт тот же
 *     мир, что и грязевый (паритет);
 *   • instanceCountOf/instanceOffsetOf/instancePoolBase — числа согласованы
 *     с instanceMatricesView (тот же сегмент пула);
 *   • scene.cull({ masks: false }) и иерархический по умолчанию — одинаковые
 *     битсеты (маски не меняют результат).
 */
import { describe, expect, it } from 'bun:test'
import {
  bitsBase,
  createCamera,
  createScene,
  instanceMatricesView,
  instancePoolBase,
} from '../src/index.ts'
import type { MutableCullStats } from '../src/index.ts'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildTree(seed: number, targetNodes: number) {
  const rnd = mulberry32(seed)
  const scene = createScene({ capacity: targetNodes + 16, groupMax: 8, shared: false })
  const parents: number[] = []
  let created = 0
  while (created < targetNodes) {
    const parent = parents.length > 0 && rnd() < 0.75 ? parents[Math.floor(rnd() * parents.length)]! : -1
    const slot = scene.create({
      parent,
      position: [(rnd() - 0.5) * 40, (rnd() - 0.5) * 20, (rnd() - 0.5) * 40],
      rotation: [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, 1],
      scale: [0.5 + rnd(), 0.5 + rnd(), 0.5 + rnd()],
      group: rnd() < 0.6 ? Math.floor(rnd() * 4) : -1,
      sphere: rnd() < 0.5 ? [0, 0, 0, rnd() * 3] : undefined,
    })
    parents.push(slot)
    created++
  }
  return scene
}

describe('Task 87: cull с out-записями (ноль аллокаций)', () => {
  it('out-статистика = свежие объекты (те же числа, переиспользование)', () => {
    const scene = buildTree(7, 400)
    const cam = createCamera()
    cam.setPerspective(1.2, 1.5, 0.5, 300)
    cam.setViewLookAt(30, 25, 30, 0, 0, 0, 0, 1, 0)
    scene.updateWorld()
    scene.refitGroupBounds()

    const out: MutableCullStats[] = [
      { tested: -1, visible: -1, trivialRejects: -1, trivialAccepts: -1, planeTests: -1 },
    ]
    const res = scene.cull([cam], { bufferIndex: 0, out })
    // out-запись заполнена и совпадает с аллоцированной копией
    expect(out[0]!.tested).toBe(res.stats[0]!.tested)
    expect(out[0]!.visible).toBe(res.stats[0]!.visible)
    expect(out[0]!.trivialRejects).toBe(res.stats[0]!.trivialRejects)
    expect(out[0]!.trivialAccepts).toBe(res.stats[0]!.trivialAccepts)
    expect(out[0]!.planeTests).toBe(res.stats[0]!.planeTests)
    expect(out[0]!.visible).toBeGreaterThan(0)
    // второй кадр перезаписывает ту же запись
    const res2 = scene.cull([cam], { bufferIndex: 1, out })
    expect(out[0]!.tested).toBe(res2.stats[0]!.tested)
  })
})

describe('Task 87: masks=false — A/B «до Task 85» (тот же битсет, дороже)', () => {
  it('битсеты побитово равны; planeTests не меньше (маски — чистая экономия)', () => {
    // Контракт сцены: user-сфера внутреннего узла = границы ПОДДЕРЕВА
    // (culling.ts); поэтому эталон для A/B масок — САМА иерархическая
    // проверка с масками, а не brute (сравнение с brute на произвольных
    // user-сферах — отдельный тест optimizations.test.ts).
    const scene = buildTree(11, 500)
    const cam = createCamera()
    cam.setPerspective(1.0, 1.7, 0.5, 300)
    cam.setViewLookAt(-35, 20, -25, 5, 0, 5, 0, 1, 0)
    scene.updateWorld()
    scene.refitGroupBounds()

    const withMasks = scene.cull([cam], { bufferIndex: 0, masks: true })
    const withoutMasks = scene.cull([cam], { bufferIndex: 1, masks: false })

    const words = scene.views.bitsWords
    const b0 = bitsBase(scene.views, 0, 0)
    const b1 = bitsBase(scene.views, 1, 0)
    for (let w = 0; w < words; w++) {
      expect(scene.views.bits[b1 + w]).toBe(scene.views.bits[b0 + w]) // A/B не меняет результат
    }
    expect(withoutMasks.stats[0]!.visible).toBe(withMasks.stats[0]!.visible)
    expect(withoutMasks.stats[0]!.trivialRejects).toBe(withMasks.stats[0]!.trivialRejects)
    expect(withoutMasks.stats[0]!.trivialAccepts).toBe(withMasks.stats[0]!.trivialAccepts)
    // маски реально экономят тесты «сфера×плоскость»
    expect(withMasks.stats[0]!.planeTests).toBeLessThan(withoutMasks.stats[0]!.planeTests)
  })
})

describe('Task 87: updateWorld(force) — паритет с грязевым', () => {
  it('принудительный пересчёт даёт байт-в-байт тот же мир', () => {
    const scene = buildTree(23, 300)
    const cam = createCamera()
    cam.setPerspective(1.0, 1.5, 0.5, 300)
    cam.setViewLookAt(10, 15, 10, 0, 0, 0, 0, 1, 0)
    scene.updateWorld()
    scene.refitGroupBounds()
    // грязевый кадр после правки локали
    const slot = 5
    scene.setLocalTR(slot, 1, 2, 3, 0, 0.6, 0, 0.8, 1, 1, 1)
    const dirty = scene.updateWorld(false)
    const worldDirty = scene.views.world.slice()
    // принудительный кадр: пересчитаны ВСЕ, мир тот же
    const forced = scene.updateWorld(true)
    expect(forced).toBe(scene.count)
    expect(dirty).toBeLessThan(scene.count)
    const worldForced = scene.views.world
    for (let i = 0; i < worldForced.length; i++) {
      expect(worldForced[i]).toBe(worldDirty[i])
    }
  })
})

describe('Task 87: числовые доступы инстансов (без subarray)', () => {
  it('countOf/offsetOf/poolBase согласованы с instanceMatricesView', () => {
    const scene = buildTree(31, 400)
    const cam = createCamera()
    cam.setPerspective(1.0, 1.4, 0.5, 300)
    cam.setViewLookAt(20, 18, 20, 0, 0, 0, 0, 1, 0)
    scene.updateWorld()
    scene.refitGroupBounds()
    scene.cull([cam], { bufferIndex: 0 })
    scene.collectInstances(0, { bufferIndex: 0 })

    const g = 1
    const count = scene.instanceCountOf(g, 0, 0)
    const offset = scene.instanceOffsetOf(g, 0, 0)
    const base = scene.instancePoolBase(0, 0)
    const seg = instanceMatricesView(scene.views, 0, 0, g)
    expect(seg.count).toBe(count)
    if (count > 0) {
      // первый элемент сегмента = пул[base + offset*16]
      const pool = scene.views.instPool
      expect(seg.matrices[0]).toBe(pool[base + offset * 16]!)
      expect(seg.matrices[count * 16 - 1]).toBe(pool[base + (offset + count) * 16 - 1]!)
    }
    // база зависит от камеры (перкамерные пулы не пересекаются)
    const base1 = scene.instancePoolBase(1, 0)
    expect(base1).not.toBe(base)
  })
})
