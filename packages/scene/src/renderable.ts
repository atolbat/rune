/**
 * renderable.ts — Task 86: абстрактная сущность «ЧТО рисовать».
 *
 * «Инстанс-группа» (slot.group) — это ГРАНУЛЯРНОСТЬ КОМПАКЦИИ видимых
 * матриц, внутренняя деталь конвейера (один draw-instanced на пакет).
 * Пользователю сцены нужно другое: декларативное описание РЕНДЕРАБЛА —
 * «эти узлы рисуются ТАКИМ мешем, ТАКИМ материалом, в ТАКОМ пассе».
 *
 * Renderable — таблица таких описаний БЕЗ каких-либо GPU-знаний:
 *   • MeshRecipe — ленивый источник геометрии («приведение к мешу» —
 *     resolveMesh() вызывает загрузчик ОДИН раз и кэширует результат;
 *     рецепт может быть LOD-набором — конвенция на стороне резолвера);
 *   • MaterialRecipe — цвет/эмиссив/прозрачность как ДАННЫЕ (не состояние
 *     рендерера): презентационный слой печёт их в инстанс-стрим или
 *     юниформы — как сочтёт нужным;
 *   • RenderableDesc — связка (mesh, material, pass, policy, layer):
 *       pass   —Opaque небо-заливка НЕ рисуется как объект; 'opaque' |
 *               'mirror' | 'transparent' | 'overlay' (порядок пассов кадра);
 *       policy — 'instanced' (пакет узлов → один instanced draw) |
 *               'unique' (меш сам по себе: террейн, вода, зеркальный квад);
 *       layer  — стабильный биас сортировки внутри пасса (гарантированный
 *               порядок для равных глубин).
 *
 * Сценарии, которые покрывает ОДНА абстракция: лес/камни/здания
 * (instanced+opaque), кристаллы (instanced+transparent, сортировка
 * экземпляров), террейн (unique+opaque), вода (unique+transparent),
 * зеркало (unique+mirror), будущие LOD-наборы и импосторы (рецепт меша
 * решает, что вернуть по дистанции/размеру на экране).
 *
 * Реестр — мейн-тред метаданные (воркеру не нужны): SoA-буферы сцены
 * остаются единственным «транспортным контрактом» T0/T1/T2.
 */

/** Пасс кадра. Порядок = порядок композиции кадра презентационным слоем. */
export type RenderPassTag = 'opaque' | 'sky' | 'mirror' | 'transparent' | 'overlay'

/** Численный порядок пассов (сортировочный ключ, см. @rune/gl frameSort). */
export const RENDER_PASS_ORDER: Readonly<Record<RenderPassTag, number>> = {
  opaque: 0,
  sky: 1,
  mirror: 2,
  transparent: 3,
  overlay: 4,
}

/** Как пакет узлов рендерабла превращается в draw-вызовы. */
export type PackPolicy = 'instanced' | 'unique'

/** Ленивый источник геометрии. Загрузчик вызывается один раз. */
export interface MeshRecipe {
  readonly id: number
  /** Загружает геометрию (тип — на стороне презентации, сцена не знает). */
  readonly load: () => unknown
}

/** Материал как данные: параметры шейдера без состояния GPU. */
export interface MaterialRecipe {
  readonly id: number
  readonly base: readonly [number, number, number]
  /** Доля эмиссива (0 — чистое освещение, 1 — «само светится»). */
  readonly emissive: number
  /** Альфа: 1 — непрозрачный (пасс opaque), <1 — прозрачный. */
  readonly alpha: number
}

/** Декларация рендерабла — «что и как рисовать для пакета узлов». */
export interface RenderableDesc {
  readonly id: number
  readonly mesh: number
  readonly material: number
  readonly pass: RenderPassTag
  readonly policy: PackPolicy
  readonly layer: number
}

/** Разрешённый (кэшированный) рецепт меша. */
export interface ResolvedMesh {
  readonly meshId: number
  /** Результат load() — геометрия (типизация на стороне презентации). */
  readonly geometry: unknown
}

export interface RenderableRegistry {
  /** Зарегистрировать источник геометрии; возвращает id рецепта. */
  addMesh(load: () => unknown): number
  /** Зарегистрировать материал; возвращает id. */
  addMaterial(material: Omit<MaterialRecipe, 'id'>): number
  /** Зарегистрировать рендерабл. id назначается реестром (плотный). */
  add(desc: Omit<RenderableDesc, 'id'>): number
  /** Описание рендерабла (undefined — незарегистрированный id). */
  get(id: number): RenderableDesc | undefined
  mesh(id: number): MeshRecipe | undefined
  material(id: number): MaterialRecipe | undefined
  /** «Приведение к мешу»: загрузить и закэшировать геометрию рецепта. */
  resolveMesh(meshId: number): ResolvedMesh | undefined
  readonly count: number
}

/** Создать реестр рендераблов (метаданные, GPU не касается). */
export function createRenderableRegistry(): RenderableRegistry {
  const meshes: MeshRecipe[] = []
  const materials: MaterialRecipe[] = []
  const descs: RenderableDesc[] = []
  const cache = new Map<number, ResolvedMesh>()

  return {
    addMesh(load) {
      const id = meshes.length
      meshes.push({ id, load })
      return id
    },
    addMaterial(material) {
      const id = materials.length
      materials.push({ id, ...material })
      return id
    },
    add(desc) {
      if (meshes[desc.mesh] === undefined) throw new Error(`scene: рецепт меша ${desc.mesh} не зарегистрирован`)
      if (materials[desc.material] === undefined) throw new Error(`scene: материал ${desc.material} не зарегистрирован`)
      const id = descs.length
      descs.push({ id, ...desc })
      return id
    },
    get(id) { return descs[id] },
    mesh(id) { return meshes[id] },
    material(id) { return materials[id] },
    resolveMesh(meshId) {
      const recipe = meshes[meshId]
      if (recipe === undefined) return undefined
      let resolved = cache.get(meshId)
      if (resolved === undefined) {
        resolved = { meshId, geometry: recipe.load() }
        cache.set(meshId, resolved)
      }
      return resolved
    },
    get count() { return descs.length },
  }
}
