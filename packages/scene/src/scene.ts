/**
 * scene.ts — сцена: структурный слой поверх SceneViews (Task 81).
 *
 * Иерархия — intrusive-списки детей (firstChild/nextSibling/prevSibling):
 * вставка/удаление O(1), слоты узлов СТАБИЛЬНЫ (переупорядочивания нет —
 * порядок обхода живёт в order[], а не в позициях массивов данных).
 *
 * pack() — перестройка order/subtreeEnd в preorder: один DFS со стеком +
 * реверс-агрегация концов поддеревьев. Инвариант после pack: родитель
 * всегда раньше ребёнка, поддерево — непрерывный диапазон рангов.
 * Структурные правки помечают layoutDirty; горячие проходы (updateWorld /
 * cull / collectInstances) автоматически до-pаковывают один раз за кадр.
 *
 * Раскладка памяти — та же, что у воркера (layout.ts): сцена в SAB
 * доступна воркеру без копий (T1/T2), локальная сцена — T0.
 */
import type { Camera } from './camera.ts'
import {
  buildSceneViews,
  createSceneBuffer,
  freeListWord,
  H_CAMERA_COUNT,
  H_CLOCK,
  H_GROUP_COUNT,
  H_LAYOUT_EPOCH,
  H_NODE_COUNT,
  NF_VISIBLE,
  NF_ALIVE,
} from './layout.ts'
import type { SceneBufferOptions, SceneViews } from './layout.ts'
import { cullViewsBrute, cullViewsHierarchical } from './culling.ts'
import type { CullStats, MutableCullStats } from './culling.ts'
import { collectInstancesViews, instanceMatricesView, instancePoolBase } from './instances.ts'
import { refitGroupBoundsForcedViews, refitGroupBoundsViews, updateWorldForcedViews, updateWorldViews } from './transforms.ts'

/** Инициализация нового узла. */
export interface SceneNodeInit {
  readonly position?: readonly [number, number, number]
  /** Кватернион (x, y, z, w); нормализуется при записи. */
  readonly rotation?: readonly [number, number, number, number]
  readonly scale?: readonly [number, number, number]
  /** Родитель (слот) или −1 для корня. */
  readonly parent?: number
  /** Инстанс-группа (плотный id ≥ 0) или −1. */
  readonly group?: number
  /** Пользовательский слот (id команды/ассета) или −1. */
  readonly payload?: number
  /** Локальная сфера охвата (cx, cy, cz, r). */
  readonly sphere?: readonly [number, number, number, number]
  readonly visible?: boolean
}

/** Результат отсечения камер. */
export interface SceneCullResult {
  readonly cameraCount: number
  readonly stats: readonly CullStats[]
  /** Буфер битсетов (для isVisibleRank / forEachVisible). */
  readonly bufferIndex: number
}

/** Сцена — структурные операции + горячие проходы. */
export interface Scene {
  readonly views: SceneViews
  readonly capacity: number
  readonly count: number
  readonly backing: 'local' | 'shared'
  /** Порядок устарел после структурных правок. */
  readonly layoutDirty: boolean

  /** Создать узел; возвращает стабильный слот. */
  create(init?: SceneNodeInit): number
  /** Удалить узел (дети становятся корнями). Идемпотентно для мёртвых. */
  dispose(slot: number): void
  /** Смена родителя (−1 — сделать корнем). Циклы — throw. */
  setParent(slot: number, parent: number): void
  /** Родитель слота (−1 — корень/свободен). */
  parentOf(slot: number): number
  /** Жив ли слот. */
  alive(slot: number): boolean
  /** Поколение слота (растёт при каждом переиспользовании). */
  generation(slot: number): number

  /** Локальный TRS (объект-сахар; для анимации — setLocalTR). */
  setLocal(slot: number, init: { position?: readonly [number, number, number]; rotation?: readonly [number, number, number, number]; scale?: readonly [number, number, number] }): void
  /** Горячая запись полного TRS без аллокаций. */
  setLocalTR(
    slot: number,
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
    sx: number, sy: number, sz: number,
  ): void
  setSphereLocal(slot: number, cx: number, cy: number, cz: number, r: number): void
  setGroup(slot: number, group: number): void
  setPayload(slot: number, payload: number): void
  setVisible(slot: number, visible: boolean): void

  /** Мировая матрица узла (view поверх world; не мутировать). */
  worldMatrix(slot: number): Float32Array

  /** Перестроить order/subtreeEnd (вызывается автоматически при надобности). */
  pack(): void

  /** Пересчёт миров. dirty=false — принудительно ВСЕ узлы (эталон/A-B
   *  «до Task 85»: без грязевых штампов — каждый узел, каждый кадр).
   *  Возвращает число пересчитанных узлов. */
  updateWorld(force?: boolean): number
  /** Грязевой refit автограниц — только изменённые поддеревья (Task 85). */
  refitGroupBounds(): number
  /** Полный refit всех автограниц — эталон/бенчмарк (O(n) всегда). */
  refitGroupBoundsForced(): number
  /** Штамп H_CLOCK последнего изменения КОНТЕНТА группы (мир/состав —
   *  все камеры). Пока не вырос И счётчики прежние — инстанс-буферы группы
   *  валидны, аплоад можно пропустить (Task 85). */
  groupWorldStamp(group: number): number
  /** Штамп последнего ФЛИПА видимости узла группы ДЛЯ камеры cameraIndex
   *  (Task 85): флип одной камеры не трогает буферы другой. */
  groupFlipStamp(group: number, cameraIndex: number): number

  /** Отсечение камерами; пишет плоскости и битсеты в буфер bufferIndex.
   *  masks=false — отключить наследование масок плоскостей (A/B «до Task 85»:
   *  результат идентичен, тестов ~×2.6 больше). out — переиспользуемые
   *  записи статистики (ноль аллокаций на кадр). */
  cull(cameras: readonly Camera[], opts?: {
    brute?: boolean
    bufferIndex?: number
    masks?: boolean
    out?: readonly MutableCullStats[]
  }): SceneCullResult

  /** Сбор инстансов всех групп для камеры (в буфер bufferIndex). */
  collectInstances(cameraIndex: number, opts?: { bufferIndex?: number }): number
  /** Сегмент матриц группы (view поверх пула камеры). */
  instances(group: number, opts?: { cameraIndex?: number; bufferIndex?: number }): { matrices: Float32Array; count: number }
  /** Task 87 — БЕЗ АЛЛОКАЦИЙ: счётчик/офсет/база пула группы как числа
   *  (потребитель читает views.instPool напрямую — ни объектов, ни subarray). */
  instanceCountOf(group: number, cameraIndex: number, bufferIndex?: number): number
  instanceOffsetOf(group: number, cameraIndex: number, bufferIndex?: number): number
  instancePoolBase(cameraIndex: number, bufferIndex?: number): number

  /** Обход видимых слотов камеры (бит ∩ флаг узла). */
  forEachVisible(cameraIndex: number, cb: (slot: number, rank: number) => void, opts?: { bufferIndex?: number }): void
  /** Видимость ранга (без учёта флагов узла). */
  isVisibleRank(cameraIndex: number, rank: number, opts?: { bufferIndex?: number }): boolean

  /** Камера на узле: view = world⁻¹. */
  cameraFromNode(camera: Camera, slot: number): Camera
}

/** Опции создания сцены. */
export type SceneOptions = SceneBufferOptions

/** Создать сцену (локальную или разделяемую с воркером). */
export function createScene(options: SceneOptions = {}): Scene {
  const buffer = createSceneBuffer(options)
  return createSceneFromBuffer(buffer)
}

/** Обернуть готовый буфер сцены (например, SAB, полученный из воркера). */
export function createSceneFromBuffer(buffer: ArrayBufferLike): Scene {
  const views = buildSceneViews(buffer)
  const freeList = freeListWord(views)
  // Полный int-вью: freeHead/freeCount лежат за пределами H_WORDS.
  const fullWords = new Int32Array(buffer)
  const shared = typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer
  let layoutDirty = true

  function ensurePacked(): void {
    if (layoutDirty) packInternal()
  }

  function packInternal(): void {
    const { parent, firstChild, nextSibling, order, subtreeEnd, nodeFlags, headerI } = views
    const n = views.headerI[H_NODE_COUNT]
    // Стек слотов: корни в порядке слотов (пушим в обратном — LIFO).
    let stack = packStack
    if (stack.length < n + 1) {
      stack = packStack = new Int32Array(Math.max(64, (n + 1) * 2))
    }
    let sp = 0
    let rank = 0
    const capacity = views.capacity
    for (let slot = capacity - 1; slot >= 0; slot--) {
      if ((nodeFlags[slot] & NF_ALIVE) !== 0 && parent[slot] < 0) {
        stack[sp++] = slot
      }
    }
    while (sp > 0) {
      const slot = stack[--sp]
      order[rank] = slot
      subtreeEnd[slot] = rank + 1
      rank++
      if (rank > n) break // защита от битой структуры
      // Дети: пушим с головы списка — выйдут в обратном порядке вставки.
      let c = firstChild[slot]
      while (c >= 0) {
        if (sp >= stack.length) {
          const grown = new Int32Array(stack.length * 2)
          grown.set(stack)
          stack = packStack = grown
        }
        stack[sp++] = c
        c = nextSibling[c]
      }
    }
    // Реверс-агрегация: конец поддерева родителя = конец последнего ребёнка.
    for (let r = rank - 1; r >= 0; r--) {
      const slot = order[r]
      const p = parent[slot]
      if (p >= 0 && subtreeEnd[slot] > subtreeEnd[p]) subtreeEnd[p] = subtreeEnd[slot]
    }
    headerI[H_LAYOUT_EPOCH] = (headerI[H_LAYOUT_EPOCH] + 1) | 0
    layoutDirty = false
  }

  function takeSlot(): number {
    const head = fullWords[freeList]
    if (!(head >= 0)) {
      throw new Error(`scene: нет свободных слотов (capacity=${views.capacity})`)
    }
    fullWords[freeList] = views.nextSibling[head]
    fullWords[freeList + 1] -= 1
    return head
  }

  function releaseSlot(slot: number): void {
    views.nextSibling[slot] = fullWords[freeList]
    views.prevSibling[slot] = -1
    fullWords[freeList] = slot
    fullWords[freeList + 1] += 1
  }

  function detach(slot: number): void {
    const { parent, firstChild, nextSibling, prevSibling } = views
    const p = parent[slot]
    if (p < 0) return
    if (firstChild[p] === slot) {
      firstChild[p] = nextSibling[slot]
      if (nextSibling[slot] >= 0) prevSibling[nextSibling[slot]] = -1
    } else {
      const prev = prevSibling[slot]
      const next = nextSibling[slot]
      if (prev >= 0) nextSibling[prev] = next
      if (next >= 0) prevSibling[next] = prev
    }
    parent[slot] = -1
    nextSibling[slot] = -1
    prevSibling[slot] = -1
  }

  function attach(slot: number, parentSlot: number): void {
    const { parent, firstChild, nextSibling, prevSibling } = views
    const old = firstChild[parentSlot]
    nextSibling[slot] = old
    prevSibling[slot] = -1
    if (old >= 0) prevSibling[old] = slot
    firstChild[parentSlot] = slot
    parent[slot] = parentSlot
  }

  const scene: Scene = {
    views,
    get capacity() { return views.capacity },
    get count() { return views.headerI[H_NODE_COUNT] },
    get backing() { return shared ? 'shared' : 'local' },
    get layoutDirty() { return layoutDirty },

    create(init = {}) {
      const slot = takeSlot()
      const { pos, quat, scale, group, payload, nodeFlags, sphereL, world, sphereW, headerU } = views
      const i3 = slot * 3
      const i4 = slot * 4
      const i16 = slot * 16
      // Первичная грязь: мир обязан вычислиться хотя бы раз (родитель мог
      // уже иметь трансформ).
      const stamp = ++headerU[H_CLOCK]
      views.localStamp[slot] = stamp
      views.worldStamp[slot] = 0
      // Дефолты: identity TRS, identity мир.
      pos[i3] = 0; pos[i3 + 1] = 0; pos[i3 + 2] = 0
      quat[i4] = 0; quat[i4 + 1] = 0; quat[i4 + 2] = 0; quat[i4 + 3] = 1
      scale[i3] = 1; scale[i3 + 1] = 1; scale[i3 + 2] = 1
      world.fill(0, i16, i16 + 16)
      world[i16] = world[i16 + 5] = world[i16 + 10] = world[i16 + 15] = 1
      sphereL[i4] = 0; sphereL[i4 + 1] = 0; sphereL[i4 + 2] = 0; sphereL[i4 + 3] = 0
      sphereW[i4] = 0; sphereW[i4 + 1] = 0; sphereW[i4 + 2] = 0; sphereW[i4 + 3] = 0
      group[slot] = init.group ?? -1
      payload[slot] = init.payload ?? -1
      nodeFlags[slot] = NF_ALIVE | (init.visible === false ? 0 : NF_VISIBLE)
      if (init.sphere !== undefined) {
        sphereL[i4] = init.sphere[0]
        sphereL[i4 + 1] = init.sphere[1]
        sphereL[i4 + 2] = init.sphere[2]
        sphereL[i4 + 3] = init.sphere[3]
      }
      if (init.position !== undefined) {
        pos[i3] = init.position[0]
        pos[i3 + 1] = init.position[1]
        pos[i3 + 2] = init.position[2]
      }
      if (init.rotation !== undefined) {
        const [qx, qy, qz, qw] = init.rotation
        const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
        if (len > 1e-12) {
          quat[i4] = qx / len; quat[i4 + 1] = qy / len; quat[i4 + 2] = qz / len; quat[i4 + 3] = qw / len
        }
      }
      if (init.scale !== undefined) {
        scale[i3] = init.scale[0]
        scale[i3 + 1] = init.scale[1]
        scale[i3 + 2] = init.scale[2]
      }
      const p = init.parent ?? -1
      if (p >= 0) {
        if (p === slot) throw new Error('scene: родитель узла — сам узел')
        if ((views.nodeFlags[p] & NF_ALIVE) === 0) throw new Error(`scene: родитель ${p} не жив`)
        // Цикл: новый родитель не должен быть потомком slot.
        let a = p
        while (a >= 0) {
          if (a === slot) throw new Error('scene: setParent создал бы цикл')
          a = views.parent[a]
        }
        attach(slot, p)
      }
      views.headerI[H_NODE_COUNT] += 1
      if (init.group !== undefined && init.group >= 0) bumpGroupCount(init.group)
      layoutDirty = true
      return slot
    },

    dispose(slot) {
      const { nodeFlags, generation, headerU } = views
      if ((nodeFlags[slot] & NF_ALIVE) === 0) return
      // Дети становятся корнями (локаль сохраняется — мир пересчитается).
      let c = views.firstChild[slot]
      while (c >= 0) {
        const next = views.nextSibling[c]
        detach(c)
        views.localStamp[c] = ++headerU[H_CLOCK]
        c = next
      }
      detach(slot)
      nodeFlags[slot] = 0
      generation[slot] = generation[slot] + 1
      releaseSlot(slot)
      views.headerI[H_NODE_COUNT] -= 1
      layoutDirty = true
    },

    setParent(slot, parentSlot) {
      if ((views.nodeFlags[slot] & NF_ALIVE) === 0) throw new Error(`scene: узел ${slot} не жив`)
      if (parentSlot === slot) throw new Error('scene: родитель узла — сам узел')
      if (parentSlot >= 0) {
        if ((views.nodeFlags[parentSlot] & NF_ALIVE) === 0) throw new Error(`scene: родитель ${parentSlot} не жив`)
        let a = parentSlot
        while (a >= 0) {
          if (a === slot) throw new Error('scene: setParent создал бы цикл')
          a = views.parent[a]
        }
      }
      detach(slot)
      if (parentSlot >= 0) attach(slot, parentSlot)
      // Мир узла меняется (смена системы отсчёта) — потомки инвалидируются
      // автоматически через worldStamp[parent] > worldStamp[child].
      views.localStamp[slot] = ++views.headerU[H_CLOCK]
      layoutDirty = true
    },

    parentOf(slot) { return views.parent[slot] },
    alive(slot) { return (views.nodeFlags[slot] & NF_ALIVE) !== 0 },
    generation(slot) { return views.generation[slot] },

    setLocal(slot, init) {
      const { pos, quat, scale, headerU } = views
      const i3 = slot * 3
      const i4 = slot * 4
      let touched = false
      if (init.position !== undefined) {
        pos[i3] = init.position[0]
        pos[i3 + 1] = init.position[1]
        pos[i3 + 2] = init.position[2]
        touched = true
      }
      if (init.rotation !== undefined) {
        const [qx, qy, qz, qw] = init.rotation
        const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
        if (len > 1e-12) {
          quat[i4] = qx / len; quat[i4 + 1] = qy / len; quat[i4 + 2] = qz / len; quat[i4 + 3] = qw / len
        }
        touched = true
      }
      if (init.scale !== undefined) {
        scale[i3] = init.scale[0]
        scale[i3 + 1] = init.scale[1]
        scale[i3 + 2] = init.scale[2]
        touched = true
      }
      if (touched) views.localStamp[slot] = ++headerU[H_CLOCK]
    },

    setLocalTR(slot, px, py, pz, qx, qy, qz, qw, sx, sy, sz) {
      const { pos, quat, scale, headerU } = views
      const i3 = slot * 3
      const i4 = slot * 4
      pos[i3] = px; pos[i3 + 1] = py; pos[i3 + 2] = pz
      const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
      if (len > 1e-12) {
        quat[i4] = qx / len; quat[i4 + 1] = qy / len; quat[i4 + 2] = qz / len; quat[i4 + 3] = qw / len
      } else {
        quat[i4] = 0; quat[i4 + 1] = 0; quat[i4 + 2] = 0; quat[i4 + 3] = 1
      }
      scale[i3] = sx; scale[i3 + 1] = sy; scale[i3 + 2] = sz
      views.localStamp[slot] = ++headerU[H_CLOCK]
    },

    setSphereLocal(slot, cx, cy, cz, r) {
      const i4 = slot * 4
      views.sphereL[i4] = cx
      views.sphereL[i4 + 1] = cy
      views.sphereL[i4 + 2] = cz
      views.sphereL[i4 + 3] = r
      // Мировая сфера пересчитывается в updateWorld — штамп обязателен
      // (Task 85: без него правка сферы не применялась до постороннего
      // изменения узла; найдено при переходе на грязевой refit).
      views.localStamp[slot] = ++views.headerU[H_CLOCK]
    },

    setGroup(slot, group) {
      views.group[slot] = group
      if (group >= 0) bumpGroupCount(group)
    },

    setPayload(slot, payload) { views.payload[slot] = payload },
    setVisible(slot, visible) {
      if (visible) views.nodeFlags[slot] |= NF_VISIBLE
      else views.nodeFlags[slot] &= ~NF_VISIBLE
      // Task 85: смена флага меняет СОСТАВ инстанс-группы — штамп обязателен
      // (иначе скип аплоада пропустит подмену матриц при равном счётчике).
      const g = views.group[slot]
      if (g >= 0 && g < views.groupMax) views.groupTouch[g] = ++views.headerU[H_CLOCK]
    },

    worldMatrix(slot) { return views.world.subarray(slot * 16, slot * 16 + 16) },

    pack: packInternal,

    updateWorld(force = false) {
      ensurePacked()
      return force ? updateWorldForcedViews(views) : updateWorldViews(views)
    },

    refitGroupBounds() {
      ensurePacked()
      return refitGroupBoundsViews(views)
    },

    refitGroupBoundsForced() {
      ensurePacked()
      return refitGroupBoundsForcedViews(views)
    },

    groupWorldStamp(group) {
      return group >= 0 && group < views.groupMax ? views.groupTouch[group] : 0
    },

    groupFlipStamp(group, cameraIndex) {
      if (group < 0 || group >= views.groupMax) return 0
      if (cameraIndex < 0 || cameraIndex >= views.cameraMax) return 0
      return views.groupFlip[cameraIndex * views.groupMax + group]
    },

    cull(cameras, opts = {}) {
      ensurePacked()
      const bufferIndex = opts.bufferIndex ?? 0
      const masks = opts.masks !== false
      const count = Math.min(cameras.length, views.cameraMax)
      for (let k = 0; k < count; k++) {
        const planes = cameras[k]!.planes
        // planes у камеры ровно 24 флоата — прямой set без subarray- view
        // (Task 87: срез на каждую камеру каждого кадра — скрытая аллокация)
        if (planes.length === 24) views.planes.set(planes, k * 24)
        else views.planes.set(planes.subarray(0, 24), k * 24)
      }
      views.headerI[H_CAMERA_COUNT] = count
      const out = opts.out
      const stats: CullStats[] = []
      for (let k = 0; k < count; k++) {
        const reuse = out !== undefined && k < out.length ? out[k] : undefined
        stats.push(opts.brute === true
          ? cullViewsBrute(views, k, bufferIndex, reuse)
          : cullViewsHierarchical(views, k, bufferIndex, reuse, masks))
      }
      return { cameraCount: count, stats, bufferIndex }
    },

    collectInstances(cameraIndex, opts = {}) {
      ensurePacked()
      const bufferIndex = opts.bufferIndex ?? 0
      return collectInstancesViews(views, cameraIndex, bufferIndex)
    },

    instances(group, opts = {}) {
      return instanceMatricesView(views, opts.bufferIndex ?? 0, opts.cameraIndex ?? 0, group)
    },

    instanceCountOf(group, cameraIndex, bufferIndex = 0) {
      if (group < 0 || group >= views.groupMax) return 0
      const base = (bufferIndex * views.cameraMax + cameraIndex) * views.groupMax
      return Math.max(0, views.instCounts[base + group])
    },

    instanceOffsetOf(group, cameraIndex, bufferIndex = 0) {
      if (group < 0 || group >= views.groupMax) return 0
      const base = (bufferIndex * views.cameraMax + cameraIndex) * views.groupMax
      return views.instOffsets[base + group]
    },

    instancePoolBase(cameraIndex, bufferIndex = 0) {
      return instancePoolBase(views, bufferIndex, cameraIndex)
    },

    forEachVisible(cameraIndex, cb, opts = {}) {
      ensurePacked()
      const bufferIndex = opts.bufferIndex ?? 0
      const n = views.headerI[H_NODE_COUNT]
      const base = (bufferIndex * views.cameraMax + cameraIndex) * views.bitsWords
      const { bits, order, nodeFlags } = views
      for (let r = 0; r < n; r++) {
        if ((bits[base + (r >>> 5)] & (1 << (r & 31))) === 0) continue
        const slot = order[r]
        if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
        cb(slot, r)
      }
    },

    isVisibleRank(cameraIndex, rank, opts = {}) {
      const bufferIndex = opts.bufferIndex ?? 0
      const base = (bufferIndex * views.cameraMax + cameraIndex) * views.bitsWords
      return (views.bits[base + (rank >>> 5)] & (1 << (rank & 31))) !== 0
    },

    cameraFromNode(camera, slot) {
      return camera.setViewFromWorld(views.world.subarray(slot * 16, slot * 16 + 16))
    },
  }

  function bumpGroupCount(group: number): void {
    const current = views.headerI[H_GROUP_COUNT]
    if (group >= current) {
      if (group >= views.groupMax) {
        throw new Error(`scene: группа ${group} вне groupMax=${views.groupMax}`)
      }
      views.headerI[H_GROUP_COUNT] = group + 1
    }
  }

  return scene
}

/** Скретч-стек pack(). */
let packStack = new Int32Array(1024)
