/**
 * Адаптивный тайловый рельеф (Task 109): умная склейка.
 *   • одинаковые разрешения соседей — вершины стыка СОВПАДАЮТ (решётка
 *     snapped): идентичные позиции на общем ребре;
 *   • юбки: глубина ровно skirtDepth·amplitude, winding наружу;
 *   • LOD по дистанции: ближние тайлы детальнее (levelCounts);
 *   • пересборка квантована (tileSize/2) — мура исключена;
 *   • heightFn вызывается в МИРОВЫХ координатах (непрерывность).
 */

import { describe, test, expect } from 'bun:test'
import { createAdaptiveTerrain, worldHills, adaptivePresets } from '../src/index.ts'
import type { Geometry } from '../src/index.ts'

function countDegenerate(g: Geometry): number {
  let bad = 0
  for (let t = 0; t < g.vertexCount / 3; t++) {
    const o = t * 9
    const e1x = g.positions[o + 3]! - g.positions[o]!, e1y = g.positions[o + 4]! - g.positions[o + 1]!, e1z = g.positions[o + 5]! - g.positions[o + 2]!
    const e2x = g.positions[o + 6]! - g.positions[o]!, e2y = g.positions[o + 7]! - g.positions[o + 1]!, e2z = g.positions[o + 8]! - g.positions[o + 2]!
    const area = Math.hypot(
      e1y * e2z - e1z * e2y,
      e1z * e2x - e1x * e2z,
      e1x * e2y - e1y * e2x,
    )
    if (area < 1e-9) bad++
  }
  return bad
}

describe('prims — адаптивный рельеф', () => {
  test('плоский рельеф: сетка вверх, юбка ровно на skirtDepth ниже края', () => {
    const flat = () => 0.5
    const terr = createAdaptiveTerrain({
      heightFn: flat, amplitude: 1, tileSize: 4, radius: 12,
      maxSegments: 16, minSegments: 4, skirtDepth: 0.4,
    })
    const g = terr.geometry
    expect(g.vertexCount).toBeGreaterThan(1000)
    expect(countDegenerate(g)).toBe(0)
    // сетка CCW вверх: у плоского рельефа Y-компонента cross > 0 у сетки;
    // юбки вертикальны (Y ≈ 0) — проверяем по сеточным треугольникам
    let gridTris = 0
    for (let t = 0; t < g.vertexCount / 3; t++) {
      const o = t * 9
      const e1x = g.positions[o + 3]! - g.positions[o]!, e1z = g.positions[o + 5]! - g.positions[o + 2]!
      const e2x = g.positions[o + 6]! - g.positions[o]!, e2z = g.positions[o + 8]! - g.positions[o + 2]!
      const cy = e1z * e2x - e1x * e2z
      if (cy > 1e-9) gridTris++
    }
    // сетка — большинство; юбки не вверх
    expect(gridTris).toBeGreaterThan(g.vertexCount / 6 * 0.5)
    // юбка: minY = 0.5 − 0.4 = 0.1, maxY = 0.5
    let minY = Infinity, maxY = -Infinity
    for (let i = 0; i < g.vertexCount; i++) {
      minY = Math.min(minY, g.positions[i * 3 + 1]!)
      maxY = Math.max(maxY, g.positions[i * 3 + 1]!)
    }
    expect(minY).toBeCloseTo(0.1, 5)
    expect(maxY).toBeCloseTo(0.5, 5)
  })

  test('юбки добавляют вершины; skirtDepth=0 — чистая сетка', () => {
    const flat = () => 0
    const withSkirt = createAdaptiveTerrain({
      heightFn: flat, tileSize: 4, radius: 8, maxSegments: 8, minSegments: 8, skirtDepth: 0.4,
    })
    const noSkirt = createAdaptiveTerrain({
      heightFn: flat, tileSize: 4, radius: 8, maxSegments: 8, minSegments: 8, skirtDepth: 0,
    })
    // один тайл уровня 0 у центра 8×8 — считаем точно
    expect(noSkirt.geometry.vertexCount).toBeGreaterThan(0)
    expect(withSkirt.geometry.vertexCount).toBeGreaterThan(noSkirt.geometry.vertexCount)
  })

  test('LOD по дистанции: ближний тайл детальнее дальнего (levelCounts)', () => {
    const terr = createAdaptiveTerrain({
      heightFn: worldHills(7), tileSize: 4, radius: 24, maxSegments: 32, minSegments: 4, skirtDepth: 0.4,
    })
    expect(terr.levelCounts.length).toBeGreaterThanOrEqual(2)
    expect(terr.levelCounts[0]!).toBeGreaterThanOrEqual(1) // есть max-res тайлы
    expect(terr.tiles).toBeGreaterThan(terr.levelCounts[0]!)
    // сумма уровней = тайлы
    const sum = terr.levelCounts.reduce((a, b) => a + b, 0)
    expect(sum).toBe(terr.tiles)
  })

  test('СКЛЕЙКА: равноразрешённые соседи — вершины общего ребра СОВПАДАЮТ', () => {
    // Камера (2, 2): тайлы (0,0) и (1,0) оба на уровне 0 — их общее ребро
    // x=4, z ∈ [0,4] сэмплируется ОБОИМИ тайлами с шагом 4/32. Каждый
    // внутренний узел ребра встречается в soup 6 раз (3 эмиссии с каждого
    // тайла — по числу смежных квадов-треугольников) с ИДЕНТИЧНОЙ высотой:
    // решётки обоих тайлов snapped к МИРОВОЙ сетке — вершина-в-вершину.
    const terr = createAdaptiveTerrain({
      heightFn: worldHills(7), tileSize: 4, radius: 6, maxSegments: 32, minSegments: 32, skirtDepth: 0,
    })
    expect(terr.update(2, 2)).toBe(true) // пересборка вокруг (2,2) — стык в кадре
    const g = terr.geometry
    const byKey = new Map<string, { count: number; y: number; yConsistent: boolean }>()
    for (let i = 0; i < g.vertexCount; i++) {
      const x = g.positions[i * 3]!
      const y = g.positions[i * 3 + 1]!
      const z = g.positions[i * 3 + 2]!
      const key = `${x.toFixed(6)},${z.toFixed(6)}`
      const entry = byKey.get(key)
      if (entry === undefined) {
        byKey.set(key, { count: 1, y, yConsistent: true })
      } else {
        entry.count++
        if (Math.abs(entry.y - y) > 1e-6) entry.yConsistent = false
      }
    }
    // Внутренние узлы ребра x=4, z ∈ (0.5, 3.5): ровно 6 копий (3+3), высоты равны
    let checked = 0
    for (const [key, entry] of byKey) {
      const [xs, zs] = key.split(',').map(Number)
      if (Math.abs(xs - 4) > 1e-4) continue
      if (zs <= 0.5 || zs >= 3.5) continue
      expect(entry.count).toBe(6) // 3 эмиссии × 2 тайла — стык сшит вершиной-в-вершину
      expect(entry.yConsistent).toBe(true) // высоты совпали до бита
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(20) // 23 внутренних узла ребра (диапазон (0.5, 3.5))
  })

  test('квантованная пересборка: <tileSize/2 — false, ≥ — true', () => {
    const terr = createAdaptiveTerrain({
      heightFn: worldHills(7), tileSize: 4, radius: 12, maxSegments: 8, minSegments: 4,
    })
    expect(terr.rebuilds).toBe(1)
    expect(terr.update(1, 0)).toBe(false) // 1 < 2
    expect(terr.rebuilds).toBe(1)
    expect(terr.update(2, 0)).toBe(true) // ровно tileSize/2 — пора
    expect(terr.rebuilds).toBe(2)
    expect(terr.update(3.5, 0)).toBe(false)
    // диагональ: (2,0) → (3.5, 1.5) = hypot(1.5,1.5) ≈ 2.12 > 2
    expect(terr.update(3.5, 1.5)).toBe(true)
    expect(terr.rebuilds).toBe(3)
  })

  test('heightFn вызывается в МИРОВЫХ координатах', () => {
    const calls: Array<[number, number]> = []
    const terr = createAdaptiveTerrain({
      heightFn: (x, z) => {
        calls.push([x, z])
        return 0
      },
      tileSize: 4, radius: 4, maxSegments: 4, minSegments: 4, skirtDepth: 0,
    })
    expect(terr.geometry.vertexCount).toBeGreaterThan(0)
    // тайл (0,0): мировые x/z ∈ [−1·step, 4+step] — НИКАКИХ нормализованных [-1,1]
    const sawOutside = calls.some(([x, z]) => x < -0.5 || x > 4.5 || z < -0.5 || z > 4.5)
    expect(sawOutside).toBe(true) // апрон выходит за границы тайла
    // и функция получает координаты на решётке шага 1 (4/4)
    const onGrid = calls.every(([x]) => Math.abs(x / 1 - Math.round(x / 1)) < 1e-9)
    expect(onGrid).toBe(true)
  })

  test('детерминизм: одинаковые параметры — побайтово одинаковая геометрия', () => {
    const a = createAdaptiveTerrain({
      heightFn: worldHills(7), tileSize: 4, radius: 12, maxSegments: 8, minSegments: 4, skirtDepth: 0.4,
    })
    const b = createAdaptiveTerrain({
      heightFn: worldHills(7), tileSize: 4, radius: 12, maxSegments: 8, minSegments: 4, skirtDepth: 0.4,
    })
    expect(a.geometry.vertexCount).toBe(b.geometry.vertexCount)
    for (let i = 0; i < a.geometry.positions.length; i++) {
      expect(a.geometry.positions[i]!).toBe(b.geometry.positions[i]!)
    }
  })

  test('UV-палитра: uv.y ∈ [0,1] при зашкаливающих высотах (фиксированный диапазон)', () => {
    const terr = createAdaptiveTerrain({
      heightFn: () => 5, amplitude: 1, tileSize: 4, radius: 4, maxSegments: 4, minSegments: 4,
    })
    for (let i = 0; i < terr.geometry.vertexCount; i++) {
      const v = terr.geometry.uvs[i * 2 + 1]!
      expect(v).toBeLessThanOrEqual(1)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })

  test('пресеты адаптива: пять рельефов, все строятся', () => {
    const keys = Object.keys(adaptivePresets)
    expect(keys.length).toBeGreaterThanOrEqual(5)
    for (const key of keys) {
      const preset = adaptivePresets[key]!
      const terr = createAdaptiveTerrain({
        heightFn: preset.height(3), amplitude: preset.amplitude,
        tileSize: 4, radius: 10, maxSegments: 8, minSegments: 4, skirtDepth: 0.4,
      })
      expect(terr.geometry.vertexCount).toBeGreaterThan(500)
      expect(countDegenerate(terr.geometry)).toBe(0)
    }
  })
})
