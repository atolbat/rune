/**
 * Реестр примитивов (Task 109): единый каталог @rune/prims — метаданные
 * параметров (UI строит слайдеры САМ по этой таблице) + генератор от
 * значений и множителя детализации. Единая точка правды для демо и
 * тестов: инварианты (winding/нормали/счёты) прогоняются ПО КАТАЛОГУ.
 *
 * Параметры бывают:
 *   • числовые — слайдер min..max..step;
 *   • segment (integer) — сегментация: множится детализацией k
 *     (×0.5 Эконом … ×4 Ультра) с зажимом в [min, max];
 *   • bool — тумблер (openEnded у цилиндра/конуса).
 */

import type { Geometry } from './types.ts'
import { box } from './cube.ts'
import { plane } from './plane.ts'
import { sphere } from './sphere.ts'
import { cylinder, cone } from './cylinder.ts'
import { capsule } from './capsule.ts'
import { torus, torusKnot } from './torus.ts'
import { disk, ring } from './disk.ts'
import { tetrahedron, octahedron, icosahedron, dodecahedron } from './platonic.ts'
import { terrain, terrainPresets } from './terrain.ts'
import { createAdaptiveTerrain, adaptivePresets } from './adaptive.ts'
import type { AdaptiveTerrainParams, WorldHeightFn } from './adaptive.ts'
import type { TerrainHeightFn } from './terrain.ts'

export interface ParamMeta {
  readonly key: string
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step: number
  readonly def: number
  /** Сегментный параметр: integer + множится детализацией k. */
  readonly segment?: boolean
  /** Целочисленный (без множителя детализации). */
  readonly integer?: boolean
  /** Булев тумблер (min/max/step не используются). */
  readonly bool?: boolean
}

export interface ShapeMeta {
  readonly id: string
  readonly label: string
  readonly group: string
  readonly note: string
  /** Сдвиг модели по Y (камера смотрит сюда). */
  readonly offsetY?: number
  /** Дистанция камеры по умолчанию. */
  readonly dist?: number
  readonly params: readonly ParamMeta[]
  /** Геометрия от значений параметров и множителя детализации k. */
  readonly make: (values: Record<string, number>, k: number) => Geometry
  /** Для адаптивных фигур: конфиг живого фида (демо). */
  readonly adaptive?: (values: Record<string, number>) => AdaptiveTerrainParams
}

/** Значение сегментного параметра с учётом детализации: base·k, зажим. */
export function segmentValue(base: number, k: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(base * k)))
}

const TERRAIN_SIZE = 2.4

function terrainEntry(
  id: string, presetKey: string, note: string,
): ShapeMeta {
  const preset = terrainPresets[presetKey]!
  return {
    id, label: preset.label, group: 'Террейны', note, offsetY: -0.25, dist: 3.4,
    params: [
      { key: 'seed', label: 'Seed рельефа', min: 1, max: 999, step: 1, def: 7, integer: true },
      { key: 'amp', label: 'Амплитуда', min: 0.4, max: 2.5, step: 0.1, def: preset.amplitude },
      { key: 'segs', label: 'Сегментов', min: 16, max: 256, step: 8, def: 96, segment: true },
    ],
    make: (v, k) => terrain(
      TERRAIN_SIZE,
      v.segs ?? 96,
      preset.height(v.seed ?? 7) as TerrainHeightFn,
      { amplitude: v.amp ?? preset.amplitude },
    ),
  }
}

function adaptiveEntry(
  id: string, presetKey: string, note: string,
): ShapeMeta {
  const preset = adaptivePresets[presetKey]!
  return {
    id, label: preset.label, group: 'Адаптивный рельеф', note, offsetY: -0.2, dist: 7.5,
    params: [
      { key: 'seed', label: 'Seed рельефа', min: 1, max: 999, step: 1, def: 7, integer: true },
      { key: 'amp', label: 'Амплитуда', min: 0.3, max: 2.5, step: 0.1, def: preset.amplitude },
      { key: 'radius', label: 'Радиус построения', min: 8, max: 48, step: 4, def: 20, integer: true },
      { key: 'tile', label: 'Размер тайла', min: 2, max: 8, step: 1, def: 4, integer: true },
      { key: 'maxSeg', label: 'Макс. сегментов', min: 8, max: 64, step: 8, def: 24, segment: true },
      { key: 'skirt', label: 'Юбки на стыках', min: 0, max: 1, step: 1, def: 1, bool: true },
    ],
    make: (v, k) => {
      void k
      return createAdaptiveTerrain({
        heightFn: preset.height(v.seed ?? 7),
        amplitude: v.amp ?? preset.amplitude,
        radius: v.radius ?? 20,
        tileSize: v.tile ?? 4,
        maxSegments: v.maxSeg ?? 24,
        skirtDepth: (v.skirt ?? 1) > 0.5 ? 0.4 : 0,
      }).geometry
    },
    adaptive: v => ({
      heightFn: preset.height(v.seed ?? 7) as WorldHeightFn,
      amplitude: v.amp ?? preset.amplitude,
      radius: v.radius ?? 20,
      tileSize: v.tile ?? 4,
      maxSegments: v.maxSeg ?? 24,
      skirtDepth: (v.skirt ?? 1) > 0.5 ? 0.4 : 0,
    }),
  }
}

/** Каталог примитивов (до обёртки детализации). */
const RAW_SHAPES: readonly ShapeMeta[] = [
  {
    id: 'box', label: 'Бокс', group: 'Базовые',
    note: 'width×height×depth, СЕГМЕНТЫ НА КАЖДУЮ ГРАНЬ (как BoxGeometry three.js)',
    params: [
      { key: 'width', label: 'Ширина X', min: 0.4, max: 2.5, step: 0.05, def: 1.4 },
      { key: 'height', label: 'Высота Y', min: 0.4, max: 2.5, step: 0.05, def: 1.4 },
      { key: 'depth', label: 'Глубина Z', min: 0.4, max: 2.5, step: 0.05, def: 1.4 },
      { key: 'segX', label: 'Сегментов X', min: 1, max: 24, step: 1, def: 6, segment: true },
      { key: 'segY', label: 'Сегментов Y', min: 1, max: 24, step: 1, def: 6, segment: true },
      { key: 'segZ', label: 'Сегментов Z', min: 1, max: 24, step: 1, def: 6, segment: true },
    ],
    make: v => box({
      width: v.width, height: v.height, depth: v.depth,
      widthSegments: v.segX, heightSegments: v.segY, depthSegments: v.segZ,
    }),
  },
  {
    id: 'plane', label: 'Плоскость', group: 'Базовые',
    note: 'Прямоугольник width×height с НЕЗАВИСИМЫМИ сегментами по осям, нормаль +Y',
    params: [
      { key: 'width', label: 'Ширина X', min: 0.5, max: 4, step: 0.1, def: 2.2 },
      { key: 'height', label: 'Глубина Z', min: 0.5, max: 4, step: 0.1, def: 1.6 },
      { key: 'segX', label: 'Сегментов X', min: 1, max: 96, step: 1, def: 24, segment: true },
      { key: 'segY', label: 'Сегментов Z', min: 1, max: 96, step: 1, def: 16, segment: true },
    ],
    make: v => plane({
      width: v.width, height: v.height,
      widthSegments: v.segX, heightSegments: v.segY,
    }),
  },
  {
    id: 'sphere', label: 'Сфера', group: 'Базовые',
    note: 'UV-сфера: widthSegments × heightSegments (как SphereGeometry), полюса без дыр',
    params: [
      { key: 'radius', label: 'Радиус', min: 0.5, max: 2, step: 0.05, def: 1 },
      { key: 'segW', label: 'Сегментов (долгота)', min: 8, max: 256, step: 4, def: 48, segment: true },
      { key: 'segH', label: 'Поясов (широта)', min: 4, max: 128, step: 2, def: 32, segment: true },
    ],
    make: v => sphere({
      radius: v.radius,
      widthSegments: v.segW,
      heightSegments: v.segH,
    }),
  },
  {
    id: 'cylinder', label: 'Цилиндр', group: 'Базовые',
    note: 'Усечённый конус с крышками; rTop=0 — конус; openEnded — без крышек',
    params: [
      { key: 'rTop', label: 'Радиус верха', min: 0, max: 1.2, step: 0.05, def: 0.7 },
      { key: 'rBot', label: 'Радиус низа', min: 0.3, max: 1.2, step: 0.05, def: 0.9 },
      { key: 'height', label: 'Высота', min: 0.6, max: 2.6, step: 0.1, def: 1.8 },
      { key: 'segR', label: 'Сегментов (вокруг)', min: 3, max: 256, step: 1, def: 48, segment: true },
      { key: 'segH', label: 'Поясов (высота)', min: 1, max: 32, step: 1, def: 1, segment: true },
      { key: 'open', label: 'Без крышек (openEnded)', min: 0, max: 1, step: 1, def: 0, bool: true },
    ],
    make: v => cylinder({
      radiusTop: v.rTop, radiusBottom: v.rBot, height: v.height,
      radialSegments: v.segR, heightSegments: v.segH,
      openEnded: (v.open ?? 0) > 0.5,
    }),
  },
  {
    id: 'cone', label: 'Конус', group: 'Базовые',
    note: 'Апекс без вырожденных треугольников; openEnded — без основания',
    params: [
      { key: 'radius', label: 'Радиус', min: 0.4, max: 1.2, step: 0.05, def: 0.9 },
      { key: 'height', label: 'Высота', min: 0.8, max: 2.6, step: 0.1, def: 1.8 },
      { key: 'segR', label: 'Сегментов (вокруг)', min: 3, max: 256, step: 1, def: 48, segment: true },
      { key: 'segH', label: 'Поясов (высота)', min: 1, max: 32, step: 1, def: 1, segment: true },
      { key: 'open', label: 'Без основания', min: 0, max: 1, step: 1, def: 0, bool: true },
    ],
    make: v => cone({
      radius: v.radius, height: v.height,
      radialSegments: v.segR, heightSegments: v.segH,
      openEnded: (v.open ?? 0) > 0.5,
    }),
  },
  {
    id: 'capsule', label: 'Капсула', group: 'Базовые',
    note: 'Цилиндр + полусферы (height — цилиндрическая часть, как в three.js)',
    params: [
      { key: 'radius', label: 'Радиус', min: 0.25, max: 0.9, step: 0.05, def: 0.55 },
      { key: 'height', label: 'Длина тела', min: 0.4, max: 1.8, step: 0.05, def: 1.1 },
      { key: 'segR', label: 'Сегментов (вокруг)', min: 3, max: 128, step: 1, def: 40, segment: true },
      { key: 'segH', label: 'Поясов на полусферу', min: 2, max: 64, step: 1, def: 12, segment: true },
    ],
    make: v => capsule({
      radius: v.radius, height: v.height,
      radialSegments: v.segR, capSegments: v.segH,
    }),
  },
  {
    id: 'torus', label: 'Тор', group: 'Кривые',
    note: 'Трубка tube вокруг кольца radius; radial — вокруг трубки, tubular — вокруг оси',
    params: [
      { key: 'radius', label: 'Радиус кольца', min: 0.6, max: 1.5, step: 0.05, def: 1 },
      { key: 'tube', label: 'Радиус трубки', min: 0.12, max: 0.6, step: 0.02, def: 0.38 },
      { key: 'segR', label: 'Сегментов трубки', min: 3, max: 96, step: 1, def: 28, segment: true },
      { key: 'segT', label: 'Сегментов кольца', min: 8, max: 256, step: 4, def: 64, segment: true },
    ],
    make: v => torus({
      radius: v.radius, tube: v.tube,
      radialSegments: v.segR, tubularSegments: v.segT,
    }),
  },
  {
    id: 'knot', label: 'Узел (p,q)', group: 'Кривые',
    note: 'Тороидальный узел: p витков × q захлёстов; меняйте p/q — узел перестраивается',
    dist: 4.6,
    params: [
      { key: 'p', label: 'p (витки)', min: 1, max: 5, step: 1, def: 2, integer: true },
      { key: 'q', label: 'q (захлёсты)', min: 2, max: 7, step: 1, def: 3, integer: true },
      { key: 'tube', label: 'Радиус трубки', min: 0.08, max: 0.4, step: 0.02, def: 0.26 },
      { key: 'scale', label: 'Масштаб', min: 0.25, max: 0.8, step: 0.05, def: 0.45 },
      { key: 'segT', label: 'Сегментов кривой', min: 16, max: 640, step: 8, def: 220, segment: true },
      { key: 'segR', label: 'Сегментов трубки', min: 3, max: 32, step: 1, def: 14, segment: true },
    ],
    make: v => torusKnot({
      p: Math.round(v.p ?? 2), q: Math.round(v.q ?? 3),
      tube: v.tube, scale: v.scale,
      tubularSegments: v.segT, radialSegments: v.segR,
    }),
  },
  {
    id: 'tetra', label: 'Тетраэдр', group: 'Платоновы',
    note: '4 грани, плоское затенение; detail — сабдивизия с проекцией на сферу',
    params: [
      { key: 'radius', label: 'Радиус', min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'detail', label: 'Детализация (сабдивизия)', min: 0, max: 4, step: 1, def: 0, integer: true },
    ],
    make: v => tetrahedron({ radius: v.radius, detail: v.detail }),
  },
  {
    id: 'octa', label: 'Октаэдр', group: 'Платоновы',
    note: '8 граней; detail ≥ 1 — геодезическая сфера из октаэдра',
    params: [
      { key: 'radius', label: 'Радиус', min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'detail', label: 'Детализация (сабдивизия)', min: 0, max: 4, step: 1, def: 0, integer: true },
    ],
    make: v => octahedron({ radius: v.radius, detail: v.detail }),
  },
  {
    id: 'icosa', label: 'Икосаэдр', group: 'Платоновы',
    note: '20 граней; detail 1/2/3 — геодезические сферы 80/320/1280 граней',
    params: [
      { key: 'radius', label: 'Радиус', min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'detail', label: 'Детализация (сабдивизия)', min: 0, max: 4, step: 1, def: 0, integer: true },
    ],
    make: v => icosahedron({ radius: v.radius, detail: v.detail }),
  },
  {
    id: 'dodeca', label: 'Додекаэдр', group: 'Платоновы',
    note: '12 пятиугольных граней (двойственен икосаэдру); detail — сфера-додека',
    params: [
      { key: 'radius', label: 'Радиус', min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'detail', label: 'Детализация (сабдивизия)', min: 0, max: 3, step: 1, def: 0, integer: true },
    ],
    make: v => dodecahedron({ radius: v.radius, detail: v.detail }),
  },
  {
    id: 'disk', label: 'Диск', group: 'Прочие',
    note: 'Круг в плоскости XZ, нормаль +Y (CircleGeometry)',
    params: [
      { key: 'radius', label: 'Радиус', min: 0.5, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'segs', label: 'Сегментов', min: 3, max: 256, step: 1, def: 64, segment: true },
    ],
    make: v => disk({ radius: v.radius, segments: v.segs }),
  },
  {
    id: 'ring', label: 'Кольцо', group: 'Прочие',
    note: 'Annulus — плоская шайба (RingGeometry)',
    params: [
      { key: 'inner', label: 'Внутренний R', min: 0.2, max: 0.9, step: 0.05, def: 0.55 },
      { key: 'outer', label: 'Внешний R', min: 0.8, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'segs', label: 'Сегментов', min: 3, max: 256, step: 1, def: 64, segment: true },
    ],
    make: v => ring({ innerRadius: v.inner, outerRadius: v.outer, segments: v.segs }),
  },
  terrainEntry('t-hills', 'hills', 'Одна плоскость с heightmap (fBm): база адаптивного рельефа'),
  terrainEntry('t-ridged', 'ridged', 'Ridged-мультимфрактал: острые гряды'),
  terrainEntry('t-island', 'island', 'Холмы × радиальный спад: пляж → горы'),
  terrainEntry('t-dunes', 'dunes', 'Анизотропные |sin|-гряды, ветровые пески'),
  terrainEntry('t-canyon', 'canyon', 'Террасы-ступени: столовые плато'),
  terrainEntry('t-volcano', 'volcano', 'Конус с кратером + шумовой обод'),
  adaptiveEntry('a-hills', 'hills', 'Тайлы LOD вокруг камеры: ближние подробные, дальние грубые; юбки на стыках'),
  adaptiveEntry('a-ridged', 'ridged', 'Хребты кольцами LOD — острые гряды гаснут вдали'),
  adaptiveEntry('a-island', 'island', 'Остров в океане до тумана: видно, как даль глушится LOD-ом'),
  adaptiveEntry('a-dunes', 'dunes', 'Дюны: стыки тайлов держат юбки при дисплейсе'),
  adaptiveEntry('a-canyon', 'canyon', 'Каньон: плоские плато читаются на любом уровне LOD'),
]

/** Каталог примитивов для UI и тестов (после обёртки детализации). */
export const SHAPES: readonly ShapeMeta[] = RAW_SHAPES.map(withDetail)

/**
 * Обёртка ДЕТАЛИЗАЦИИ: сегментные параметры (segment: true) умножаются на k
 * с зажимом [min, max] ДО передачи в make — один механизм на весь каталог
 * (прежде каждый make должен был помнить о k — сфера ×2 молча игнорировала
 * множитель, поймано тестом «детализация меняет счёт»).
 */
function withDetail(shape: ShapeMeta): ShapeMeta {
  const segParams = shape.params.filter(p => p.segment === true)
  if (segParams.length === 0) return shape
  const baseMake = shape.make
  return {
    ...shape,
    make: (values, k) => {
      if (k === 1) return baseMake(values, k)
      const scaled = { ...values }
      for (const p of segParams) {
        scaled[p.key] = segmentValue(values[p.key] ?? p.def, k, p.min, p.max)
      }
      return baseMake(scaled, 1)
    },
  }
}

// ─── Поиск и дефолты ─────────────────────────────────────────────────────────

/** Найти фигуру по id (демо-хук). */
export function shapeById(id: string): ShapeMeta | undefined {
  return SHAPES.find(s => s.id === id)
}

/** Дефолтные значения параметров фигуры. */
export function defaultValues(shape: ShapeMeta): Record<string, number> {
  const values: Record<string, number> = {}
  for (const p of shape.params) values[p.key] = p.def
  return values
}
