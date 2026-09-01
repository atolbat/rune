/**
 * terrainQuadtree.test.ts — примитив terrain на кваддреве (Task 115).
 *
 * Система = валидированная квадтри-система FFT-океана (Task 113): мировая
 * фикс-сетка корней (вершины не плывут), дробление по 3D-дистанции с лимитом
 * глубины, юбки, ноль аллокаций на кадр. Здесь — инварианты примитива:
 *  • ПОКРЫТИЕ без дыр: каждая точка диска «камера ± horizon» накрыта листом;
 *  • детерминизм и «неплывучесть» (фикс-сетка): малый сдвиг камеры внутри
 *    листа не меняет набор листьев;
 *  • лимит ближней детализации (minLeafSize — жёсткий потолок);
 *  • монотонность LOD-агрессивности (больше A ⇒ меньше листьев);
 *  • патч-юбка: вершины юбки ПАРАЗИТНО совпадают по (x,z) с кромкой
 *    (побитово — тот же uv ⇒ тот же дисплейс ⇒ нет трещин);
 *  • ноль аллокаций на кадр (синглтон-результат);
 *  • CPU-высота и пресеты.
 */
import { describe, test, expect } from 'bun:test'
import { createTerrainQuadtree, terrainQuadtreePresets, terrainHills } from '../src/terrainQuadtree.ts'
import { selectQuadtreeLeaves, quadtreePatch, PATCH_CELLS, PATCH_TRIANGLE_COUNT, PATCH_VERTEX_COUNT } from '../src/quadtree.ts'

/** Есть ли накрывающий лист для точки (XZ, без высоты — консервативно)? */
function covered(sel: { leafCount: number; instanceData: Float32Array }, x: number, z: number): boolean {
  for (let i = 0; i < sel.leafCount; i++) {
    const ox = sel.instanceData[i * 4]!
    const oz = sel.instanceData[i * 4 + 1]!
    const size = sel.instanceData[i * 4 + 2]!
    if (x >= ox && x < ox + size && z >= oz && z < oz + size) return true
  }
  return false
}

describe('prims — terrain на кваддреве (Task 115)', () => {
  test('покрытие без дыр: точки диска камера±horizon накрыты листами', () => {
    const t = createTerrainQuadtree({ horizon: 3000, rootSize: 512 })
    const sel = t.select(0, 100, 0)
    expect(sel.leafCount).toBeGreaterThan(0)
    // Равномерная сетка точек внутри радиуса (углы диска — самые рискованные).
    for (let r = 0; r < 6; r++) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2
        const x = Math.cos(ang) * (r / 6) * 2900
        const z = Math.sin(ang) * (r / 6) * 2900
        expect(covered(sel, x, z)).toBe(true)
      }
    }
  })

  test('фикс-сетка мира: истоки листьев выровнены по сетке (вершины не плывут)', () => {
    const t = createTerrainQuadtree({ horizon: 2500, rootSize: 512 })
    const sel = t.select(100.37, 200.91, 0) // «плавающая» позиция камеры
    expect(sel.leafCount).toBeGreaterThan(0)
    for (let i = 0; i < sel.leafCount; i++) {
      const ox = sel.instanceData[i * 4]!
      const oz = sel.instanceData[i * 4 + 1]!
      const size = sel.instanceData[i * 4 + 2]!
      // Исток — всегда кратен размеру листа: мировая сетка ФИКСИРОВАНА,
      // при движении камеры меняется только НАБОР листьев, не их решётка
      // (вершины не «плывут» — главный инвариант против шиммера).
      expect(Math.abs(ox / size - Math.round(ox / size))).toBeLessThan(1e-9)
      expect(Math.abs(oz / size - Math.round(oz / size))).toBeLessThan(1e-9)
      expect(Math.abs(Math.log2(size) - Math.round(Math.log2(size)))).toBeLessThan(1e-9)
    }
    // LOD-стабильность: малый сдвиг камеры меняет набор МАЛО (гистерезис
    // не нужен — границы дробления редки; >70% листьев совпадает).
    const a = t.select(100, 200, 0)
    const b = t.select(110, 200, 0)
    const key = (s: { leafCount: number; instanceData: Float32Array }): Set<string> => {
      const out = new Set<string>()
      for (let i = 0; i < s.leafCount; i++) {
        out.add(`${s.instanceData[i * 4]!},${s.instanceData[i * 4 + 1]!},${s.instanceData[i * 4 + 2]!}`)
      }
      return out
    }
    const ka = key(a)
    const kb = key(b)
    let same = 0
    for (const k of ka) if (kb.has(k)) same++
    expect(same / Math.max(ka.size, kb.size)).toBeGreaterThan(0.7)
  })

  test('ноль больших аллокаций: результат лёгкий, буфер инстансов ОБЩИЙ', () => {
    const t = createTerrainQuadtree({})
    const a = t.select(0, 100, 0)
    const b = t.select(5000, 100, -3000)
    // Буфер инстансов — один и тот же (пре-аллоцирован; содержимое
    // перезаливается на каждый вызов — БЕЗ аллокаций TypedArray).
    expect(b.instanceData).toBe(a.instanceData)
    // Результат-объект свежий на вызов: две выборки живут независимо
    // (урок: синглтон алиасил — сравнение выборок молча врало).
    expect(b).not.toBe(a)
    expect(a.leafCount).toBeGreaterThan(0)
    expect(b.leafCount).toBeGreaterThan(0)
  })

  test('лимит ближней детализации: minLeafSize — жёсткий потолок', () => {
    for (const a of [1, 2, 3]) {
      const t = createTerrainQuadtree({ aggressiveness: a, rootSize: 4096 })
      const sel = t.select(0, 100, 0)
      expect(sel.minLeafSize).toBeGreaterThanOrEqual(t.lod.minLeafSize)
      expect(sel.lod.maxDepth).toBe(t.lod.maxDepth)
    }
  })

  test('LOD-агрессивность монотонна: больше A ⇒ меньше листьев и трис', () => {
    const s1 = createTerrainQuadtree({ aggressiveness: 1 }).select(0, 100, 0)
    const s3 = createTerrainQuadtree({ aggressiveness: 3 }).select(0, 100, 0)
    expect(s1.leafCount).toBeGreaterThan(s3.leafCount)
    expect(s1.triangles).toBeGreaterThan(s3.triangles)
  })

  test('отсечение по взгляду: forward-сектор режет дальнее кольцо', () => {
    const t = createTerrainQuadtree({ horizon: 4000 })
    const all = t.select(0, 100, 0) // без forward — всё вокруг
    const fwd = t.select(0, 100, 0, 1, 0) // смотрим строго в +X
    expect(fwd.leafCount).toBeLessThan(all.leafCount)
    expect(fwd.leafCount).toBeGreaterThan(0)
  })

  test('патч-юбка: skirt-вершины побитово повторяют (x,z) кромки', () => {
    const t = createTerrainQuadtree({})
    const { vertices, triangleIndices, edgeIndices, segments } = t.patch
    expect(segments).toBe(PATCH_CELLS)
    expect(vertices.length).toBe(PATCH_VERTEX_COUNT * 3)
    expect(triangleIndices.length).toBe(PATCH_TRIANGLE_COUNT * 3)
    const side = segments + 3
    // Для каждой skirt-вершины (skirt=1) есть интерьерная с теми же (x,z).
    let skirtCount = 0
    for (let i = 0; i < vertices.length / 3; i++) {
      if (vertices[i * 3 + 2] !== 1) continue
      skirtCount++
      let has = false
      for (let j = 0; j < vertices.length / 3 && !has; j++) {
        if (vertices[j * 3 + 2] !== 0) continue
        if (vertices[j * 3] === vertices[i * 3] && vertices[j * 3 + 1] === vertices[i * 3 + 1]) has = true
      }
      expect(has).toBe(true)
    }
    expect(skirtCount).toBe(side * side - (segments + 1) * (segments + 1))
    // Каркас — только интерьер (юбку не рисуем).
    expect(edgeIndices.length).toBeGreaterThan(0)
  })

  test('CPU-высота: heightAt = heightFn; без heightFn — NaN', () => {
    const fn = (x: number, z: number): number => x + z * 2
    const t = createTerrainQuadtree({ heightFn: fn })
    expect(t.heightAt(3, 4)).toBe(11)
    const bare = createTerrainQuadtree({})
    expect(Number.isNaN(bare.heightAt(0, 0))).toBe(true)
  })

  test('юбка: формула океаны ограничена [8, 300] и растёт с детализацией', () => {
    const t = createTerrainQuadtree({})
    expect(t.skirtDepthFor(4096)).toBe(8)
    expect(t.skirtDepthFor(16)).toBe(300)
    expect(t.skirtDepthFor(256)).toBeGreaterThan(t.skirtDepthFor(1024))
  })

  test('selectView: forward из view-матрицы (колоночно-мажорной)', () => {
    const t = createTerrainQuadtree({ horizon: 4000 })
    const view = new Float32Array(16)
    view[0] = view[5] = view[10] = view[15] = 1
    // Взгляд в +X: view[2] = −1 (rot[0][2]) → forward = (1, 0).
    view[2] = -1
    view[10] = 0
    const sel = t.selectView(0, 100, 0, view)
    expect(sel.leafCount).toBeGreaterThan(0)
  })

  test('пресеты рельефа: непрерывные heightFn + разумные амплитуды', () => {
    for (const preset of terrainQuadtreePresets) {
      expect(typeof preset.heightFn(0, 0)).toBe('number')
      expect(Number.isFinite(preset.heightFn(123.4, -567.8))).toBe(true)
      // Непрерывность: близкие точки — близкие высоты.
      const h1 = preset.heightFn(1000, 1000)
      const h2 = preset.heightFn(1001, 1000)
      expect(Math.abs(h1 - h2)).toBeLessThan(preset.amplitude * 0.2 + 5)
      expect(preset.amplitude).toBeGreaterThan(0)
    }
  })

  test('треугольники на лист = патч с юбкой (одна draw-команда)', () => {
    const t = createTerrainQuadtree({})
    const sel = t.select(0, 100, 0)
    expect(sel.triangles).toBe(sel.leafCount * t.trianglesPerLeaf)
    expect(t.trianglesPerLeaf).toBe(PATCH_TRIANGLE_COUNT)
  })

  test('параметры валидируются: rootSize ≤ 0 — громкий throw', () => {
    expect(() => createTerrainQuadtree({ rootSize: 0 })).toThrow()
    expect(() => createTerrainQuadtree({ rootSize: -8 })).toThrow()
  })

  test('селектор листьев напрямую: горизонта-диск + лимит ёмкости', () => {
    const sel = selectQuadtreeLeaves(0, 0, 100, { horizon: 2000, maxInstances: 64 })
    expect(sel.leafCount).toBeLessThanOrEqual(64)
    expect(sel.leafCount).toBeGreaterThan(0)
    // Ёмкость выросла лениво — и результат согласован.
    const big = selectQuadtreeLeaves(0, 0, 100, { horizon: 10000, maxInstances: 2048 })
    expect(big.leafCount).toBeGreaterThan(sel.leafCount)
  })
})
