/** Тесты фрустума и отсечения (Task 81): brute ↔ hierarchical паритет. */
import { describe, expect, it } from 'bun:test'
import {
  classifySphere,
  createCamera,
  createScene,
  cullViewsBrute,
  cullViewsHierarchical,
  extractFrustumPlanes,
  fillBits,
  SPHERE_INSIDE,
  SPHERE_INTERSECT,
  SPHERE_OUTSIDE,
  writeCameraPlanes,
} from '../src/index.ts'
import { mat4Multiply, mat4Perspective, mat4Translation } from '@rune/math'

/** Детерминированный ГПСЧ для property-тестов. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('extractFrustumPlanes', () => {
  it('точки внутри объёма дают неотрицательные расстояния до всех плоскостей', () => {
    const cam = createCamera().setPerspective(Math.PI / 3, 1, 0.5, 100)
    cam.setViewLookAt(0, 0, 10, 0, 0, 0, 0, 1, 0)
    const p = cam.planes
    // Точка перед камерой в центре.
    for (let i = 0; i < 6; i++) {
      const d = p[i * 4] * 0 + p[i * 4 + 1] * 0 + p[i * 4 + 2] * -5 + p[i * 4 + 3]
      expect(d).toBeGreaterThan(0)
    }
  })

  it('точка позади камеры даёт отрицательное near-расстояние', () => {
    const cam = createCamera().setPerspective(Math.PI / 3, 1, 0.5, 100)
    cam.setViewLookAt(0, 0, 10, 0, 0, 0, 0, 1, 0)
    const p = cam.planes
    const dNear = p[4 * 4] * 0 + p[4 * 4 + 1] * 0 + p[4 * 4 + 2] * 15 + p[4 * 4 + 3]
    expect(dNear).toBeLessThan(0)
  })

  it('нормали плоскостей единичные', () => {
    const proj = mat4Perspective(new Float32Array(16), 1.2, 2, 0.1, 50)
    const view = mat4Translation(new Float32Array(16), 0, 0, -5)
    const vp = mat4Multiply(new Float32Array(16), proj, view)
    const planes = extractFrustumPlanes(new Float32Array(24), vp)
    for (let i = 0; i < 6; i++) {
      const len = Math.hypot(planes[i * 4], planes[i * 4 + 1], planes[i * 4 + 2])
      expect(Math.abs(len - 1)).toBeLessThan(1e-6)
    }
  })
})

describe('classifySphere', () => {
  const cam = createCamera().setPerspective(Math.PI / 2, 1, 1, 100)
  cam.setViewLookAt(0, 0, 10, 0, 0, 0, 0, 1, 0) // камера на +Z, смотрит в −Z

  it('сфера в центре вида — INSIDE', () => {
    expect(classifySphere(cam.planes, 0, 0, 5, 0.5)).toBe(SPHERE_INSIDE)
  })

  it('сфера далеко сбоку — OUTSIDE', () => {
    expect(classifySphere(cam.planes, 1000, 1000, 0, 1)).toBe(SPHERE_OUTSIDE)
  })

  it('сфера на границе — INTERSECT', () => {
    // fov 90°, расстояние вдоль взгляда 5 → полуширина 5 на этой глубине.
    expect(classifySphere(cam.planes, 5.5, 0, 5, 1.5)).toBe(SPHERE_INTERSECT)
  })
})

describe('fillBits', () => {
  it('точные диапазоны: слова, биты, границы', () => {
    const a = new Uint32Array(8)
    fillBits(a, 0, 3, 7, true) // биты 3..6
    expect(a[0]).toBe(0b01111000)
    fillBits(a, 0, 3, 7, false)
    expect(a[0]).toBe(0)

    const b = new Uint32Array(8)
    fillBits(b, 0, 0, 32, true) // ровно одно слово
    expect(b[0]).toBe(0xffffffff)
    fillBits(b, 0, 0, 32, false)
    expect(b[0]).toBe(0)

    const c = new Uint32Array(8)
    fillBits(c, 0, 31, 65, true) // хвост+слово+голова
    expect(c[0]).toBe((1 << 31) >>> 0)
    expect(c[1]).toBe(0xffffffff)
    expect(c[2]).toBe(1)
    fillBits(c, 0, 31, 65, false)
    expect(c[0]).toBe(0)
    expect(c[1]).toBe(0)
    expect(c[2]).toBe(0)

    const d = new Uint32Array(4)
    d[0] = 0xffffffff
    fillBits(d, 0, 4, 8, false) // очистка середины слова
    expect(d[0]).toBe(0xffffff0f)
  })
})

describe('иерархическое отсечение ↔ brute', () => {
  /** Случайный лес: цепочки/ветки, случайные сферы, случайные локальные позиции. */
  function buildScene(seed: number, count: number): {
    scene: ReturnType<typeof createScene>
    slots: number[]
  } {
    const rnd = mulberry32(seed)
    const scene = createScene({ capacity: count + 16, cameraMax: 2, groupMax: 4 })
    const slots: number[] = []
    let prev = -1
    for (let i = 0; i < count; i++) {
      const parent = rnd() < 0.6 && prev >= 0 ? prev : -1
      const x = (rnd() - 0.5) * 40
      const y = (rnd() - 0.5) * 20
      const z = (rnd() - 0.5) * 40
      const isLeaf = rnd() < 0.7
      // Листья — случайные сферы (треть — точки r=0); внутренние — r=0
      // (авто-границы refit'ом) — КОРРЕКТНЫЕ охватывающие объёмы.
      const r = isLeaf ? (rnd() < 0.3 ? 0 : 0.5 + rnd() * 2) : 0
      const s = scene.create({
        parent,
        position: [x, y, z],
        sphere: [0, 0, 0, r],
        visible: rnd() < 0.95,
      })
      slots.push(s)
      prev = rnd() < 0.5 ? s : prev
    }
    // Узел, к которому позже прикрепили детей, мог получить «листовую» сферу —
    // обнуляем ВСЕ внутренние узлы: их границы посчитает refit (охватывающие).
    for (const slot of slots) {
      if (scene.views.firstChild[slot] >= 0) scene.setSphereLocal(slot, 0, 0, 0, 0)
    }
    return { scene, slots }
  }

  it('битсеты совпадают на случайных сценах и камерах (property)', () => {
    const rnd = mulberry32(2026)
    for (let trial = 0; trial < 40; trial++) {
      const { scene } = buildScene(trial * 7 + 1, 60)
      scene.updateWorld()
      scene.refitGroupBounds()
      const cam = createCamera()
      const eye = [(rnd() - 0.5) * 30, (rnd() - 0.5) * 15, 10 + rnd() * 40]
      cam.setPerspective(0.5 + rnd() * 1.5, 0.5 + rnd(), 0.5, 120)
      cam.setViewLookAt(eye[0], eye[1], eye[2], 0, 0, 0, 0, 1, 0)
      writeCameraPlanes(scene.views, 0, cam.planes)
      const brute = cullViewsBrute(scene.views, 0, 0)
      const hier = cullViewsHierarchical(scene.views, 0, 1)
      const n = scene.count
      const w = scene.views.bitsWords
      const bruteBase = 0
      const hierBase = (1 * scene.views.cameraMax + 0) * w
      for (let r = 0; r < n; r++) {
        const bb = (scene.views.bits[bruteBase + (r >>> 5)] & (1 << (r & 31))) !== 0
        const hb = (scene.views.bits[hierBase + (r >>> 5)] & (1 << (r & 31))) !== 0
        if (bb !== hb) {
          // Диагностика провала.
          expect(`ранг ${r}: brute=${bb} hier=${hb} (trial ${trial})`).toBe('равны')
        }
      }
      expect(brute.visible).toBeGreaterThan(0)
      expect(hier.visible).toBe(brute.visible)
    }
  })

  it('trivial accept/reject видны в статистике', () => {
    const scene = createScene({ capacity: 16 })
    const root = scene.create({ position: [0, 0, 0], sphere: [0, 0, 0, 5] })
    for (let i = 0; i < 8; i++) {
      scene.create({ parent: root, position: [i - 4, 0, 0], sphere: [0, 0, 0, 1] })
    }
    scene.updateWorld()
    const cam = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 100)
    cam.setViewLookAt(0, 0, 50, 0, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    const stats = cullViewsHierarchical(scene.views, 0, 0)
    expect(stats.trivialAccepts).toBe(1) // корневая сфера целиком во фрустуме
    expect(stats.visible).toBe(9)
    // Развернули камеру — корень целиком сзади.
    cam.setViewLookAt(0, 0, 50, 0, 0, 100, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    const stats2 = cullViewsHierarchical(scene.views, 0, 0)
    expect(stats2.trivialRejects).toBe(1)
    expect(stats2.visible).toBe(0)
  })

  it('внутренний узел без границ не отсекает детей (безопасность)', () => {
    const scene = createScene({ capacity: 8 })
    const root = scene.create({ position: [0, 0, 0] }) // r=0 — неизвестный объём
    // Дети далеко в стороны: часть видна, часть нет.
    scene.create({ parent: root, position: [0, 0, 0], sphere: [0, 0, 0, 1] })
    scene.create({ parent: root, position: [500, 500, 0], sphere: [0, 0, 0, 1] })
    scene.updateWorld()
    const cam = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 100)
    cam.setViewLookAt(0, 0, 10, 0, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    const brute = cullViewsBrute(scene.views, 0, 0)
    const hier = cullViewsHierarchical(scene.views, 0, 1)
    expect(hier.visible).toBe(brute.visible)
    expect(brute.visible).toBe(2) // корень (бит консервативно) + ближний ребёнок
  })

  it('мультикамера: битсеты независимы', () => {
    const scene = createScene({ capacity: 8, cameraMax: 2 })
    scene.create({ position: [-10, 0, 0], sphere: [0, 0, 0, 1] })
    scene.create({ position: [10, 0, 0], sphere: [0, 0, 0, 1] })
    scene.updateWorld()
    const left = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 100)
    left.setViewLookAt(0, 0, 10, -10, 0, 0, 0, 1, 0)
    const right = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 100)
    right.setViewLookAt(0, 0, 10, 10, 0, 0, 0, 1, 0)
    scene.cull([left, right])
    const bits = scene.views.bits
    const w = scene.views.bitsWords
    const l0 = (bits[0 + (0 >>> 5)] & (1 << 0)) !== 0
    const l1 = (bits[0 + (1 >>> 5)] & (1 << 1)) !== 0
    const r0 = (bits[w + (0 >>> 5)] & (1 << 0)) !== 0
    const r1 = (bits[w + (1 >>> 5)] & (1 << 1)) !== 0
    expect(l0 && !l1).toBe(true) // левая камера видит только левый узел
    expect(r1 && !r0).toBe(true)
  })

  it('масштаб родителя масштабирует радиус мировой сферы ребёнка', () => {
    const scene = createScene({ capacity: 8 })
    const root = scene.create({ scale: [4, 4, 4] })
    scene.create({ parent: root, position: [0, 0, 0], sphere: [0, 0, 0, 1] })
    scene.updateWorld()
    const cam = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 100)
    cam.setViewLookAt(0, 0, 10, 0, 0, 0, 0, 1, 0)
    // Радиус ребёнка в мире = 1×4 = 4.
    scene.cull([cam])
    // Ребёнок на границе: центр в origin, r=4, расстояние до боковых
    // плоскостей на глубине 10 = 10 → внутри. Проверяем бит.
    expect(scene.isVisibleRank(0, 1)).toBe(true)
  })
})
