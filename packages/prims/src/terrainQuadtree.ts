/**
 * terrainQuadtree.ts — примитив terrain «до горизонта» на кваддреве (Task 115).
 *
 * СИСТЕМА, ВАЛИДИРОВАННАЯ ОКЕАНОМ (Task 113): мировая фикс-сетка корней
 * (вершины не плывут при движении камеры), дробление по 3D-дистанции с
 * жёстким лимитом глубины, юбки против T-трещин, инстансированный патч
 * (одна draw-команда), ноль аллокаций на кадр. Здесь она обёрнута в
 * примитив рельефа: CPU-функция высоты (камера/коллизии) + пресеты.
 *
 * GPU-дисплейс: патч (x, z, skirt) инстансится листами; вершины сэмплируют
 * карту высот в шейдере по МИРОВОЙ позиции (как океан — карту БПФ). Юбка
 * повторяет (x,z) кромки ⇒ побитово та же высота ⇒ шов невидим.
 *
 * КОНТРАСТ с adaptive.ts: та — CPU-пересборка буферов вокруг камеры
 * (кольца LOD, ~десятки тысяч вершин, rebuild при движении); эта —
 * статичный патч + инстансы (пересборки НЕТ, меняется только набор листьев).
 */

import { fbm2D, ridged2D } from './noise.ts'
import type { WorldHeightFn } from './adaptive.ts'
import {
  HORIZON_DISTANCE,
  MAX_INSTANCES,
  PATCH_CELLS,
  PATCH_TRIANGLE_COUNT,
  ROOT_SIZE,
  lodParams,
  quadtreePatch,
  selectQuadtreeLeaves,
  skirtDepthFor,
  viewForwardXZ,
} from './quadtree.ts'
import type { LodParams, QuadtreePatch, QuadtreeLeavesSelection } from './quadtree.ts'

export interface TerrainQuadtreeParams {
  /** Рельеф в МИРОВЫХ координатах (непрерывен на всей плоскости).
   *  Не обязателен, если дисплейс целиком на GPU (карта высот в шейдере):
   *  тогда heightAt() вернёт NaN — используйте только select(). */
  readonly heightFn?: WorldHeightFn
  /** Амплитуда высоты (для юбок и пресетов; default 30). */
  readonly amplitude?: number
  /** Корневой тайл фикс-сетки мира, м — степень двойки (default 4096). */
  readonly rootSize?: number
  /** Радиус покрытия от камеры, м (default 10000 — «до горизонта»). */
  readonly horizon?: number
  /** LOD-агрессивность 1..3 (default 2 — «агрессивно изначально»:
   *  больше ⇒ крупнее листья ⇒ меньше треугольников). */
  readonly aggressiveness?: number
  /** Потолок листьев — ёмкость инстанс-буфера (default 2048). */
  readonly maxInstances?: number
  /** Ячеек патча в стороне (default 32; вершин (N+3)² с юбкой). */
  readonly segments?: number
  /** Глубина юбки: число или функция от размера листа, м.
   *  Default — формула океана: clamp(12·period/leaf, 8, 300), где period =
   *  период карты высот (для бесшовного CPU-рельефа передайте amplitude·2). */
  readonly skirtDepth?: number | ((leafSize: number) => number)
}

export interface TerrainQuadtree {
  /** Листья на кадр (СИНГЛТОН — ноль аллокаций; instanceData стриде 4:
   *  originX, originZ, size, —). */
  select(camX: number, camY: number, camZ: number, forwardX?: number, forwardZ?: number): QuadtreeLeavesSelection
  /** Листья по view-матрице (колоночно-мажорной) — forward извлекается сам. */
  selectView(camX: number, camY: number, camZ: number, view: Float32Array): QuadtreeLeavesSelection
  /** CPU-высота рельефа (камера/коллизии); NaN если heightFn не задан. */
  heightAt(x: number, z: number): number
  /** Глубина юбки для листа, м. */
  skirtDepthFor(leafSize: number): number
  /** Статичный патч-грид с юбкой (загрузить в вершинный буфер ОДИН раз). */
  readonly patch: QuadtreePatch
  readonly lod: LodParams
  /** Треугольников на лист (патч с юбкой). */
  readonly trianglesPerLeaf: number
  readonly rootSize: number
  readonly horizon: number
}

export function createTerrainQuadtree(params: TerrainQuadtreeParams = {}): TerrainQuadtree {
  const rootSize = params.rootSize ?? ROOT_SIZE
  if (!Number.isFinite(rootSize) || rootSize <= 0) {
    throw new Error(`terrainQuadtree: rootSize должен быть > 0, получено ${rootSize}`)
  }
  const amplitude = params.amplitude ?? 30
  const heightFn = params.heightFn
  const segments = params.segments ?? PATCH_CELLS
  const patch = quadtreePatch(segments)
  const lod = lodParams(params.aggressiveness ?? 2)
  const skirt =
    params.skirtDepth ??
    ((leafSize: number) => skirtDepthFor(leafSize, Math.max(rootSize / 16, amplitude * 16)))

  const opts = {
    aggressiveness: params.aggressiveness ?? 2,
    rootSize,
    horizon: params.horizon ?? HORIZON_DISTANCE,
    maxInstances: params.maxInstances ?? MAX_INSTANCES,
  }

  return {
    select(camX: number, camY: number, camZ: number, forwardX = 0, forwardZ = 0): QuadtreeLeavesSelection {
      const fwd = { x: forwardX, z: forwardZ }
      return selectQuadtreeLeaves(camX, camZ, camY, { ...opts, forward: fwd })
    },
    selectView(camX: number, camY: number, camZ: number, view: Float32Array): QuadtreeLeavesSelection {
      const f = viewForwardXZ(view)
      return selectQuadtreeLeaves(camX, camZ, camY, { ...opts, forward: f })
    },
    heightAt(x: number, z: number): number {
      return heightFn !== undefined ? heightFn(x, z) : Number.NaN
    },
    skirtDepthFor(leafSize: number): number {
      return typeof skirt === 'number' ? skirt : skirt(leafSize)
    },
    patch,
    lod,
    trianglesPerLeaf: PATCH_TRIANGLE_COUNT,
    rootSize,
    horizon: opts.horizon,
  }
}

// ─── Пресеты рельефа (мировые координаты, непрерывные) ────────────────────────

export interface TerrainQuadtreePreset {
  readonly id: string
  readonly label: string
  readonly note: string
  readonly heightFn: WorldHeightFn
  readonly amplitude: number
}

/** Холмы: мягкий fBm. */
export function terrainHills(seed = 7): WorldHeightFn {
  return (x, z) => fbm2D(x / 900, z / 900, seed, 5) * 34
}

/** Хребты: остроконечный ridged fBm. */
export function terrainRidges(seed = 11): WorldHeightFn {
  return (x, z) => ridged2D(x / 1100, z / 1100, seed, 5) * 90
}

/** Дюны: анизотропные |sin|-гряды + лёгкий шум. */
export function terrainDunes(seed = 5): WorldHeightFn {
  return (x, z) => (Math.abs(Math.sin(x / 260 + fbm2D(x / 2000, z / 2000, seed, 2) * 2)) * 14 + fbm2D(x / 700, z / 700, seed + 1, 3) * 5)
}

/** Каньон: террасы с обрывами. */
export function terrainCanyon(seed = 9): WorldHeightFn {
  const terrace = (v: number): number => Math.round(v * 6) / 6
  return (x, z) => terrace(fbm2D(x / 1500, z / 1500, seed, 4)) * 120 + fbm2D(x / 300, z / 300, seed + 2, 3) * 6
}

export const terrainQuadtreePresets: readonly TerrainQuadtreePreset[] = [
  { id: 'hills', label: 'Холмы', note: 'fBm 5 октав, амплитуда 34 м', heightFn: terrainHills(), amplitude: 34 },
  { id: 'ridges', label: 'Хребты', note: 'ridged fBm, амплитуда 90 м', heightFn: terrainRidges(), amplitude: 90 },
  { id: 'dunes', label: 'Дюны', note: 'анизотропные гряды, амплитуда 19 м', heightFn: terrainDunes(), amplitude: 19 },
  { id: 'canyon', label: 'Каньон', note: 'террасы с обрывами', heightFn: terrainCanyon(), amplitude: 126 },
]
