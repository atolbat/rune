/**
 * culling.ts — отсечение по фрустуму (Task 81).
 *
 * Иерархический вариант пользуется главным следствием preorder-раскладки:
 * поддерево узла — НЕПРЕРЫВНЫЙ диапазон рангов [r, subtreeEnd[slot)),
 * поэтому:
 *   • тривиальный отказ  (сфера целиком вне)   — очистка диапазона слов
 *     битсета без обхода детей;
 *   • тривиальный приём  (сфера целиком внутри) — заливка диапазона единицами
 *     без единого теста детей;
 *   • пересечение — спуск только в детей (каждый ребёнок — снова диапазон).
 *
 * Внутренний узел без границ (r ≤ 0, «неизвестный объём») никогда не
 * отсекается и не принимается тривиально — только спуск (безопасно всегда).
 *
 * Битсеты — в ранговом пространстве; потребитель джойнится через order[rank].
 * Brute-вариант (тест каждой сферы) — эталон корректности и basePath для
 * маленьких/плоских сцен: бенчмарк решает, что выгоднее.
 */
import type { SceneViews } from './layout.ts'
import { H_NODE_COUNT, NF_VISIBLE } from './layout.ts'

/** Внутренняя мутабельная статистика (out-запись — без аллокаций на кадр). */
export interface MutableCullStats {
  tested: number
  visible: number
  trivialRejects: number
  trivialAccepts: number
  planeTests: number
}

/** Статистика одного прохода отсечения. */
export interface CullStats {
  /** Сфер протестировано. */
  readonly tested: number
  /** Рангов признано видимыми (биты установлены). */
  readonly visible: number
  /** Поддеревьев отсечено целиком. */
  readonly trivialRejects: number
  /** Поддеревёв принято целиком. */
  readonly trivialAccepts: number
  /** Реальных тестов «сфера×плоскость» (Task 85: с масками их меньше tested×6). */
  readonly planeTests: number
}

/** Скретч-стек диапазонов (растёт геометрически, вне горячих вызовов).
 * Записи — ТРОЙКИ (rankStart, rankEnd, planeMask): Task 85 — маски
 * плоскостей наследуются вниз по охватывающим сферам. */
let rangeStack = new Int32Array(8192)

function pushRange(s: number, e: number, mask: number, sp: number): number {
  if (sp + 3 > rangeStack.length) {
    const grown = new Int32Array(rangeStack.length * 2)
    grown.set(rangeStack)
    rangeStack = grown
  }
  rangeStack[sp] = s
  rangeStack[sp + 1] = e
  rangeStack[sp + 2] = mask
  return sp + 3
}

/** Заливка битсета в диапазоне рангов [s, e). */
export function fillBits(bits: Uint32Array, base: number, s: number, e: number, on: boolean): void {
  if (e <= s) return
  const sWord = s >>> 5
  const eWord = (e - 1) >>> 5
  if (sWord === eWord) {
    const count = e - s
    const mask = (count >= 32 ? 0xffffffff : (1 << count) - 1) << (s & 31)
    if (on) bits[base + sWord] |= mask
    else bits[base + sWord] &= ~mask
    return
  }
  // Голова.
  const sOff = s & 31
  if (sOff !== 0) {
    const mask = ((1 << (32 - sOff)) - 1) << sOff // биты sOff..31
    if (on) bits[base + sWord] |= mask
    else bits[base + sWord] &= ~mask
  } else {
    bits[base + sWord] = on ? 0xffffffff : 0
  }
  // Полные слова между.
  for (let w = sWord + 1; w < eWord; w++) {
    bits[base + w] = on ? 0xffffffff : 0
  }
  // Хвост.
  const eOff = e & 31
  if (eOff !== 0) {
    const mask = (1 << eOff) - 1
    if (on) bits[base + eWord] |= mask
    else bits[base + eWord] &= ~mask
  } else {
    bits[base + eWord] = on ? 0xffffffff : 0
  }
}

/** Популяция битсета (для статистики). */
export function popcountBits(bits: Uint32Array, base: number, words: number): number {
  let count = 0
  for (let w = 0; w < words; w++) {
    let v = bits[base + w]
    while (v !== 0) {
      v &= v - 1
      count++
    }
  }
  return count
}

/** База битсета камеры в буфере b. */
export function bitsBase(views: SceneViews, bufferIndex: number, cameraIndex: number): number {
  return (bufferIndex * views.cameraMax + cameraIndex) * views.bitsWords
}

/** Видимость ранга (хелпер для потребителей и тестов). */
export function isVisibleRank(
  views: SceneViews,
  bufferIndex: number,
  cameraIndex: number,
  rank: number,
): boolean {
  const base = bitsBase(views, bufferIndex, cameraIndex)
  return (views.bits[base + (rank >>> 5)] & (1 << (rank & 31))) !== 0
}

/**
 * Иерархическое отсечение камеры cameraIndex в буфер bufferIndex (0/1).
 * Требует свежие сферы (updateWorld + refitGroupBounds) и pack().
 *
 * Task 85 — ПЛОСКОСТНЫЕ МАСКИ (Assarsson–Möller): маска = биты плоскостей,
 * которые узлу ещё надо тестировать. Плоскость ВЫБЫВАЕТ из маски детей,
 * только если ОХВАТЫВАЮЩАЯ сфера родителя целиком внутри неё — тогда весь
 * родительский поддерево внутри этой плоскости, детям она не нужна.
 * Узлы «неизвестного объёма» (r ≤ 0) маску не сужают (их сфера ничего не
 * говорит о детях) — маска детям наследуется как есть. На глубоких деревьях
 * это 6 → ~2 теста плоскостей на узел при том же битсете результата
 * (паритет с brute — тесты свойств в culling.test.ts).
 */
export function cullViewsHierarchical(
  views: SceneViews,
  cameraIndex: number,
  bufferIndex: number,
  out?: MutableCullStats,
  masks: boolean = true,
): CullStats {
  const n = views.headerI[H_NODE_COUNT]
  const { order, parent, subtreeEnd, sphereW, bits, planes } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const pb = cameraIndex * 24

  // Корни леса: диапазоны поддеревьев + полная маска (наверху — все 6).
  let sp = 0
  function splitChildren(s: number, e: number, mask: number): void {
    let r2 = s + 1
    while (r2 < e) {
      const child = order[r2]
      const childEnd = subtreeEnd[child]
      const end = childEnd > r2 ? childEnd : r2 + 1
      sp = pushRange(r2, end, mask, sp)
      r2 = end
    }
  }
  for (let r = 0; r < n; ) {
    const slot = order[r]
    const end = subtreeEnd[slot]
    if (parent[slot] < 0 && end > r) {
      sp = pushRange(r, end, 0x3f, sp)
      r = end
    } else {
      r++
    }
  }

  let tested = 0
  let trivialRejects = 0
  let trivialAccepts = 0
  let planeTests = 0
  while (sp > 0) {
    sp -= 3
    const s = rangeStack[sp]
    const e = rangeStack[sp + 1]
    const mask = rangeStack[sp + 2]
    const slot = order[s]
    const leaf = e === s + 1
    const o4 = slot * 4
    const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2]
    const r = sphereW[o4 + 3]
    // Сфера охватывает поддерево: лист (сам и есть поддерево) либо r > 0
    // (пользовательская или refit-граница). r ≤ 0 у внутреннего узла —
    // «неизвестный объём»: спускаемся всегда, бит — по точке (как brute).
    const enclosing = leaf || r > 0
    tested++

    let outside = false
    let insideAll = true
    let interMask = 0
    let m = mask
    while (m !== 0) {
      const pbIdx = m & -m
      const i = 31 - Math.clz32(pbIdx) // индекс плоскости из бита
      m ^= pbIdx
      const o = pb + i * 4
      planeTests++
      const d = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3]
      if (d < -r) {
        outside = true
        break
      }
      if (d < r) {
        interMask |= pbIdx
        insideAll = false
      }
    }

    if (outside) {
      if (enclosing) {
        fillBits(bits, base, s, e, false)
        trivialRejects++
      } else {
        // Точка узла снаружи, но дети могут выступать в вид — только свой бит.
        bits[base + (s >>> 5)] &= ~(1 << (s & 31))
        splitChildren(s, e, mask)
      }
      continue
    }
    if (insideAll && enclosing) {
      // Полностью внутри: дети тоже (охватывающая сфера) — заливка диапазона.
      fillBits(bits, base, s, e, true)
      trivialAccepts++
      continue
    }
    // Пересечение (или неизвестный объём): узел видим, спуск в детей.
    // Маска детей: охватывающая сфера — только пересечённые плоскости;
    // неизвестный объём — маска как есть (сужать нечем).
    // masks=false — A/B-режим «до Task 85»: маска не сужается, узлы ниже
    // тестируют все 6 плоскостей (результат идентичен — только дороже).
    bits[base + (s >>> 5)] |= 1 << (s & 31)
    if (!leaf) splitChildren(s, e, masks && enclosing ? interMask : mask)
  }

  if (out !== undefined) {
    out.tested = tested
    out.visible = popcountBits(bits, base, views.bitsWords)
    out.trivialRejects = trivialRejects
    out.trivialAccepts = trivialAccepts
    out.planeTests = planeTests
    return out
  }
  return { tested, visible: popcountBits(bits, base, views.bitsWords), trivialRejects, trivialAccepts, planeTests }
}

/**
 * Brute-отсечение: тест каждой сферы независимо (эталон + плоские сцены).
 * Корректно без групповых границ — сфера узла не влияет на детей.
 */
export function cullViewsBrute(
  views: SceneViews,
  cameraIndex: number,
  bufferIndex: number,
  out?: MutableCullStats,
): CullStats {
  const n = views.headerI[H_NODE_COUNT]
  const { order, sphereW, bits, planes } = views
  const base = bitsBase(views, bufferIndex, cameraIndex)
  const pb = cameraIndex * 24
  let visible = 0
  let planeTests = 0

  for (let r = 0; r < n; r++) {
    const slot = order[r]
    const o4 = slot * 4
    const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2]
    const rad = sphereW[o4 + 3]
    let vis = true
    for (let i = 0; i < 6; i++) {
      planeTests++
      const o = pb + i * 4
      if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] < -rad) {
        vis = false
        break
      }
    }
    const w = base + (r >>> 5)
    const m = 1 << (r & 31)
    if (vis) {
      bits[w] |= m
      visible++
    } else {
      bits[w] &= ~m
    }
  }

  if (out !== undefined) {
    out.tested = n
    out.visible = visible
    out.trivialRejects = 0
    out.trivialAccepts = 0
    out.planeTests = planeTests
    return out
  }
  return { tested: n, visible, trivialRejects: 0, trivialAccepts: 0, planeTests }
}

/**
 * Пост-фильтр «узел скрыт»: бит видимости узла учитывает NF_VISIBLE.
 * Возвращает false, если бит стоит, но узел выключен (потребителям,
 * которым нужен точный итог без отдельной проверки флагов).
 */
export function rankNodeVisible(views: SceneViews, rank: number): boolean {
  const slot = views.order[rank]
  return slot >= 0 && (views.nodeFlags[slot] & NF_VISIBLE) !== 0
}
