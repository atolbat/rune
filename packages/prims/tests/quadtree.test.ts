import { describe, expect, test } from 'bun:test'
import {
  quadtreeTileMesh,
  selectQuadtreeTiles,
} from '../src/quadtree.ts'

// ─── Выборка: инварианты покрытия ───────────────────────────────────────────

describe('selectQuadtreeTiles', () => {
  test('уровень 1 = только корень', () => {
    const sel = selectQuadtreeTiles({ centerX: 0, centerZ: 0, rootSize: 100, levels: 1 })
    expect(sel.count).toBe(1)
    expect(sel.instances[0]).toBe(0) // cx
    expect(sel.instances[1]).toBe(0) // cz
    expect(sel.instances[2]).toBe(100) // size
    expect(sel.instances[3]).toBe(0) // level
    expect(sel.minLevel).toBe(0)
    expect(sel.maxLevel).toBe(0)
  })

  test('полное покрытие без перекрытий: сумма площадей == площади корня', () => {
    // Центр ВНЕ центра корня — худший случай для перекрытий/дыр.
    for (const [cx, cz] of [[0, 0], [37.3, -11.9], [500, 500]] as const) {
      const sel = selectQuadtreeTiles({
        centerX: cx,
        centerZ: cz,
        rootSize: 1024,
        levels: 6,
        splitFactor: 0.5,
      })
      let area = 0
      for (let i = 0; i < sel.count; i++) {
        const size = sel.instances[i * 4 + 2]
        area += size * size
      }
      expect(area).toBeCloseTo(1024 * 1024, 6)
    }
  })

  test('размеры тайлов — только степени двойки от rootSize', () => {
    const sel = selectQuadtreeTiles({
      centerX: 12, centerZ: -5, rootSize: 512, levels: 8, splitFactor: 0.25,
    })
    expect(sel.count).toBeGreaterThan(1)
    for (let i = 0; i < sel.count; i++) {
      const size = sel.instances[i * 4 + 2]
      const level = sel.instances[i * 4 + 3]
      expect(size).toBeCloseTo(512 / Math.pow(2, level), 10)
      expect(Number.isInteger(level)).toBe(true)
      expect(level).toBeGreaterThanOrEqual(0)
      expect(level).toBeLessThan(8)
    }
  })

  test('близко к центру — мелкие тайлы, далеко — крупные (LOD)', () => {
    const sel = selectQuadtreeTiles({
      centerX: 0, centerZ: 0, rootSize: 2048, levels: 8, splitFactor: 0.2,
    })
    expect(sel.maxLevel).toBe(7) // под камерой — максимальный уровень
    let nearSize = Infinity
    let farSize = 0
    for (let i = 0; i < sel.count; i++) {
      const d = Math.hypot(sel.instances[i * 4], sel.instances[i * 4 + 1])
      if (d < 100) nearSize = Math.min(nearSize, sel.instances[i * 4 + 2])
      if (d > 800) farSize = Math.max(farSize, sel.instances[i * 4 + 2])
    }
    expect(nearSize).toBe(2048 / 128) // 16 — самый мелкий
    expect(farSize).toBeGreaterThan(nearSize * 4)
  })

  test('число тайлов ограничено: плотный фактор не взрывает счёт', () => {
    const sel = selectQuadtreeTiles({
      centerX: 0, centerZ: 0, rootSize: 16384, levels: 10,
      splitFactor: 0.17, maxTiles: 512,
    })
    expect(sel.count).toBeLessThanOrEqual(512)
    expect(sel.count).toBeGreaterThan(16)
    // БЕЗ кэпа плотный фактор даёт ~2К тайлов (замер Task 113 — тюнинг
    // параметров демо): предохранитель обязателен для дешёвых устройств.
    const uncapped = selectQuadtreeTiles({
      centerX: 0, centerZ: 0, rootSize: 16384, levels: 10, splitFactor: 0.17,
    })
    expect(uncapped.count).toBeGreaterThan(512)
  })

  test('повторное использование out: без аллокаций на тёплом кадре', () => {
    const out = selectQuadtreeTiles({ centerX: 0, centerZ: 0, rootSize: 256, levels: 4 })
    const first = out.instances
    const again = selectQuadtreeTiles({
      centerX: 3, centerZ: 4, rootSize: 256, levels: 4, out,
    })
    expect(again).toBe(out)
    expect(again.instances).toBe(first) // тот же буфер (рост не понадобился)
    expect(again.count).toBeGreaterThan(0)
    // Хвост за count не читается как мусор — count честный
    expect(again.instances.length).toBeGreaterThanOrEqual(again.count * 4)
  })

  test('фрустум-куллинг: корень целиком снаружи плоскости отсекается', () => {
    // Внутри = полуплоскость x ≥ -100. Корень [-350..-250] целиком левее.
    const planes = new Float32Array([
      0, 0, 1, 16384,
      0, 0, -1, 16384,
      0, 1, 0, 16384,
      0, -1, 0, 16384,
      1, 0, 0, 100, // x ≥ -100
      -1, 0, 0, 16384,
    ])
    const sel = selectQuadtreeTiles({
      centerX: -300, centerZ: 0, rootSize: 100, levels: 4, splitFactor: 0.5,
      frustum: planes,
    })
    expect(sel.count).toBe(0)

    // Тот же корень, но пересекающий границу — остаётся (консервативность).
    const straddling = selectQuadtreeTiles({
      centerX: -60, centerZ: 0, rootSize: 100, levels: 4, splitFactor: 0.5,
      frustum: planes,
    })
    expect(straddling.count).toBeGreaterThan(0)
  })

  test('фрустум-куллинг: узкий коридор оставляет полосу тайлов', () => {
    // Внутри = узкая полоса |x| ≤ 50 вокруг центра.
    const planes = new Float32Array([
      0, 0, 1, 16384,
      0, 0, -1, 16384,
      0, 1, 0, 16384,
      0, -1, 0, 16384,
      1, 0, 0, 50,
      -1, 0, 0, 50,
    ])
    const sel = selectQuadtreeTiles({
      centerX: 0, centerZ: 0, rootSize: 512, levels: 3, splitFactor: 1,
      frustum: planes,
    })
    expect(sel.count).toBeGreaterThan(0)
    // Каждый оставшийся тайл либо внутри полосы, либо задевает её
    // (консервативность: не должно быть тайлов ЦЕЛИКОМО снаружи).
    for (let i = 0; i < sel.count; i++) {
      const cx = sel.instances[i * 4]
      const size = sel.instances[i * 4 + 2]
      expect(cx + size / 2).toBeGreaterThan(-50)
      expect(cx - size / 2).toBeLessThan(50)
    }
  })

  test('снап центра не ломает инварианты (стабильность тесселяции)', () => {
    // Снап к 2·(rootSize/2^levels): выборка на снапнутой сетке меняется
    // только при пересечении границы — проверяем что покрытие остаётся полным.
    for (let s = 0; s < 8; s++) {
      const snap = (2 * 1024) / 128
      const cx = s * snap - 3.5 * snap
      const sel = selectQuadtreeTiles({
        centerX: Math.round(cx / snap) * snap,
        centerZ: 0,
        rootSize: 1024,
        levels: 7,
        splitFactor: 0.3,
      })
      let area = 0
      for (let i = 0; i < sel.count; i++) area += sel.instances[i * 4 + 2] ** 2
      expect(area).toBeCloseTo(1024 * 1024, 6)
    }
  })

  test('ошибки валидации аргументов', () => {
    expect(() =>
      selectQuadtreeTiles({ centerX: 0, centerZ: 0, rootSize: -1, levels: 4 }),
    ).toThrow()
    expect(() =>
      selectQuadtreeTiles({ centerX: 0, centerZ: 0, rootSize: 100, levels: 0 }),
    ).toThrow()
    expect(() =>
      selectQuadtreeTiles({ centerX: 0, centerZ: 0, rootSize: 100, levels: 2, splitFactor: 0 }),
    ).toThrow()
    expect(() =>
      selectQuadtreeTiles({
        centerX: 0, centerZ: 0, rootSize: 100, levels: 2,
        frustum: new Float32Array(12),
      }),
    ).toThrow()
  })
})

// ─── Тайл-меш ───────────────────────────────────────────────────────────────

describe('quadtreeTileMesh', () => {
  test('сетка 4×4: размеры и счётчики', () => {
    const mesh = quadtreeTileMesh({ segments: 4, skirt: false })
    expect(mesh.vertexCount).toBe(25)
    expect(mesh.skirtVertexCount).toBe(0)
    expect(mesh.indices.length).toBe(4 * 4 * 6)
    // edge-сетка 4×4: 5·4·2 (гор+верт) + 16 (диагонали) = 56 рёбер
    expect(mesh.edgeIndices.length).toBe(56 * 2)
    expect(mesh.positions.length).toBe(25 * 3)
    expect(mesh.uvs.length).toBe(25 * 2)
  })

  test('юбка: +4·(segments+1) вершин и стенки по периметру', () => {
    const segments = 8
    const mesh = quadtreeTileMesh({ segments, skirt: true })
    expect(mesh.vertexCount).toBe(9 * 9 + 4 * 9)
    expect(mesh.skirtVertexCount).toBe(4 * 9)
    // треугольники: сетка + 4 стенки × segments квадов × 2
    expect(mesh.indices.length).toBe((8 * 8 * 2 + 8 * 8) * 3)
    // юбка-вершины: те же UV, флаг 1
    let skirtVerts = 0
    for (let i = 0; i < mesh.vertexCount; i++) {
      const skirt = mesh.positions[i * 3 + 2]
      expect(skirt === 0 || skirt === 1).toBe(true)
      if (skirt === 1) {
        skirtVerts++
        // юбка-вершина лежит на кромке [0..1]
        const u = mesh.positions[i * 3]
        const v = mesh.positions[i * 3 + 1]
        const onEdge = u === 0 || u === 1 || v === 0 || v === 1
        expect(onEdge).toBe(true)
      }
    }
    expect(skirtVerts).toBe(4 * 9)
    // все индексы в диапазоне
    for (const idx of mesh.indices) expect(idx).toBeLessThan(mesh.vertexCount)
  })

  test('дефолт: 32 сегмента, юбка включена', () => {
    const mesh = quadtreeTileMesh()
    expect(mesh.segments).toBe(32)
    expect(mesh.skirtVertexCount).toBe(4 * 33)
    expect(mesh.vertexCount).toBe(33 * 33 + 4 * 33)
    // производительность: ~1.1К вершин, ~2.6К треугольников — копейки
    expect(mesh.indices.length).toBe((32 * 32 * 2 + 32 * 8) * 3)
  })

  test('edge-индексы не включают юбку (LOD-структура читается чисто)', () => {
    const mesh = quadtreeTileMesh({ segments: 4 })
    const gridCount = 25
    for (const idx of mesh.edgeIndices) expect(idx).toBeLessThan(gridCount)
  })

  test('треугольники сетки CCW при взгляде сверху (+Y)', () => {
    const mesh = quadtreeTileMesh({ segments: 2, skirt: false })
    // (topLeft, bottomLeft, bottomRight): нормаль по правилу правой руки
    // смотрит ВВЕРХ (+Y) — та же ориентация, что prims/grid и david.li/waves.
    const [a, b, c] = [mesh.indices[0], mesh.indices[1], mesh.indices[2]]
    const ax = mesh.positions[a * 3], az = mesh.positions[a * 3 + 1]
    const bx = mesh.positions[b * 3], bz = mesh.positions[b * 3 + 1]
    const cx2 = mesh.positions[c * 3], cz2 = mesh.positions[c * 3 + 1]
    // y-компонента 3D-креста (b−a)×(c−a) для векторов в плоскости y=0.
    const uy = (bz - az) * (cx2 - ax) - (bx - ax) * (cz2 - az)
    expect(uy).toBeGreaterThan(0)
  })

  test('ошибки валидации', () => {
    expect(() => quadtreeTileMesh({ segments: 0 })).toThrow()
    expect(() => quadtreeTileMesh({ segments: 1.5 })).toThrow()
    expect(() => quadtreeTileMesh({ segments: 1000 })).toThrow()
  })
})
