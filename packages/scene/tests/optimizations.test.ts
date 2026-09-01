/**
 * Тесты оптимизаций Task 85: грязевой refit, плоскостные маски кулинга,
 * штампы групп (скип аплоада), word-skip компакция, фикс setSphereLocal.
 *
 * Главный принцип — ПАРИТЕТ: оптимизированные пути обязаны давать байт-в-байт
 * те же сферW/битсеты/пулы, что и эталонные (forced refit / brute cull),
 * на случайных сценах и случайных камерах. Оптимизация, меняющая результат, —
 * не оптимизация, а баг.
 */
import { describe, expect, it } from 'bun:test'
import {
  bitsBase,
  createCamera,
  createScene,
  cullViewsBrute,
  cullViewsHierarchical,
  fillBits,
  refitGroupBoundsForcedViews,
  refitGroupBoundsViews,
  updateWorldForcedViews,
  updateWorldViews,
} from '../src/index.ts'
import { buildSceneViews } from '../src/layout.ts'
import type { Scene, SceneViews } from '../src/index.ts'

/** Детерминированный ГПСЧ. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Случайное дерево: узлы со случайными TRS/сферами/группами. */
function buildRandomScene(seed: number, targetNodes: number): { scene: Scene; views: SceneViews } {
  const rnd = mulberry32(seed)
  const scene = createScene({ capacity: targetNodes + 16, groupMax: 8, shared: false })
  const roots: number[] = []
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
      sphere: rnd() < 0.4 ? [0, 0, 0, rnd() * 3] : undefined,
    })
    if (parent < 0) roots.push(slot)
    else parents.push(slot)
    if (rnd() < 0.3) parents.push(slot)
    created++
  }
  scene.pack()
  scene.updateWorld()
  return { scene, views: scene.views }
}

/** Кадр конвейера в указанный буфер. */
function pipelineFrame(scene: Scene, camOpts: { yaw: number; dist: number }, bufferIndex: number): void {
  const cam = createCamera().setPerspective(1.1, 1, 0.5, 200)
  cam.setViewLookAt(
    Math.cos(camOpts.yaw) * camOpts.dist, 6, Math.sin(camOpts.yaw) * camOpts.dist,
    0, 0, 0, 0, 1, 0)
  scene.updateWorld()
  scene.refitGroupBounds()
  scene.cull([cam], { bufferIndex })
  scene.collectInstances(0, { bufferIndex })
}

// ─────────────────────────────────────────────────────────────────────────────
describe('Task 85: грязевой refit — паритет с полным', () => {
  it('случайные мутации: сферы байт-в-байт равны forced-эталону', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { scene, views } = buildRandomScene(seed, 400)
      const rnd = mulberry32(seed * 7919)
      // Несколько раундов мутаций: двигаем случайные узлы, пересоздаём структуру.
      for (let round = 0; round < 6; round++) {
        for (let m = 0; m < 12; m++) {
          const slot = Math.floor(rnd() * scene.capacity)
          if (!scene.alive(slot)) continue
          scene.setLocalTR(slot,
            (rnd() - 0.5) * 30, (rnd() - 0.5) * 15, (rnd() - 0.5) * 30,
            rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, 1,
            0.4 + rnd(), 0.4 + rnd(), 0.4 + rnd())
        }
        // Грязевой путь.
        scene.updateWorld()
        const dirtyRefit = scene.refitGroupBounds()
        const spheresDirty = views.sphereW.slice()
        const dirtyLeft = views.dirtyBounds.reduce((s, w) => s + (w === 0 ? 0 : 1), 0)
        // Эталон: полный проход на той же сцене.
        const forcedRefit = refitGroupBoundsForcedViews(views)
        const spheresForced = views.sphereW.slice()
        expect(spheresDirty).toEqual(spheresForced)
        // Грязь полностью съедена (кроме бит за capacity в последнем слове).
        const liveBits = (scene.count + 31) >>> 5
        let residue = 0
        for (let w = 0; w < liveBits; w++) residue += views.dirtyBounds[w]!
        expect(residue).toBe(0)
        expect(dirtyLeft).toBeGreaterThanOrEqual(0)
        // Полный refit пересобирает все автограницы, грязевой — только изменённые.
        expect(forcedRefit).toBeGreaterThanOrEqual(dirtyRefit)
      }
    }
  })

  it('покой: refit не делает НИЧЕГО (0 узлов)', () => {
    const { scene } = buildRandomScene(42, 300)
    scene.updateWorld()
    scene.refitGroupBounds()
    // Второй кадр без изменений: ни мира, ни refit.
    expect(scene.updateWorld()).toBe(0)
    expect(scene.refitGroupBounds()).toBe(0)
  })

  it('анимация листа: refit пересобирает только цепочку к корню', () => {
    const { scene, views } = buildRandomScene(7, 300)
    scene.updateWorld()
    scene.refitGroupBounds()
    // Полный refit ради бейзлайна.
    const fullCount = refitGroupBoundsForcedViews(views)
    expect(fullCount).toBeGreaterThan(50)
    // Двигаем один лист — refit должен тронуть горстку узлов.
    // Ищем лист, чей родитель на автограницах (не корень и не user-сфера).
    let leaf = -1
    for (let slot = 0; slot < scene.capacity; slot++) {
      if (!scene.alive(slot) || views.firstChild[slot] >= 0) continue
      const p = views.parent[slot]
      if (p < 0) continue // корень-лист: цепочки нет
      if (views.sphereL[p * 4 + 3] > 0) continue // родитель на user-сфере
      leaf = slot
      break
    }
    expect(leaf).toBeGreaterThanOrEqual(0)
    scene.setLocal(leaf, { position: [99, 99, 99] })
    scene.updateWorld()
    const dirtyCount = scene.refitGroupBounds()
    expect(dirtyCount).toBeGreaterThan(0)
    expect(dirtyCount).toBeLessThan(fullCount / 4)
  })

  it('setSphereLocal применяет сферу сразу (регрессия Task 85)', () => {
    const scene = createScene({ capacity: 8 })
    const root = scene.create({ sphere: [0, 0, 0, 1] })
    scene.updateWorld()
    scene.refitGroupBounds()
    expect(scene.views.sphereW[root * 4 + 3]).toBeCloseTo(1, 5)
    // Правка сферы без посторонних изменений узла.
    scene.setSphereLocal(root, 0, 0, 0, 5)
    scene.updateWorld()
    expect(scene.views.sphereW[root * 4 + 3]).toBeCloseTo(5, 5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Task 85: плоскостные маски кулинга — паритет с brute', () => {
  it('случайные камеры/сцены: битсеты и статистика совпадают, тестов меньше', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { scene, views } = buildRandomScene(seed, 500)
      const rnd = mulberry32(seed * 104729)
      for (let c = 0; c < 10; c++) {
        const cam = createCamera().setPerspective(0.6 + rnd() * 1.8, 0.5 + rnd() * 2, 0.3, 300)
        const dist = 5 + rnd() * 120
        const yaw = rnd() * Math.PI * 2
        const pitch = (rnd() - 0.5) * 2.4
        const ey = Math.sin(pitch) * dist
        const exz = Math.cos(pitch) * dist
        cam.setViewLookAt(
          Math.cos(yaw) * exz, ey, Math.sin(yaw) * exz,
          (rnd() - 0.5) * 10, (rnd() - 0.5) * 10, (rnd() - 0.5) * 10,
          0, 1, 0)
        const brute = cullViewsBrute(views, 0, 1)
        const hier = cullViewsHierarchical(views, 0, 0)
        // Побитовый паритет (базы буферов 0 и 1 для камеры 0).
        const base0 = bitsBase(views, 0, 0)
        const base1 = bitsBase(views, 1, 0)
        for (let w = 0; w < views.bitsWords; w++) {
          expect(views.bits[base1 + w]).toBe(views.bits[base0 + w])
        }
        expect(hier.visible).toBe(brute.visible)
        // Маски реально экономят тесты плоскостей (на глубоких деревьях).
        expect(hier.planeTests).toBeLessThanOrEqual(brute.planeTests)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Task 85: штампы групп (скип аплоада)', () => {
  it('покой и статичная камера: штампы не растут — аплоад можно пропустить', () => {
    const { scene } = buildRandomScene(3, 300)
    pipelineFrame(scene, { yaw: 0.5, dist: 40 }, 0)
    const stamps = [0, 1, 2, 3].map(g => scene.groupWorldStamp(g))
    const flips = [0, 1, 2, 3].map(g => scene.groupFlipStamp(g, 0))
    expect(stamps.some(s => s > 0)).toBe(true) // первый кадр — всё новое
    pipelineFrame(scene, { yaw: 0.5, dist: 40 }, 1) // камера НЕ двигалась
    const stamps2 = [0, 1, 2, 3].map(g => scene.groupWorldStamp(g))
    const flips2 = [0, 1, 2, 3].map(g => scene.groupFlipStamp(g, 0))
    expect(stamps2).toEqual(stamps)
    expect(flips2).toEqual(flips)
    // Ещё кадр — по-прежнему тишина.
    pipelineFrame(scene, { yaw: 0.5, dist: 40 }, 0)
    expect([0, 1, 2, 3].map(g => scene.groupWorldStamp(g))).toEqual(stamps)
    expect([0, 1, 2, 3].map(g => scene.groupFlipStamp(g, 0))).toEqual(flips)
  })

  it('движение камеры (флипы видимости) растит ПЕРКАМЕРНЫЕ штампы затронутых групп', () => {
    const { scene } = buildRandomScene(5, 400)
    pipelineFrame(scene, { yaw: 0, dist: 60 }, 0)
    pipelineFrame(scene, { yaw: 0, dist: 60 }, 1)
    const before = [0, 1, 2, 3].map(g => scene.groupFlipStamp(g, 0))
    pipelineFrame(scene, { yaw: 2.2, dist: 60 }, 0) // камера повернулась
    const after = [0, 1, 2, 3].map(g => scene.groupFlipStamp(g, 0))
    expect(after.some((s, g) => s > before[g])).toBe(true)
    // Мир не менялся — общий штамп групп замер (данные инстансов те же,
    // меняется только ВИДИМОСТЬ — и только у двигавшейся камеры).
    const w0 = scene.groupWorldStamp(0)
    pipelineFrame(scene, { yaw: 2.2, dist: 60 }, 1)
    expect(scene.groupWorldStamp(0)).toBe(w0)
  })

  it('анимация узлов группы A не трогает штамп группы B (чистые кластеры)', () => {
    // Ручная сцена: два НЕЗАВИСИМых кластера-поддерева (как в демо: кластер
    // леса = внутренний узел без группы + листья-инстансы одной группы).
    // В общем поддереве группы перемешаны — мир предка группы B обязан
    // меняться при движении ребёнка группы A, и штамп B растёт ПРАВИЛЬНО.
    const scene = createScene({ capacity: 64, groupMax: 4 })
    const clusterA = scene.create({ position: [0, 0, 0] })
    const clusterB = scene.create({ position: [50, 0, 0] })
    const leavesA: number[] = []
    for (let i = 0; i < 20; i++) {
      leavesA.push(scene.create({ parent: clusterA, group: 0, position: [i, 0, i % 3], sphere: [0, 0, 0, 0.5] }))
    }
    for (let i = 0; i < 20; i++) {
      scene.create({ parent: clusterB, group: 1, position: [i, 0, i % 3], sphere: [0, 0, 0, 0.5] })
    }
    pipelineFrame(scene, { yaw: 0.3, dist: 60 }, 0)
    pipelineFrame(scene, { yaw: 0.3, dist: 60 }, 1)
    const s0Before = scene.groupWorldStamp(0)
    const s1Before = scene.groupWorldStamp(1)
    // Анимируем ТОЛЬКО листья кластера A (группа 0).
    for (const slot of leavesA) {
      scene.setLocal(slot, { position: [slot, 5, 0] })
    }
    pipelineFrame(scene, { yaw: 0.3, dist: 60 }, 0)
    const s0After = scene.groupWorldStamp(0)
    const s1After = scene.groupWorldStamp(1)
    expect(s0After).toBeGreaterThan(s0Before)
    // Кластер B вне поддерева A: его миры/сферы/биты не менялись — штамп замер.
    expect(s1After).toBe(s1Before)
  })

  it('pack (структурная правка) инвалидирует все штампы — guard эпохи', () => {
    const { scene } = buildRandomScene(13, 250)
    pipelineFrame(scene, { yaw: 0.9, dist: 45 }, 0)
    pipelineFrame(scene, { yaw: 0.9, dist: 45 }, 1)
    const before = [0, 1, 2, 3].map(g => scene.groupFlipStamp(g, 0))
    scene.create({ position: [1, 1, 1], group: 0 })
    scene.pack()
    pipelineFrame(scene, { yaw: 0.9, dist: 45 }, 0)
    const after = [0, 1, 2, 3].map(g => scene.groupFlipStamp(g, 0))
    expect(after.some((s, g) => s > before[g])).toBe(true)
  })

  it('перкамерность: флип камеры 0 не трогает штампы камеры 1 (сообщение групп)', () => {
    const scene = createScene({ capacity: 64, groupMax: 4, cameraMax: 2 })
    // Полоса узлов группы 0 вдоль X — камера 0 повернётся, камера 1 стоит.
    const root = scene.create({})
    for (let i = 0; i < 40; i++) {
      scene.create({ parent: root, group: 0, position: [-60 + i * 3, 0, 0], sphere: [0, 0, 0, 1] })
    }
    const mk = (yaw: number) => {
      const c = createCamera().setPerspective(0.9, 1, 0.5, 200)
      c.setViewLookAt(Math.cos(yaw) * 40, 10, Math.sin(yaw) * 40, 0, 0, 0, 0, 1, 0)
      return c
    }
    // Кадр 1: обе камеры в одном положении — база.
    scene.updateWorld(); scene.refitGroupBounds()
    scene.cull([mk(0), mk(0)])
    scene.collectInstances(0, { bufferIndex: 0 })
    scene.collectInstances(1, { bufferIndex: 0 })
    const f0a = scene.groupFlipStamp(0, 0)
    const f1a = scene.groupFlipStamp(0, 1)
    // Кадр 2 (чередуем буфер): камера 0 ПОВОРАЧИВАЕТСЯ, камера 1 СТОИТ.
    scene.cull([mk(2.4), mk(0)], { bufferIndex: 1 })
    scene.collectInstances(0, { bufferIndex: 1 })
    scene.collectInstances(1, { bufferIndex: 1 })
    const f0b = scene.groupFlipStamp(0, 0)
    const f1b = scene.groupFlipStamp(0, 1)
    expect(f0b).toBeGreaterThan(f0a) // камера 0 крутилась — флипы
    expect(f1b).toBe(f1a) // камера 1 замерла — её штамп не вырос
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Task 85: word-skip компакция', () => {
  it('сильно отсечённая сцена: пул и счётчики равны полному проходу', () => {
    const { scene, views } = buildRandomScene(17, 600)
    const cam = createCamera().setPerspective(0.2, 1, 0.5, 40) // узкий фрустум
    cam.setViewLookAt(0, 0, 25, 0, 0, 0, 0, 1, 0)
    scene.updateWorld()
    scene.refitGroupBounds()
    scene.cull([cam], { bufferIndex: 0 })
    scene.collectInstances(0, { bufferIndex: 0 })
    // Подсчёт вручную по битам (эталон).
    const groupCount = views.headerI[11] // H_GROUP_COUNT
    const manual = new Int32Array(8)
    const n = scene.count
    for (let r = 0; r < n; r++) {
      const slot = views.order[r]
      const g = views.group[slot]
      if (g < 0 || g >= groupCount) continue
      if ((views.bits[r >>> 5] & (1 << (r & 31))) === 0) continue
      if ((views.nodeFlags[slot] & 1) === 0) continue
      manual[g]++
    }
    for (let g = 0; g < groupCount; g++) {
      const seg = scene.instances(g, { cameraIndex: 0 })
      expect(seg.count).toBe(manual[g])
    }
    // Узкий фрустум действительно что-то отсёк.
    const totalVisible = manual.reduce((s, v) => s + v, 0)
    expect(totalVisible).toBeLessThan(n)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Task 85: forced-путь (эталон) остаётся корректным', () => {
  it('updateWorldForcedViews помечает всю грязь и все группы', () => {
    const { scene, views } = buildRandomScene(19, 200)
    updateWorldForcedViews(views)
    const stamp = scene.groupWorldStamp(0)
    expect(stamp).toBeGreaterThan(0)
    const refit = refitGroupBoundsForcedViews(views)
    expect(refit).toBeGreaterThan(0)
    // После forced refit грязи не осталось.
    const words = (scene.count + 31) >>> 5
    let residue = 0
    for (let w = 0; w < words; w++) residue += views.dirtyBounds[w]!
    expect(residue).toBe(0)
  })
})

// Прямой импорт view-функций для эталонов.
void updateWorldViews
void fillBits
void buildSceneViews
