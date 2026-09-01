/**
 * Адаптивный тайловый рельеф (Task 109): плоскость, склеенная из ТАЙЛОВ
 * вокруг камеры — ближние кольца подробные, дальние грубые, общий радиус
 * построения до заданного (fog закрывает «условную бесконечность»).
 *
 * УМНАЯ СКЛЕЙКА (требование юзера: «вертексы совпадают и не формируют
 * обрезки в воздухе на границах тайлов при дисплейсе»):
 *   1. РАЗРЕШЕНИЯ — степени двойки: соседние тайлы ОДИНАКОВОГО уровня
 *      сэмплируют высоту в ОДИНАКОВЫХ мировых точках (решётка тайла
 *      snapped к решётке maxSegments) — общие ребра совпадают ВЕРШИНА В
 *      ВЕРШИНУ, шов невидим даже при дисплейсе (heightFn глобальная).
 *   2. Нормали — центральные разности heightFn с мировым шагом тайла:
 *      на общем ребре равноразрешённых тайлов формулы дают ИДЕНТИЧНЫЕ
 *      нормали (та же точка, тот же шаг) — шва освещения нет.
 *   3. РАЗНЫЕ уровни соседей (T-стык): грубое ребро — хорда, мелкое
 *      сэмплирует точнее → щели. Их закрывает ЮБКА (skirt) — стенка
 *      вниз от края тайла (индустриальный стандарт Cesium/гео-рендеров):
 *      при displace стенка следует за высотой края, «обрезков в воздухе»
 *      нет. Юбки можно выключить параметром — и УВИДЕТЬ разницу.
 *
 * Контракт GeometryFeed (feed.ts): update() возвращает true при
 * пересборке — демо перепушивает атрибуты команды (hot swap) и
 * динамический count. Пересборка квантована: не чаще движения камеры
 * на tileSize/2 (мура пересборок при орбите исключена).
 */

import type { Geometry } from './types.ts'
import { fbm2D, ridged2D } from './noise.ts'

/** Высота в МИРОВЫХ координатах (непрерывна на всей плоскости). */
export type WorldHeightFn = (x: number, z: number) => number

export interface AdaptiveTerrainParams {
  /** Рельеф в мировых координатах. */
  readonly heightFn: WorldHeightFn
  /** Амплитуда высоты (default 1). */
  readonly amplitude?: number
  /** Размер тайла в единицах мира (default 4). */
  readonly tileSize?: number
  /** Радиус построения от камеры (default 24; fog за ним — «бесконечность»). */
  readonly radius?: number
  /** Максимальное разрешение тайла — ячеек на сторону, степень двойки (default 32). */
  readonly maxSegments?: number
  /** Минимальное разрешение дальних тайлов (default 4). */
  readonly minSegments?: number
  /** Глубина юбки в единицах высоты (default 0.4); 0 — без юбок. */
  readonly skirtDepth?: number
  /** Агрессивность LOD: уровень +1 на каждые lodBias·tileSize дистанции (default 2.6). */
  readonly lodBias?: number
}

export interface AdaptiveTerrain {
  readonly geometry: Geometry
  /** true = геометрия пересобрана (камера ушла > tileSize/2). */
  update(camX: number, camZ: number): boolean
  readonly rebuilds: number
  readonly tiles: number
  readonly lastMs: number
  readonly center: { readonly x: number; readonly z: number }
  /** Сводка уровней: сколько тайлов на каждом (диагностика/лог). */
  readonly levelCounts: readonly number[]
}

interface TileDesc {
  /** Индексы решётки тайла. */
  readonly ix: number
  readonly iz: number
  /** Ячеек на сторону (степень двойки). */
  readonly res: number
}

/** Разрешение тайла по дистанции до камеры (степень двойки, ≥ min). */
function tileResolution(dist: number, p: Required<Pick<AdaptiveTerrainParams, 'maxSegments' | 'minSegments' | 'lodBias' | 'tileSize'>>): number {
  const { maxSegments, minSegments, lodBias, tileSize } = p
  // уровень 0 пока dist < lodBias·tileSize; дальше — удвоение дистанции
  const rel = Math.max(dist, 1e-6) / (lodBias * tileSize)
  const level = Math.max(0, Math.ceil(Math.log2(rel)))
  const res = Math.max(minSegments, maxSegments >> level)
  return Math.min(res, maxSegments)
}

export function createAdaptiveTerrain(params: AdaptiveTerrainParams): AdaptiveTerrain {
  const amplitude = params.amplitude ?? 1
  const tileSize = Math.max(0.5, params.tileSize ?? 4)
  const radius = Math.max(tileSize, params.radius ?? 24)
  const maxSegments = clampPow2(params.maxSegments ?? 32)
  const minSegments = clampPow2(Math.min(params.minSegments ?? 4, maxSegments))
  const skirtDepth = params.skirtDepth ?? 0.4
  const lodBias = params.lodBias ?? 2.6
  const heightFn = params.heightFn
  // Палитра (uv.y) — ФИКСИРОВАННЫЙ диапазон по амплитуде: стабильные цвета
  // между пересборками (локальный min/max «дышал» бы при движении)
  const hNorm = (h: number): number => {
    const t = (h / amplitude + 1) / 2 // h/amp ∈ [−1, 1] → [0, 1]
    return t < 0 ? 0 : t > 1 ? 1 : t
  }

  let geometry: Geometry
  let rebuilds = 1
  let tiles = 0
  let lastMs = 0
  let lastX = 0
  let lastZ = 0
  let levelCounts: number[] = []
  geometry = build(0, 0)
  tiles = countTiles()

  function clampPow2(v: number): number {
    const n = Math.max(2, Math.floor(v))
    let pow = 2
    while (pow < n) pow *= 2
    return pow
  }

  function tilesFor(camX: number, camZ: number): TileDesc[] {
    const span = Math.ceil(radius / tileSize)
    const cx = Math.round(camX / tileSize)
    const cz = Math.round(camZ / tileSize)
    const result: TileDesc[] = []
    for (let iz = cz - span; iz <= cz + span; iz++) {
      for (let ix = cx - span; ix <= cx + span; ix++) {
        const centerX = (ix + 0.5) * tileSize
        const centerZ = (iz + 0.5) * tileSize
        const dist = Math.hypot(centerX - camX, centerZ - camZ)
        if (dist > radius) continue
        result.push({ ix, iz, res: tileResolution(dist, { maxSegments, minSegments, lodBias, tileSize }) })
      }
    }
    return result
  }

  function countTiles(camX = 0, camZ = 0): number {
    return tilesFor(camX, camZ).length
  }

  function build(camX: number, camZ: number): Geometry {
    const t0 = performance.now()
    const tileList = tilesFor(camX, camZ)
    // Точный prealloc: сетка + юбки (по 4 стороны)
    let quadCount = 0
    for (const tile of tileList) {
      quadCount += tile.res * tile.res + (skirtDepth > 0 ? 4 * tile.res : 0)
    }
    const positions = new Float32Array(quadCount * 6 * 3)
    const normals = new Float32Array(quadCount * 6 * 3)
    const uvs = new Float32Array(quadCount * 6 * 2)
    const cursor = { v: 0 }
    levelCounts = []
    // Task 110: нормировка уровня LOD для uv.x (0 = макс. детализация,
    // 1 = minSegments). Шейдер океана красит тайлы по кольцам LOD —
    // адаптивность ВИДНА без каркаса.
    const maxLevel = Math.max(1, Math.log2(maxSegments / minSegments))
    for (const tile of tileList) {
      const level = Math.round(Math.log2(maxSegments / tile.res))
      while (levelCounts.length <= level) levelCounts.push(0)
      levelCounts[level] = (levelCounts[level] ?? 0) + 1
      emitTile(tile, positions, normals, uvs, cursor, level / maxLevel)
    }
    lastMs = performance.now() - t0
    tiles = tileList.length
    lastX = camX
    lastZ = camZ
    return { positions, normals, uvs, vertexCount: cursor.v }
  }

  /** Один тайл: сетка высот с апроном (±1 ячейка) → квады + юбки.
   *  Task 110: lodNorm — нормированный уровень тайла (uv.x; 0 = max detail)
   *  для LOD-раскраски колец в шейдере (палитра рельефа — uv.y, не задет). */
  function emitTile(
    tile: TileDesc,
    positions: Float32Array,
    normals: Float32Array,
    uvs: Float32Array,
    cursor: { v: number },
    lodNorm: number,
  ): void {
    const res = tile.res
    const step = tileSize / res
    const x0 = tile.ix * tileSize
    const z0 = tile.iz * tileSize
    // Высоты с апроном: (res+3)² — для центральных разностей на краях
    const dim = res + 3
    const heights = new Float32Array(dim * dim)
    for (let j = 0; j < dim; j++) {
      const wz = z0 + (j - 1) * step
      for (let i = 0; i < dim; i++) {
        const wx = x0 + (i - 1) * step
        heights[j * dim + i] = heightFn(wx, wz) * amplitude
      }
    }
    // Сетка (внутри апрона): индексы [1..res+1]
    const at = (i: number, j: number): number => heights[(j + 1) * dim + (i + 1)]
    const emit = (i: number, j: number, yOverride?: number, nOverride?: readonly [number, number, number]): void => {
      const v = cursor.v
      const h = yOverride ?? at(i, j)
      positions[v * 3] = x0 + i * step
      positions[v * 3 + 1] = h
      positions[v * 3 + 2] = z0 + j * step
      if (nOverride !== undefined) {
        normals[v * 3] = nOverride[0]
        normals[v * 3 + 1] = nOverride[1]
        normals[v * 3 + 2] = nOverride[2]
      } else {
        // Центральные разности по апрону (на краю тайла — тоже центральные:
        // соседний тайл того же разрешения считает ТАКУЮ ЖЕ нормаль)
        const dhdx = (at(i + 1, j) - at(i - 1, j)) / (2 * step)
        const dhdz = (at(i, j + 1) - at(i, j - 1)) / (2 * step)
        let nx = -dhdx
        const ny = 1
        let nz = -dhdz
        const len = Math.hypot(nx, ny, nz)
        nx /= len
        nz /= len
        normals[v * 3] = nx
        normals[v * 3 + 1] = ny / len
        normals[v * 3 + 2] = nz
      }
      uvs[v * 2] = lodNorm // Task 110: уровень LOD тайла (0 = max detail)
      uvs[v * 2 + 1] = hNorm(h)
      cursor.v = v + 1
    }
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        // CCW сверху (как plane/terrain)
        emit(i, j)
        emit(i, j + 1)
        emit(i + 1, j + 1)
        emit(i, j)
        emit(i + 1, j + 1)
        emit(i + 1, j)
      }
    }
    if (skirtDepth <= 0) return
    // Юбки: стенка вниз от каждого края. Нормаль — горизонтальная НАРУЖУ
    // от тайла (cull:back прячет встречную юбку соседа). Юбка ниже края на
    // skirtDepth·amplitude — при displace следует за краем, щель закрыта.
    // Winding: квады (A_k, A_{k+1}, B_{k+1}) + (A_k, B_{k+1}, B_k) — наружу
    // при обходе параметра к ВПРАВО от смотрящего СНАРУЖИ; стороны,
    // где параметр идёт влево, обходятся в обратном порядке (reverse)
    const drop = skirtDepth * amplitude
    const down = (i: number, j: number, n: readonly [number, number, number]): void => {
      emit(i, j, at(i, j) - drop, n)
    }
    /** Лента из res сегментов: A — край, B — юбка; reverse — наружная нормаль. */
    const skirt = (
      count: number,
      edgeA: (k: number) => void,
      edgeB: (k: number) => void,
      reverse: boolean,
    ): void => {
      for (let k = 0; k < count; k++) {
        const k0 = reverse ? k + 1 : k
        const k1 = reverse ? k : k + 1
        edgeA(k0)
        edgeA(k1)
        edgeB(k1)
        edgeA(k0)
        edgeB(k1)
        edgeB(k0)
      }
    }
    // Запад (i=0, наружу −X): снаружи параметр j идёт влево — reverse
    skirt(
      res,
      k => emit(0, k),
      k => down(0, k, [-1, 0, 0]),
      true,
    )
    // Восток (i=res, наружу +X): j вправо — прямой
    skirt(
      res,
      k => emit(res, k),
      k => down(res, k, [1, 0, 0]),
      false,
    )
    // Север (j=0, наружу −Z): i вправо — прямой
    skirt(
      res,
      k => emit(k, 0),
      k => down(k, 0, [0, 0, -1]),
      false,
    )
    // Юг (j=res, наружу +Z): i влево — reverse
    skirt(
      res,
      k => emit(k, res),
      k => down(k, res, [0, 0, 1]),
      true,
    )
  }

  return {
    get geometry(): Geometry {
      return geometry
    },
    update(camX: number, camZ: number): boolean {
      // Квантованный триггер: пересборка при уходе ≥ tileSize/2
      // (ровно на границе — тоже пора: «не чаще», а не «строго больше»)
      if (Math.hypot(camX - lastX, camZ - lastZ) < tileSize / 2) return false
      geometry = build(camX, camZ)
      rebuilds++
      return true
    },
    get rebuilds(): number {
      return rebuilds
    },
    get tiles(): number {
      return tiles
    },
    get lastMs(): number {
      return lastMs
    },
    get center(): { readonly x: number; readonly z: number } {
      return { x: lastX, z: lastZ }
    },
    get levelCounts(): readonly number[] {
      return levelCounts
    },
  }
}

// ─── Пресеты рельефа в МИРОВЫХ координатах ───────────────────────────────────

/** Холмы: мягкий fBm по мировым координатам (частота ~0.3/unit). */
export function worldHills(seed = 7): WorldHeightFn {
  return (x, z) => fbm2D(x * 0.3, z * 0.3, seed, 5) - 0.5
}

/** Хребты: острые гряды ridged-мультимфрактала. */
export function worldRidged(seed = 11): WorldHeightFn {
  return (x, z) => (ridged2D(x * 0.22, z * 0.22, seed, 6, 1.4) - 0.45) * 1.2
}

/** Дюны: анизотропные |sin|-гряды, искривлённые шумом. */
export function worldDunes(seed = 5): WorldHeightFn {
  return (x, z) => {
    const warp = fbm2D(x * 0.2, z * 0.2, seed, 3) * 0.8
    const ridge = Math.abs(Math.sin((x * 0.55 + warp * 1.8 + z * 0.18) * Math.PI))
    const soft = fbm2D(x * 0.6, z * 0.6, seed + 91, 2) * 0.25
    return ridge * 0.7 + soft - 0.35
  }
}

/** Каньон: террасы-ступени (столовые плато) по миру. */
export function worldCanyon(seed = 9): WorldHeightFn {
  return (x, z) => {
    const base = fbm2D(x * 0.18, z * 0.18, seed, 4)
    const steps = 6
    const q = Math.floor(base * steps) / steps
    const cliff = base - q
    const terrace = q + Math.pow(cliff * steps, 4) / steps
    return (terrace - 0.45) * 1.1
  }
}

/** Остров: холмы × радиальный спад вокруг (0, 0) — океан до горизонта. */
export function worldIsland(seed = 3): WorldHeightFn {
  return (x, z) => {
    const d = Math.hypot(x, z)
    const falloff = 1 - Math.min(1, Math.pow(d / 10, 2.2))
    const hills = fbm2D(x * 0.3, z * 0.3, seed, 5)
    return (hills * 1.2 - 0.25) * falloff - (1 - falloff) * 0.35
  }
}

export interface AdaptivePreset {
  readonly label: string
  readonly height: (seed?: number) => WorldHeightFn
  readonly amplitude: number
  readonly note: string
}

/** Именованные адаптивные рельефы для UI. */
export const adaptivePresets: Readonly<Record<string, AdaptivePreset>> = {
  hills: { label: 'Холмы', height: worldHills, amplitude: 1, note: 'fBm по миру: кольца LOD вокруг камеры, юбки на стыках' },
  ridged: { label: 'Хребты', height: worldRidged, amplitude: 1.1, note: 'ridged-гряды: острые вершины уходят в грубые дальние кольца' },
  island: { label: 'Остров', height: worldIsland, amplitude: 1.3, note: 'радиальный спад: океан до тумана — видно, как LOD глушит даль' },
  dunes: { label: 'Дюны', height: worldDunes, amplitude: 0.6, note: 'анизотропные гряды: юбки держат стыки при displace' },
  canyon: { label: 'Каньон', height: worldCanyon, amplitude: 1, note: 'террасы-ступени: плоские плато читаются на любом LOD' },
}
