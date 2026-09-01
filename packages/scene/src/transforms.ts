/**
 * transforms.ts — распространение мировых трансформаций (Task 81).
 *
 * Ключевая оптимизация плоской раскладки: order[] — обход в глубину,
 * родитель ВСЕГДА раньше ребёнка → один проход по рангам сверху вниз
 * без рекурсии и без стека; world родителя уже свежий, когда доходит
 * очередь ребёнка (и обычно ещё в L1 — 64 байта матрицы).
 *
 * Грязь — u32-штампы монотонных часов (H_CLOCK):
 *   localStamp[i]  — когда меняли локальный TRS узла;
 *   worldStamp[i]  — когда писали его мир.
 * Узел пересчитывается ⟺ localStamp > worldStamp (сам менялся) ИЛИ
 * worldStamp[parent] > worldStamp[i] (мир родителя стал новее моего мира).
 * Обнуление штампов — нулевые значения, нетрогнутый узел = identity.
 *
 * refitGroupBounds — «восходящий» проход по order[] С КОНЦА только по
 * ГРЯЗЫМ поддеревьям (Task 85): дети позже по рангу — обработаны раньше.
 * Грязь — битсет dirtyBounds (по слотам): updateWorld помечает рекомпьютный
 * узел И ВСЕХ предков (подъём по цепочке, ранний выход по уже-поставленному
 * биту — инвариант «метки всегда до корня»). Внутренние узлы без
 * пользовательской сферы получают sphereW как объединение сфер детей
 * (bottom-up BVH-refit). Статичные поддеревья не обходятся ВООБЩЕ —
 * на покое/малой анимации refit деградирует с O(n) до O(изменённого).
 */
import type { SceneViews } from './layout.ts'
import { H_CLOCK, H_GROUP_COUNT, H_NODE_COUNT } from './layout.ts'

/** Метка «поддерево требует refit»: узел + все предки (по слотам). */
function markDirtyUp(views: SceneViews, slot: number): void {
  const { parent, dirtyBounds } = views
  let a = slot
  while (a >= 0) {
    const w = a >>> 5
    const m = 1 << (a & 31)
    if ((dirtyBounds[w] & m) !== 0) break // цепочка до корня уже помечена
    dirtyBounds[w] |= m
    a = parent[a]
  }
}

/** Штамп группы: контент её инстансов изменился (мир узла пересчитан). */
function touchGroup(views: SceneViews, group: number, stamp: number): void {
  if (group >= 0 && group < views.groupMax) views.groupTouch[group] = stamp
}

/** Скретч на 16 float — вне горячих циклов не аллоцируется. */
const scratch = new Float32Array(16)

/** Композиция TRS с базовым смещением (без аллокаций). */
function composeAt(
  out: Float32Array, o: number,
  qx: number, qy: number, qz: number, qw: number,
  tx: number, ty: number, tz: number,
  sx: number, sy: number, sz: number,
): void {
  const x = qx, y = qy, z = qz, w = qw
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  out[o] = (1 - (yy + zz)) * sx
  out[o + 1] = (xy + wz) * sx
  out[o + 2] = (xz - wy) * sx
  out[o + 3] = 0
  out[o + 4] = (xy - wz) * sy
  out[o + 5] = (1 - (xx + zz)) * sy
  out[o + 6] = (yz + wx) * sy
  out[o + 7] = 0
  out[o + 8] = (xz + wy) * sz
  out[o + 9] = (yz - wx) * sz
  out[o + 10] = (1 - (xx + yy)) * sz
  out[o + 11] = 0
  out[o + 12] = tx
  out[o + 13] = ty
  out[o + 14] = tz
  out[o + 15] = 1
}

/** Аффинное произведение world[aBase] · local[bBase] → out[oBase]. */
function mulAffineAt(
  out: Float32Array, o: number,
  a: Float32Array, aBase: number,
  b: Float32Array, bBase: number,
): void {
  const l0 = a[aBase], l1 = a[aBase + 1], l2 = a[aBase + 2]
  const l4 = a[aBase + 4], l5 = a[aBase + 5], l6 = a[aBase + 6]
  const l8 = a[aBase + 8], l9 = a[aBase + 9], l10 = a[aBase + 10]
  const l12 = a[aBase + 12], l13 = a[aBase + 13], l14 = a[aBase + 14]
  out[o] = l0 * b[bBase] + l4 * b[bBase + 1] + l8 * b[bBase + 2]
  out[o + 1] = l1 * b[bBase] + l5 * b[bBase + 1] + l9 * b[bBase + 2]
  out[o + 2] = l2 * b[bBase] + l6 * b[bBase + 1] + l10 * b[bBase + 2]
  out[o + 3] = 0
  out[o + 4] = l0 * b[bBase + 4] + l4 * b[bBase + 5] + l8 * b[bBase + 6]
  out[o + 5] = l1 * b[bBase + 4] + l5 * b[bBase + 5] + l9 * b[bBase + 6]
  out[o + 6] = l2 * b[bBase + 4] + l6 * b[bBase + 5] + l10 * b[bBase + 6]
  out[o + 7] = 0
  out[o + 8] = l0 * b[bBase + 8] + l4 * b[bBase + 9] + l8 * b[bBase + 10]
  out[o + 9] = l1 * b[bBase + 8] + l5 * b[bBase + 9] + l9 * b[bBase + 10]
  out[o + 10] = l2 * b[bBase + 8] + l6 * b[bBase + 9] + l10 * b[bBase + 10]
  out[o + 11] = 0
  out[o + 12] = l0 * b[bBase + 12] + l4 * b[bBase + 13] + l8 * b[bBase + 14] + l12
  out[o + 13] = l1 * b[bBase + 12] + l5 * b[bBase + 13] + l9 * b[bBase + 14] + l13
  out[o + 14] = l2 * b[bBase + 12] + l6 * b[bBase + 13] + l10 * b[bBase + 14] + l14
  out[o + 15] = 1
}

/** Пересчёт мировой сферы узла из локальной (сдвиг + макс. масштаб). */
function sphereWorldAt(views: SceneViews, i: number): void {
  const w = views.world
  const w16 = i * 16
  const s = views.sphereL
  const s4 = i * 4
  const cx = s[s4], cy = s[s4 + 1], cz = s[s4 + 2], r = s[s4 + 3]
  const out = views.sphereW
  const o4 = i * 4
  out[o4] = w[w16] * cx + w[w16 + 4] * cy + w[w16 + 8] * cz + w[w16 + 12]
  out[o4 + 1] = w[w16 + 1] * cx + w[w16 + 5] * cy + w[w16 + 9] * cz + w[w16 + 13]
  out[o4 + 2] = w[w16 + 2] * cx + w[w16 + 6] * cy + w[w16 + 10] * cz + w[w16 + 14]
  if (r <= 0) {
    out[o4 + 3] = 0
    return
  }
  const c0x = w[w16], c0y = w[w16 + 1], c0z = w[w16 + 2]
  const c1x = w[w16 + 4], c1y = w[w16 + 5], c1z = w[w16 + 6]
  const c2x = w[w16 + 8], c2y = w[w16 + 9], c2z = w[w16 + 10]
  const l0 = Math.sqrt(c0x * c0x + c0y * c0y + c0z * c0z)
  const l1 = Math.sqrt(c1x * c1x + c1y * c1y + c1z * c1z)
  const l2 = Math.sqrt(c2x * c2x + c2y * c2y + c2z * c2z)
  const maxScale = l0 > l1 ? (l0 > l2 ? l0 : l2) : l1 > l2 ? l1 : l2
  out[o4 + 3] = r * maxScale
}

/**
 * Пересчёт миров (грязевые штампы). Возвращает число пересчитанных узлов.
 * Требует свежий order[] (pack); порядок родитель-раньше-ребёнка — инвариант
 * раскладки. Попутно (Task 85): помечает dirtyBounds (узел + предки) и
 * ставит штампы групп — их едят грязевой refit и скип аплоада инстансов.
 */
export function updateWorldViews(views: SceneViews): number {
  const n = views.headerI[H_NODE_COUNT]
  const { order, parent, pos, quat, scale, world, localStamp, worldStamp, headerU, group } = views
  let clock = headerU[H_CLOCK]
  let recomputed = 0
  for (let r = 0; r < n; r++) {
    const i = order[r]
    const ws = worldStamp[i]
    const p = parent[i]
    if (localStamp[i] <= ws && (p < 0 || worldStamp[p] <= ws)) continue
    const i3 = i * 3
    const i4 = i * 4
    const i16 = i * 16
    if (p < 0) {
      composeAt(world, i16,
        quat[i4], quat[i4 + 1], quat[i4 + 2], quat[i4 + 3],
        pos[i3], pos[i3 + 1], pos[i3 + 2],
        scale[i3], scale[i3 + 1], scale[i3 + 2])
    } else {
      composeAt(scratch, 0,
        quat[i4], quat[i4 + 1], quat[i4 + 2], quat[i4 + 3],
        pos[i3], pos[i3 + 1], pos[i3 + 2],
        scale[i3], scale[i3 + 1], scale[i3 + 2])
      mulAffineAt(world, i16, world, p * 16, scratch, 0)
    }
    sphereWorldAt(views, i)
    clock++
    worldStamp[i] = clock
    markDirtyUp(views, i)
    touchGroup(views, group[i], clock)
    recomputed++
  }
  headerU[H_CLOCK] = clock
  return recomputed
}

/**
 * Принудительный пересчёт всех миров (без проверки штампов) — эталон для
 * бенчмарков «dirty vs full» и восстановление после ручных правок world.
 */
export function updateWorldForcedViews(views: SceneViews): number {
  const n = views.headerI[H_NODE_COUNT]
  const { order, parent, pos, quat, scale, world, worldStamp, headerU } = views
  let clock = headerU[H_CLOCK]
  for (let r = 0; r < n; r++) {
    const i = order[r]
    const p = parent[i]
    const i3 = i * 3
    const i4 = i * 4
    const i16 = i * 16
    if (p < 0) {
      composeAt(world, i16,
        quat[i4], quat[i4 + 1], quat[i4 + 2], quat[i4 + 3],
        pos[i3], pos[i3 + 1], pos[i3 + 2],
        scale[i3], scale[i3 + 1], scale[i3 + 2])
    } else {
      composeAt(scratch, 0,
        quat[i4], quat[i4 + 1], quat[i4 + 2], quat[i4 + 3],
        pos[i3], pos[i3 + 1], pos[i3 + 2],
        scale[i3], scale[i3 + 1], scale[i3 + 2])
      mulAffineAt(world, i16, world, p * 16, scratch, 0)
    }
    sphereWorldAt(views, i)
    clock++
    worldStamp[i] = clock
  }
  headerU[H_CLOCK] = clock
  // Все миры переписаны — все поддеревья и группы «изменились».
  views.dirtyBounds.fill(0xffffffff)
  const groupsAll = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  for (let g = 0; g < groupsAll; g++) views.groupTouch[g] = clock
  return n
}

/**
 * Грязевой refit (Task 85): обратный проход ТОЛЬКО по узлам с битом
 * dirtyBounds (узел сам менялся — его пересчитал updateWorld — или потомок).
 * Возвращает число пересобранных узлов. Требует updateWorld до вызова.
 */
export function refitGroupBoundsViews(views: SceneViews): number {
  const n = views.headerI[H_NODE_COUNT]
  const { order, subtreeEnd, sphereL, sphereW, dirtyBounds } = views
  let refit = 0
  for (let r = n - 1; r >= 0; r--) {
    const i = order[r]
    const w = i >>> 5
    const m = 1 << (i & 31)
    if ((dirtyBounds[w] & m) === 0) continue // статичное поддерево — сфера валидна
    dirtyBounds[w] &= ~m
    const e = subtreeEnd[i]
    if (e <= r + 1) continue // лист — его сферу ведёт updateWorld
    if (sphereL[i * 4 + 3] > 0) continue // пользовательская сфера — не трогаем
    // Обход детей (каждый — свой поддиапазон рангов сразу за родителем).
    let minx = 0, miny = 0, minz = 0, maxx = 0, maxy = 0, maxz = 0
    let r2 = r + 1
    let first = true
    let singleChild = -1
    let childCount = 0
    while (r2 < e) {
      const child = order[r2]
      const c4 = child * 4
      const cx = sphereW[c4], cy = sphereW[c4 + 1], cz = sphereW[c4 + 2]
      const cr = sphereW[c4 + 3]
      if (first) {
        minx = cx - cr; maxx = cx + cr
        miny = cy - cr; maxy = cy + cr
        minz = cz - cr; maxz = cz + cr
        first = false
      } else {
        if (cx - cr < minx) minx = cx - cr
        if (cx + cr > maxx) maxx = cx + cr
        if (cy - cr < miny) miny = cy - cr
        if (cy + cr > maxy) maxy = cy + cr
        if (cz - cr < minz) minz = cz - cr
        if (cz + cr > maxz) maxz = cz + cr
      }
      childCount++
      singleChild = child
      r2 = subtreeEnd[child]
    }
    if (first) continue // детей нет (не должно случаться после pack)
    const o4 = i * 4
    if (childCount === 1) {
      // Единственный ребёнок: его сфера и есть минимальный охват
      // (цепочки — обычное дело, AABB переоценивал бы каждый раз).
      const c4 = singleChild * 4
      sphereW[o4] = sphereW[c4]
      sphereW[o4 + 1] = sphereW[c4 + 1]
      sphereW[o4 + 2] = sphereW[c4 + 2]
      sphereW[o4 + 3] = sphereW[c4 + 3]
      refit++
      continue
    }
    sphereW[o4] = (minx + maxx) * 0.5
    sphereW[o4 + 1] = (miny + maxy) * 0.5
    sphereW[o4 + 2] = (minz + maxz) * 0.5
    sphereW[o4 + 3] = 0.5 * Math.sqrt(
      (maxx - minx) * (maxx - minx) +
      (maxy - miny) * (maxy - miny) +
      (maxz - minz) * (maxz - minz),
    )
    refit++
  }
  return refit
}

/**
 * Полный refit ВСЕХ автограниц (Task 81-бейзлайн; Task 85 — эталон паритета
 * и бенчмарк-сравнение). O(n) всегда; эквивалентен refitGroupBoundsViews
 * при корректной грязи. Снимает всю грязь (всё пересчитано).
 */
export function refitGroupBoundsForcedViews(views: SceneViews): number {
  const n = views.headerI[H_NODE_COUNT]
  const { order, subtreeEnd, sphereL, sphereW } = views
  let refit = 0
  for (let r = n - 1; r >= 0; r--) {
    const i = order[r]
    const e = subtreeEnd[i]
    if (e <= r + 1) continue // лист — его сферу ведёт updateWorld
    if (sphereL[i * 4 + 3] > 0) continue // пользовательская сфера — не трогаем
    let minx = 0, miny = 0, minz = 0, maxx = 0, maxy = 0, maxz = 0
    let r2 = r + 1
    let first = true
    let singleChild = -1
    let childCount = 0
    while (r2 < e) {
      const child = order[r2]
      const c4 = child * 4
      const cx = sphereW[c4], cy = sphereW[c4 + 1], cz = sphereW[c4 + 2]
      const cr = sphereW[c4 + 3]
      if (first) {
        minx = cx - cr; maxx = cx + cr
        miny = cy - cr; maxy = cy + cr
        minz = cz - cr; maxz = cz + cr
        first = false
      } else {
        if (cx - cr < minx) minx = cx - cr
        if (cx + cr > maxx) maxx = cx + cr
        if (cy - cr < miny) miny = cy - cr
        if (cy + cr > maxy) maxy = cy + cr
        if (cz - cr < minz) minz = cz - cr
        if (cz + cr > maxz) maxz = cz + cr
      }
      childCount++
      singleChild = child
      r2 = subtreeEnd[child]
    }
    if (first) continue
    const o4 = i * 4
    if (childCount === 1) {
      const c4 = singleChild * 4
      sphereW[o4] = sphereW[c4]
      sphereW[o4 + 1] = sphereW[c4 + 1]
      sphereW[o4 + 2] = sphereW[c4 + 2]
      sphereW[o4 + 3] = sphereW[c4 + 3]
      refit++
      continue
    }
    sphereW[o4] = (minx + maxx) * 0.5
    sphereW[o4 + 1] = (miny + maxy) * 0.5
    sphereW[o4 + 2] = (minz + maxz) * 0.5
    sphereW[o4 + 3] = 0.5 * Math.sqrt(
      (maxx - minx) * (maxx - minx) +
      (maxy - miny) * (maxy - miny) +
      (maxz - minz) * (maxz - minz),
    )
    refit++
  }
  views.dirtyBounds.fill(0)
  return refit
}
