/**
 * Террейны: сетка высот → triangle soup со сглаженными нормалями.
 *
 * КОНТРАКТЫ:
 *   • height(x, z) — функция высоты в НОРМАЛИЗОВАННЫХ координатах x, z ∈
 *     [-1, 1] (масштаб-независимый рельеф; сама сетка — size × size единиц);
 *   • нормали — ЦЕНТРАЛЬНЫЕ РАЗНОСТИ функции высоты (шаг = ячейка сетки):
 *     точнее усреднения по граням, без «фасеточности» на гладком рельефе,
 *     C²-шейдинг при C²-функции (quintic-noise);
 *   • UV: u — по X, v — НОРМАЛИЗОВАННАЯ ВЫСОТА [0, 1] по фактическому
 *     min/max ПОЛЯ (два прохода): шейдер красит по высоте без знания об
 *     амплитуде (вода/песок/трава/скалы/снег);
 *   • детерминизм: одинаковый seed → побайтово одинаковая геометрия.
 *
 * ПРЕСЕТЫ РЕЛЬЕФА (см. terrainPresets): холмы (fBm), хребты (ridged),
 * остров (радиальный спад), дюны (анизотропные |sin|-гряды), каньон
 * (террасы с обрывами), вулкан (конус с кратером).
 */

import type { Geometry } from './types.ts'
import { fbm2D, ridged2D } from './noise.ts'

/** Функция рельефа: x, z ∈ [-1, 1] → высота (условные единицы). */
export type TerrainHeightFn = (x: number, z: number) => number

export interface TerrainOptions {
  /** Seed рельефа (пробрасывается в пресет-функцию; детерминизм). */
  readonly seed?: number
  /** Амплитуда высоты, единиц (default 1). */
  readonly amplitude?: number
}

/**
 * Сетка-террейн size × size, segments × segments ячеек (вершин сетки
 * (segments+1)²). Высота = height(x̂, ẑ)·amplitude, где x̂, ẑ ∈ [-1, 1].
 */
export function terrain(
  size: number,
  segments: number,
  height: TerrainHeightFn,
  options: TerrainOptions = {},
): Geometry {
  const amp = options.amplitude ?? 1
  const cells = Math.max(1, Math.floor(segments))
  const vertsPerSide = cells + 1
  const n = vertsPerSide * vertsPerSide
  const half = size / 2
  const step = size / cells
  // Проход 1: сетка высот (нужна целиком — для нормалей по соседям и min/max)
  const heights = new Float32Array(n)
  for (let j = 0; j < vertsPerSide; j++) {
    for (let i = 0; i < vertsPerSide; i++) {
      const nx = (i / cells) * 2 - 1
      const nz = (j / cells) * 2 - 1
      heights[j * vertsPerSide + i] = height(nx, nz) * amp
    }
  }
  // min/max — ИЗ МАССИВА (Float32-значения): считая по double до записи,
  // получали hMin ≠ сохранённой высоте (0.3 double vs 0.30000001 f32) — и
  // «нормализованная высота» постоянного поля была 0.0119 вместо 0
  let hMin = Infinity
  let hMax = -Infinity
  for (let k = 0; k < n; k++) {
    const h = heights[k]!
    if (h < hMin) hMin = h
    if (h > hMax) hMax = h
  }
  const hSpan = Math.max(hMax - hMin, 1e-6)
  const at = (i: number, j: number): number =>
    heights[Math.min(Math.max(j, 0), cells) * vertsPerSide + Math.min(Math.max(i, 0), cells)]
  // Нормаль из разностей высоты: внутри — центральные (шаг 2·cell), на
  // границах — односторонние (шаг cell): иначе краевые нормали вдвое
  // «завалены» (полевой фидбек стиля «край склона тёмный»)
  const normalAt = (i: number, j: number, out: Float32Array, o: number): void => {
    const dhdx = i === 0
      ? (at(1, j) - at(0, j)) / step
      : i === cells
        ? (at(cells, j) - at(cells - 1, j)) / step
        : (at(i + 1, j) - at(i - 1, j)) / (2 * step)
    const dhdz = j === 0
      ? (at(i, 1) - at(i, 0)) / step
      : j === cells
        ? (at(i, cells) - at(i, cells - 1)) / step
        : (at(i, j + 1) - at(i, j - 1)) / (2 * step)
    // Нормаль поверхности y = h(x, z): (-∂h/∂x, 1, -∂h/∂z), нормированная
    let nx = -dhdx
    let ny = 1
    let nz = -dhdz
    const len = Math.hypot(nx, ny, nz)
    out[o] = nx / len
    out[o + 1] = ny / len
    out[o + 2] = nz / len
  }
  // Проход 2: ячейки → 2 треугольника. CCW при взгляде сверху: обход
  // (i,j) → (i,j+1) → (i+1,j+1) даёт cross(B−A, C−A) = (0, +step², 0) —
  // нормаль грани ВВЕРХ (+Y). Первая версия шла (i,j) → (i+1,j) → (i+1,j+1)
  // — cross = (0, −step², 0), рельеф был виден СНИЗУ (culled сверху)
  const quads = cells * cells
  const positions = new Float32Array(quads * 6 * 3)
  const normals = new Float32Array(quads * 6 * 3)
  const uvs = new Float32Array(quads * 6 * 2)
  let v = 0
  const emit = (i: number, j: number): void => {
    const x = -half + i * step
    const z = -half + j * step
    const h = at(i, j)
    positions[v * 3] = x
    positions[v * 3 + 1] = h
    positions[v * 3 + 2] = z
    normalAt(i, j, normals, v * 3)
    uvs[v * 2] = i / cells
    uvs[v * 2 + 1] = (h - hMin) / hSpan
    v++
  }
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      emit(i, j)
      emit(i, j + 1)
      emit(i + 1, j + 1)
      emit(i, j)
      emit(i + 1, j + 1)
      emit(i + 1, j)
    }
  }
  return { positions, normals, uvs, vertexCount: v }
}

// ─── Пресеты рельефа ─────────────────────────────────────────────────────────

/** Холмы: мягкий fBm — базовый «курганный» ландшафт. */
export function heightHills(seed = 7): TerrainHeightFn {
  return (x, z) => fbm2D(x * 3, z * 3, seed, 5) - 0.5
}

/** Хребты: ridged-мультимфрактал — острые горные гряды (Машук-стиль). */
export function heightRidged(seed = 11): TerrainHeightFn {
  return (x, z) => {
    const r = ridged2D(x * 2.2, z * 2.2, seed, 6, 1.4)
    return (r - 0.45) * 1.6
  }
}

/** Остров: холмы × радиальный спад (пляж по краю, горы в центре). */
export function heightIsland(seed = 3): TerrainHeightFn {
  return (x, z) => {
    const d = Math.hypot(x, z)
    const falloff = 1 - Math.min(1, Math.pow(d, 2.2)) // плоские берега, резче центр
    const hills = fbm2D(x * 2.5, z * 2.5, seed, 5)
    return (hills * 1.2 - 0.25) * falloff - (1 - falloff) * 0.15 // океан чуть ниже
  }
}

/** Дюны: анизотропные |sin|-гряды, искривлённые шумом (ветровые пески). */
export function heightDunes(seed = 5): TerrainHeightFn {
  return (x, z) => {
    const warp = fbm2D(x * 2, z * 2, seed, 3) * 0.8
    const ridge = Math.abs(Math.sin((x * 4 + warp * 2.5 + z * 0.6) * Math.PI))
    const soft = fbm2D(x * 5, z * 5, seed + 91, 2) * 0.25
    return (ridge * 0.9 + soft - 0.45)
  }
}

/** Каньон: террасы-ступени fBm (квантование высоты) — столовые плато. */
export function heightCanyon(seed = 9): TerrainHeightFn {
  return (x, z) => {
    const base = fbm2D(x * 2, z * 2, seed, 4)
    const steps = 6
    const q = Math.floor(base * steps) / steps
    const cliff = base - q // доля внутри ступени
    // Ступень плоская, обрыв резкий: ближе к концу ступени — быстрый подъём
    const terrace = q + Math.pow(cliff * steps, 4) / steps
    return (terrace - 0.45) * 1.3
  }
}

/** Вулкан: конус с кратером (радиальный профиль + шумовой рельеф обода). */
export function heightVolcano(seed = 13): TerrainHeightFn {
  return (x, z) => {
    const d = Math.hypot(x, z)
    const rim = 0.55
    const rough = fbm2D(x * 4, z * 4, seed, 4) * 0.18
    // Конус от подножия к ободу, затем провал в кратер
    let profile: number
    if (d >= rim) {
      profile = Math.max(0, 1 - (d - rim) / (1 - rim)) // склон вниз от обода
    } else {
      profile = 1 - Math.pow(1 - d / rim, 1.6) * 0.8 // чаша: центр ниже обода
    }
    return profile * 0.9 + rough - 0.12
  }
}

export interface TerrainPreset {
  readonly label: string
  readonly height: (seed?: number) => TerrainHeightFn
  /** Рекомендованная амплитуда (рельефы разного масштаба). */
  readonly amplitude: number
  readonly note: string
}

/** Именованные рельефы для UI (демо-селектор «террейны»). */
export const terrainPresets: Readonly<Record<string, TerrainPreset>> = {
  hills: { label: 'Холмы', height: heightHills, amplitude: 1, note: 'fBm value-noise: мягкие курганы, 5 октав' },
  ridged: { label: 'Хребты', height: heightRidged, amplitude: 1, note: 'ridged-мультимфрактал: острые гряды 1−|2n−1|' },
  island: { label: 'Остров', height: heightIsland, amplitude: 1.4, note: 'холмы × радиальный спад: пляж → горы' },
  dunes: { label: 'Дюны', height: heightDunes, amplitude: 0.8, note: 'анизотропные |sin|-гряды, искривлённые шумом' },
  canyon: { label: 'Каньон', height: heightCanyon, amplitude: 1.2, note: 'террасы-ступени fBm: столовые плато' },
  volcano: { label: 'Вулкан', height: heightVolcano, amplitude: 1.5, note: 'конус с кратером + шумовой обод' },
}

// ─── Обёртки-удобства (одна строка — готовая геометрия) ─────────────────────

export function terrainHills(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightHills(options.seed), { ...options, amplitude: options.amplitude ?? 1 })
}
export function terrainRidged(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightRidged(options.seed), { ...options, amplitude: options.amplitude ?? 1 })
}
export function terrainIsland(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightIsland(options.seed), { ...options, amplitude: options.amplitude ?? 1.4 })
}
export function terrainDunes(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightDunes(options.seed), { ...options, amplitude: options.amplitude ?? 0.8 })
}
export function terrainCanyon(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightCanyon(options.seed), { ...options, amplitude: options.amplitude ?? 1.2 })
}
export function terrainVolcano(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightVolcano(options.seed), { ...options, amplitude: options.amplitude ?? 1.5 })
}
