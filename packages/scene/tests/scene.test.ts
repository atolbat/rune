/** Тесты структурного слоя Scene (Task 81). */
import { describe, expect, it } from 'bun:test'
import { buildSceneViews, createCamera, createScene } from '../src/index.ts'

describe('Scene: создание/удаление', () => {
  it('слоты стабильны; count честный; повторный dispose — no-op', () => {
    const scene = createScene({ capacity: 4 })
    const a = scene.create({})
    const b = scene.create({})
    expect(scene.count).toBe(2)
    expect(scene.alive(a)).toBe(true)
    scene.dispose(a)
    scene.dispose(a) // идемпотентно
    expect(scene.alive(a)).toBe(false)
    expect(scene.count).toBe(1)
    expect(scene.alive(b)).toBe(true)
  })

  it('переиспользование слота поднимает generation', () => {
    const scene = createScene({ capacity: 2 })
    const a = scene.create({})
    const gen0 = scene.generation(a)
    scene.dispose(a)
    const b = scene.create({})
    expect(b).toBe(a) // тот же слот из свободного списка
    expect(scene.generation(b)).toBe(gen0 + 1)
  })

  it('capacity исчерпана — честный throw', () => {
    const scene = createScene({ capacity: 1 })
    scene.create({})
    expect(() => scene.create({})).toThrow('capacity')
  })

  it('дети удалённого узла становятся корнями (мир пересчитывается)', () => {
    const scene = createScene({ capacity: 8 })
    const root = scene.create({ position: [10, 0, 0] })
    const child = scene.create({ parent: root, position: [0, 1, 0] })
    scene.updateWorld()
    expect(scene.worldMatrix(child)[12]).toBeCloseTo(10, 5)
    scene.dispose(root)
    scene.updateWorld()
    // Локаль сохранена, родителя нет → мир = локаль.
    const w = scene.worldMatrix(child)
    expect(w[12]).toBeCloseTo(0, 5)
    expect(w[13]).toBeCloseTo(1, 5)
    expect(scene.parentOf(child)).toBe(-1)
  })
})

describe('Scene: иерархия', () => {
  it('setParent перестраивает мир поддерева', () => {
    const scene = createScene({ capacity: 8 })
    const a = scene.create({ position: [5, 0, 0] })
    const b = scene.create({ position: [1, 0, 0] })
    const c = scene.create({ parent: b, position: [0, 0, 1] })
    scene.updateWorld()
    expect(scene.worldMatrix(c)[12]).toBeCloseTo(1, 5) // b(1) + локаль c(0)
    scene.setParent(b, a)
    scene.updateWorld()
    expect(scene.worldMatrix(c)[12]).toBeCloseTo(6, 5) // b: 5+1, c: +0 → 6
    expect(scene.worldMatrix(c)[14]).toBeCloseTo(1, 5)
    // b отцепили — мир c остался относительно b.
    scene.setParent(b, -1)
    scene.updateWorld()
    expect(scene.worldMatrix(c)[12]).toBeCloseTo(1, 5)
  })

  it('циклы и самородительство — throw', () => {
    const scene = createScene({ capacity: 8 })
    const a = scene.create({})
    const b = scene.create({ parent: a })
    expect(() => scene.setParent(a, a)).toThrow()
    expect(() => scene.setParent(a, b)).toThrow('цикл')
  })

  it('pack: parent всегда раньше ребёнка; поддеревья — диапазоны', () => {
    const scene = createScene({ capacity: 32 })
    const r1 = scene.create({})
    const c1 = scene.create({ parent: r1 })
    const g1 = scene.create({ parent: c1 })
    const r2 = scene.create({})
    scene.pack()
    const { order, subtreeEnd, parent } = scene.views
    const n = scene.count
    expect(n).toBe(4)
    for (let rank = 0; rank < n; rank++) {
      const slot = order[rank]
      const p = parent[slot]
      if (p >= 0) {
        const pRank = order.indexOf(p)
        expect(pRank).toBeLessThan(rank)
        expect(subtreeEnd[p]).toBeGreaterThan(rank)
      }
    }
    // Диапазоны поддеревьев корней покрывают все ранги без пересечений.
    const r1Rank = order.indexOf(r1)
    const r2Rank = order.indexOf(r2)
    expect(subtreeEnd[r1]).toBe(r2Rank) // поддерево r1 заканчивается перед r2
    expect(subtreeEnd[r2]).toBe(n)
    expect(subtreeEnd[g1]).toBe(r1Rank + 3)
    void c1
  })

  it('структурная правка авто-репакуется горячим проходом', () => {
    const scene = createScene({ capacity: 8 })
    const a = scene.create({ position: [1, 2, 3] })
    scene.updateWorld()
    const b = scene.create({ parent: a })
    // Без явного pack — updateWorld сам перестроит order.
    scene.updateWorld()
    expect(scene.worldMatrix(b)[13]).toBeCloseTo(2, 5)
  })
})

describe('Scene: камеры и обход видимых', () => {
  it('камера на узле: view = world⁻¹ (сцена ведёт трансформ)', () => {
    const scene = createScene({ capacity: 8 })
    const camNode = scene.create({ position: [0, 0, 5] })
    scene.updateWorld()
    const cam = createCamera()
    scene.cameraFromNode(cam, camNode)
    // Вид из (0,0,5) на origin: view·origin = (0,0,-5).
    const v = cam.view
    const z = v[2] * 0 + v[6] * 0 + v[10] * 0 + v[14]
    expect(z).toBeCloseTo(-5, 4)
  })

  it('forEachVisible: только бит ∩ флаг узла', () => {
    const scene = createScene({ capacity: 8 })
    const a = scene.create({ position: [0, 0, 0], sphere: [0, 0, 0, 1] })
    const b = scene.create({ position: [0, 0, 0], sphere: [0, 0, 0, 1] })
    scene.create({ position: [0, 0, 0], sphere: [0, 0, 0, 1], visible: false })
    scene.updateWorld()
    const cam = createCamera().setPerspective(1.5, 1, 0.1, 100)
    cam.setViewLookAt(0, 0, 10, 0, 0, 0, 0, 1, 0)
    scene.cull([cam])
    const seen: number[] = []
    scene.forEachVisible(0, (slot) => seen.push(slot))
    expect(seen.length).toBe(2)
    expect(seen).toContain(a)
    expect(seen).toContain(b)
  })
})

describe('Scene: SAB-режим', () => {
  it('shared-сцена пишет в общий буфер (воркер увидит)', () => {
    const scene = createScene({ capacity: 8, shared: true })
    expect(scene.backing).toBe('shared')
    const n = scene.create({ position: [7, 8, 9] })
    // pos — view над SAB: отдельный набор views видит ту же память.
    const other = buildSceneViews(scene.views.buffer)
    expect(other.pos[0]).toBe(7)
    scene.updateWorld()
    expect(scene.worldMatrix(n)[12]).toBeCloseTo(7, 5)
    expect(other.world[12]).toBeCloseTo(7, 5)
  })
})
