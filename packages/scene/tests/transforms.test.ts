/** Тесты трансформов: иерархии, грязь, refit границ (Task 81). */
import { describe, expect, it } from 'bun:test'
import { mat4Multiply, mat4RotationY, mat4Translation, quatAxisAngle } from '@rune/math'
import { createScene, updateWorldForcedViews } from '../src/index.ts'
import type { Scene } from '../src/index.ts'

function approxMat(a: Float32Array, b: Float32Array, eps = 1e-5): void {
  for (let i = 0; i < 16; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps)
}

describe('updateWorld', () => {
  it('корень: TRS-композиция = translate·rotate·scale', () => {
    const scene = createScene({ capacity: 8 })
    const q = new Float32Array(4)
    quatAxisAngle(q, 0, 1, 0, Math.PI / 3)
    const n = scene.create({ position: [1, 2, 3], rotation: [q[0], q[1], q[2], q[3]], scale: [2, 3, 4] })
    scene.updateWorld()
    const ref = new Float32Array(16)
    const t = mat4Translation(new Float32Array(16), 1, 2, 3)
    const r = mat4RotationY(new Float32Array(16), Math.PI / 3)
    // scale вручную: T·R·S
    const s = new Float32Array(16)
    s[0] = 2; s[5] = 3; s[10] = 4; s[15] = 1
    mat4Multiply(ref, r, s)
    mat4Multiply(ref, t, ref)
    approxMat(scene.worldMatrix(n), ref)
  })

  it('цепочка ребёнок-родитель: мир = world(parent) · local(child)', () => {
    const scene = createScene({ capacity: 8 })
    const root = scene.create({ position: [10, 0, 0] })
    const child = scene.create({ parent: root, position: [0, 5, 0] })
    const grand = scene.create({ parent: child, position: [0, 0, 2] })
    scene.updateWorld()
    const w = scene.worldMatrix(grand)
    expect(w[12]).toBeCloseTo(10, 5)
    expect(w[13]).toBeCloseTo(5, 5)
    expect(w[14]).toBeCloseTo(2, 5)
  })

  it('нетронутый ребёнок трансформированного родителя получает мир родителя', () => {
    // Регресс-сценарий: ребёнок создан ПОСЛЕ трансформа родителя.
    const scene = createScene({ capacity: 8 })
    const root = scene.create({ position: [3, 4, 5] })
    const child = scene.create({ parent: root }) // identity локаль
    scene.updateWorld()
    const w = scene.worldMatrix(child)
    expect(w[12]).toBeCloseTo(3, 5)
    expect(w[13]).toBeCloseTo(4, 5)
    expect(w[14]).toBeCloseTo(5, 5)
  })

  it('грязь: покоящийся кадр пересчитывает 0 узлов', () => {
    const scene = createScene({ capacity: 8 })
    scene.create({ position: [1, 1, 1] })
    scene.create({ position: [2, 2, 2] })
    expect(scene.updateWorld()).toBe(2)
    expect(scene.updateWorld()).toBe(0)
    expect(scene.updateWorld()).toBe(0)
  })

  it('грязь: сдвиг корня инвалидирует всё поддерево, чужие — нет', () => {
    const scene = createScene({ capacity: 16 })
    const a = scene.create({ position: [1, 0, 0] })
    const a1 = scene.create({ parent: a, position: [0, 1, 0] })
    const a2 = scene.create({ parent: a1, position: [0, 0, 1] })
    const b = scene.create({ position: [9, 9, 9] })
    const b1 = scene.create({ parent: b, position: [0, 1, 0] })
    scene.updateWorld()
    scene.setLocal(a, { position: [5, 0, 0] })
    expect(scene.updateWorld()).toBe(3) // a, a1, a2; b и b1 чисты
    const w = scene.worldMatrix(a2)
    expect(w[12]).toBeCloseTo(5, 5)
    expect(w[13]).toBeCloseTo(1, 5)
  })

  it('forced-проход равен грязевому по значениям', () => {
    const scene: Scene = createScene({ capacity: 32 })
    for (let i = 0; i < 16; i++) {
      scene.create({ position: [i, i * 0.5, -i], scale: [1 + i * 0.1, 1, 1] })
    }
    scene.updateWorld()
    const copy = scene.views.world.slice()
    updateWorldForcedViews(scene.views)
    approxMat(scene.views.world, copy)
  })
})

describe('refitGroupBounds', () => {
  it('автосфера родителя охватывает сферы детей', () => {
    const scene = createScene({ capacity: 8 })
    const root = scene.create({}) // без своей сферы
    const l = scene.create({ parent: root, position: [-10, 0, 0], sphere: [0, 0, 0, 1] })
    const r = scene.create({ parent: root, position: [10, 0, 0], sphere: [0, 0, 0, 1] })
    scene.updateWorld()
    const refit = scene.refitGroupBounds()
    expect(refit).toBe(1)
    const s = scene.views.sphereW
    expect(s[root * 4]).toBeCloseTo(0, 5)
    // AABB: X [−11,11], Y/Z [−1,1] → консервативная сфера = полу-диагональ.
    expect(s[root * 4 + 3]).toBeCloseTo(0.5 * Math.sqrt(22 * 22 + 2 * 2 + 2 * 2), 4)
    // Сферы детей не тронуты.
    expect(s[l * 4 + 3]).toBeCloseTo(1, 5)
    expect(s[r * 4 + 3]).toBeCloseTo(1, 5)
  })

  it('вложенные автосферы собираются снизу вверх', () => {
    const scene = createScene({ capacity: 16 })
    const root = scene.create({})
    const mid = scene.create({ parent: root })
    scene.create({ parent: mid, position: [0, 4, 0], sphere: [0, 0, 0, 2] })
    scene.create({ parent: mid, position: [0, -4, 0], sphere: [0, 0, 0, 2] })
    scene.updateWorld()
    scene.refitGroupBounds()
    const s = scene.views.sphereW
    // mid охватывает Y ±6, X/Z ±2 → консервативная AABB-сфера;
    // root имеет единственного ребёнка (mid) → его сфера 1-в-1.
    expect(s[mid * 4 + 1]).toBeCloseTo(0, 5)
    expect(s[mid * 4 + 3]).toBeCloseTo(0.5 * Math.sqrt(4 * 4 + 12 * 12 + 4 * 4), 4)
    expect(s[root * 4 + 3]).toBeCloseTo(s[mid * 4 + 3], 5)
  })

  it('пользовательская сфера родителя не перезаписывается', () => {
    const scene = createScene({ capacity: 8 })
    const root = scene.create({ sphere: [0, 0, 0, 0.5] })
    scene.create({ parent: root, position: [100, 0, 0], sphere: [0, 0, 0, 1] })
    scene.updateWorld()
    const refit = scene.refitGroupBounds()
    expect(refit).toBe(0)
    expect(scene.views.sphereW[root * 4 + 3]).toBeCloseTo(0.5, 5)
  })

  it('движение ребёнка обновляет автосферу родителя на следующий кадр', () => {
    const scene = createScene({ capacity: 8 })
    const root = scene.create({})
    const child = scene.create({ parent: root, position: [0, 0, 0], sphere: [0, 0, 0, 1] })
    scene.updateWorld()
    scene.refitGroupBounds()
    expect(scene.views.sphereW[root * 4 + 3]).toBeCloseTo(1, 5)
    // Ребёнок уехал — автосфера обязана охватить его заново.
    scene.setLocal(child, { position: [50, 0, 0] })
    scene.updateWorld()
    scene.refitGroupBounds()
    // Единственный ребёнок → сфера родителя = сфера ребёнка точно.
    expect(scene.views.sphereW[root * 4]).toBeCloseTo(50, 4)
    expect(scene.views.sphereW[root * 4 + 3]).toBeCloseTo(1, 4)
  })
})
