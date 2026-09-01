/**
 * instances.ts — компакция видимых инстансов (Task 81; Task 85 — штампы групп).
 *
 * Инстанс-группа — плотный id ≥ 0 в slot.group (−1 — узел вне инстансинга).
 * Проход по рангам с битом видимости камеры собирает МИРОВЫЕ матрицы
 * видимых узлов группы в непрерывный сегмент пула → один draw-instanced
 * на группу (матрицы — готовый instance-атрибут float32×16: stride 64,
 * divisor 1 — вёрстка rendererFeed / batchCommand из @rune/gl-мира).
 *
 * Task 85 — ШТАМПЫ ГРУПП для скипа аплоада: инстанс-буфер (группа × камера)
 * валиден, пока (а) счётчик группы не изменился, (б) ни один узел группы
 * не сменил видимость ДЛЯ ЭТОЙ камеры, (в) ни один узел группы не пересчитал
 * мир/состав. (в) штампует updateWorld/setVisible → groupTouch (общий);
 * (б) — этот проход: дифф битсетов текущей и ПРЕДЫДУЩЕЙ эпохи (двойные
 * битсеты — как раз для этого) → ПЕРКАМЕРНЫЙ groupFlip — флип дрона не
 * перевыгружает статику миникарты. Ранги между эпохами сравнимы только при
 * неизменном layout — иначе (pack!) трогаем все группы всех камер.
 *
 * Честная инженерия: word-skip обход битсетов (ctz-извлечение битов) ПОПРОБОВАН
 * и ОТКАЗАН — на реальной видимости демо (40–70%) он стабильно медленнее
 * рангового цикла с ранним бит-тестом (замеры: scripts/micro-collect.ts,
 * probe-прогоны Task 85); вырывается вперёд только при <10% видимости,
 * где компакция и так почти бесплатна. Оставлен простой ранговый обход.
 */
import type { SceneViews } from './layout.ts'
import {
  H_CLOCK,
  H_COLLECT_LAYOUT_EPOCH,
  H_DROPPED_INSTANCES,
  H_GROUP_COUNT,
  H_LAYOUT_EPOCH,
  H_MAX_INSTANCES,
  H_NODE_COUNT,
  NF_VISIBLE,
} from './layout.ts'
import { bitsBase } from './culling.ts'

/** Скретч-курсоры по группам. */
let cursors = new Int32Array(64)

/** База инстанс-счётчиков камеры в буфере b (в Int32Array instCounts). */
function instBase(views: SceneViews, bufferIndex: number, cameraIndex: number): number {
  return (bufferIndex * views.cameraMax + cameraIndex) * views.groupMax
}

/** База пула матриц камеры в буфере b (во Float32Array instPool).
 * Task 87 — экспорт для потребителей без аллокаций: чтение матриц группы
 * напрямую из views.instPool по числам (база + офсет×16), минуя
 * instanceMatricesView с его subarray-view на каждую группу каждый кадр. */
export function instancePoolBase(views: SceneViews, bufferIndex: number, cameraIndex: number): number {
  return (bufferIndex * views.cameraMax + cameraIndex) * views.headerI[H_MAX_INSTANCES] * 16
}

/** Виден ли ранг (бит + флаг узла). */
function rankVisible(views: SceneViews, base: number, r: number, slot: number): boolean {
  if ((views.bits[base + (r >>> 5)] & (1 << (r & 31))) === 0) return false
  return (views.nodeFlags[slot] & NF_VISIBLE) !== 0
}

/**
 * Собирает инстансы всех групп для камеры cameraIndex из буфера bufferIndex.
 * Возвращает суммарное число собранных матриц.
 */
export function collectInstancesViews(
  views: SceneViews,
  cameraIndex: number,
  bufferIndex: number,
): number {
  const n = views.headerI[H_NODE_COUNT]
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  const maxInstances = views.headerI[H_MAX_INSTANCES]
  const { order, group, world, instPool, instCounts, instOffsets, bits, groupTouch, groupFlip, headerI, headerU } = views
  const bitsBaseV = bitsBase(views, bufferIndex, cameraIndex)
  const countsBase = instBase(views, bufferIndex, cameraIndex)
  const offsetsBase = countsBase
  const pool = instancePoolBase(views, bufferIndex, cameraIndex)
  const words = views.bitsWords

  if (cursors.length < groupCount) cursors = new Int32Array(groupCount)

  // ── Task 85: дифф видимости против предыдущей эпохи → перкамерные штампы ──
  const flipBase = cameraIndex * views.groupMax
  if (headerI[H_COLLECT_LAYOUT_EPOCH] !== headerI[H_LAYOUT_EPOCH]) {
    // Ранги перемешаны pack'ом — дифф по рангам бессмысленен: трогаем все
    // группы ВСЕХ камер (консервативно — лишний аплоад, но не пропущенный).
    headerI[H_COLLECT_LAYOUT_EPOCH] = headerI[H_LAYOUT_EPOCH]
    const stamp = headerU[H_CLOCK] + 1
    for (let c = 0; c < views.cameraMax; c++) {
      const fb = c * views.groupMax
      for (let g = 0; g < groupCount; g++) groupFlip[fb + g] = stamp
    }
    for (let g = 0; g < groupCount; g++) groupTouch[g] = stamp
    headerU[H_CLOCK] = stamp
  } else {
    const prevBase = bitsBase(views, bufferIndex ^ 1, cameraIndex)
    const stamp = headerU[H_CLOCK] + 1
    let touched = false
    for (let w = 0; w < words; w++) {
      const cur = bits[bitsBaseV + w]
      const prev = bits[prevBase + w]
      if (cur === prev) continue
      let flips = cur ^ prev
      const rBase = w << 5
      while (flips !== 0) {
        const lb = flips & -flips
        flips ^= lb
        const r = rBase + 31 - Math.clz32(lb)
        if (r >= n) break // паддинг последнего слова — не узлы
        const g = group[order[r]]
        if (g >= 0 && g < groupCount) {
          groupFlip[flipBase + g] = stamp
          touched = true
        }
      }
    }
    if (touched) headerU[H_CLOCK] = stamp
  }

  // 1) Подсчёт по группам (ранговый обход; замеры Task 85 — см. шапку).
  for (let g = 0; g < groupCount; g++) instCounts[countsBase + g] = 0
  const nodeFlags = views.nodeFlags
  for (let r = 0; r < n; r++) {
    if ((bits[bitsBaseV + (r >>> 5)] & (1 << (r & 31))) === 0) continue
    const slot = order[r]
    const g = group[slot]
    if (g < 0 || g >= groupCount) continue
    if ((nodeFlags[slot] & NF_VISIBLE) !== 0) instCounts[countsBase + g]++
  }

  // 2) Префикс-офсеты (сегменты групп идут в порядке id).
  let total = 0
  for (let g = 0; g < groupCount; g++) {
    instOffsets[offsetsBase + g] = total
    cursors[g] = 0
    total += instCounts[countsBase + g]
  }

  // 3) Заполнение пула.
  let dropped = 0
  for (let r = 0; r < n; r++) {
    if ((bits[bitsBaseV + (r >>> 5)] & (1 << (r & 31))) === 0) continue
    const slot = order[r]
    const g = group[slot]
    if (g < 0 || g >= groupCount) continue
    if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
    const dst = instOffsets[offsetsBase + g] + cursors[g]
    if (dst >= maxInstances) {
      dropped++
      continue
    }
    cursors[g]++
    const src = slot * 16
    const o = pool + dst * 16
    for (let k = 0; k < 16; k++) instPool[o + k] = world[src + k]
  }
  if (dropped > 0) views.headerI[H_DROPPED_INSTANCES] += dropped
  return total - dropped
}

/** Сегмент матриц группы g камеры в буфере b (view — без копий). */
export function instanceMatricesView(
  views: SceneViews,
  bufferIndex: number,
  cameraIndex: number,
  group: number,
): { matrices: Float32Array; count: number } {
  const base = instBase(views, bufferIndex, cameraIndex)
  const count = Math.max(0, views.instCounts[base + group])
  const offset = views.instOffsets[base + group]
  const pool = instancePoolBase(views, bufferIndex, cameraIndex)
  return {
    matrices: views.instPool.subarray(pool + offset * 16, pool + (offset + count) * 16),
    count,
  }
}

/**
 * Простой сбор инстансов в пользовательский массив (T0-путь без пула):
 * матрицы видимых узлов группы подряд. Возвращает число записанных.
 */
export function collectGroupMatrices(
  views: SceneViews,
  cameraIndex: number,
  bufferIndex: number,
  groupId: number,
  out: Float32Array,
): number {
  const n = views.headerI[H_NODE_COUNT]
  const { order, group, world } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  let k = 0
  for (let r = 0; r < n; r++) {
    const slot = order[r]
    if (group[slot] !== groupId) continue
    if (!rankVisible(views, base, r, slot)) continue
    if (k * 16 + 16 > out.length) break
    const src = slot * 16
    for (let j = 0; j < 16; j++) out[k * 16 + j] = world[src + j]
    k++
  }
  return k
}
