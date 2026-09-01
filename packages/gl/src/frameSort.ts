/**
 * frameSort.ts — Task 86: сортировка записей кадра по ключу состояния;
 * Task 87 — ПОЛНОСТЬЮ БЕЗ АЛЛОКАЦИЙ (убраны Array.from().sort(cmp),
 * которые резали массив на каждый вызов — 4 вызова/кадр).
 *
 * «Рендер с меньшими переключениями внутренних состояний» — классика
 * (Funkhouser/Woo, индустриальные рендереры): каждая draw-запись получает
 * 40-битный сортировочный ключ, кадр сортируется по нему, соседние записи
 * переиспользуют состояние.
 *
 * Ключ (старшие биты доминируют, сравнение — простым числом):
 *
 *   [39..36] pass     — порядок композиции кадра: opaque(0) → sky(1) →
 *                       mirror(2) → transparent(3) → overlay(4).
 *                       Прозрачное — ПОСЛЕ опаков и строго back-to-front;
 *                       зеркала — после неба (небо видно в зеркале), но до
 *                       прозрачных (вода поверх зеркала блендится).
 *   [35..28] pipeline — шейдер-рецепт: смена программы — самое дорогое
 *                       переключение, минимизируется первым.
 *   [27..16] depth    — видовая глубина, корзина 0..4095:
 *                       opaque — ВОЗРАСТАЕТ (front-to-back, early-Z: ближние
 *                       закрывают дальние, их фрагменты отсекаются по
 *                       depth-тесту ДО шейдинга); transparent — УБЫВАЕТ
 *                       (back-to-front корректный блендинг; инверсия —
 *                       внутри packFrameKey по тегу пасса).
 *   [15..8]  mesh     — набор буферов (VAO): с VAO смена геометрии — один
 *                       bindVertexArray, поэтому глубина СТАРШЕ меша
 *                       (ранний-Z ценнее экономии одного бинда).
 *   [7..0]   sequence — стабильный биас: равные ключи сохраняют порядок
 *                       вставки.
 *
 * Сортировка (Task 87, «реаллокаций нет»):
 *   • n ≤ 64 — бинарная вставка на Int32Array-скретчах (демо: 11–20 записей
 *     на поверхность — этот путь всегда);
 *   • n > 64 — LSD-радикс 6 цифр (8 бит × 5 + 4 бита пасса) считающей
 *     сортировкой по Float64-ключам, скретчи растут геометрически и живут
 *     между кадрами. Оба пути СТАБИЛЬНЫ (равные ключи — порядок вставки).
 *
 * Оценка глубины — ответственность сабмиттера (центроид границ группы,
 * центр уникального меша); квантование — quantizeDepth().
 */

/** Пасс кадра (порядок = RENDER_PASS_ORDER из @rune/scene). */
export type FramePass = 'opaque' | 'sky' | 'mirror' | 'transparent' | 'overlay'

const PASS_INDEX: Readonly<Record<FramePass, number>> = {
  opaque: 0,
  sky: 1,
  mirror: 2,
  transparent: 3,
  overlay: 4,
}

/** Глубинных корзин (12 бит). */
export const DEPTH_BUCKETS = 4096

/** Квантовать видовую глубину (0..maxDepth → корзина 0..4095). */
export function quantizeDepth(viewDepth: number, maxDepth: number): number {
  if (!(viewDepth > 0)) return 0
  const b = Math.round((viewDepth / Math.max(1e-6, maxDepth)) * (DEPTH_BUCKETS - 1))
  return b < 0 ? 0 : b >= DEPTH_BUCKETS ? DEPTH_BUCKETS - 1 : b
}

/** Запись кадра: команда/захват + классификация состояния. */
export interface FrameEntry<C> {
  readonly cmd: C
  readonly pass: FramePass
  /** Класс пайплайна (шейдер-рецепт): 0..255. */
  readonly pipeline: number
  /** Глубинная корзина (quantizeDepth): near=0. Инверсия для transparent —
   *  внутри packFrameKey. */
  readonly depth: number
  /** Класс меша (набор буферов/VAO): 0..255. */
  readonly mesh: number
}

/** Упаковать ключ записи (40 бит, безопасно для number). */
export function packFrameKey(entry: FrameEntry<unknown>, sequence: number): number {
  const depth = entry.pass === 'transparent'
    ? (DEPTH_BUCKETS - 1) - (entry.depth & 0xfff) // back-to-front: дальние раньше
    : entry.depth & 0xfff
  return (
    ((PASS_INDEX[entry.pass] & 0xf) * 0x10000000000) +
    ((entry.pipeline & 0xff) * 0x100000000) +
    (depth * 0x10000) +
    ((entry.mesh & 0xff) * 0x100) +
    (sequence & 0xff)
  )
}

/** Ниже этого размера вставочная сортировка быстрее радикса (нет проходов
 *  по счётчикам): демо-размеры (≤ 20 записей) всегда попадают сюда. */
const INSERTION_THRESHOLD = 64

/**
 * Отсортировать первые count записей в порядок композиции/минимальных
 * переключений. Стабильно: равные ключи сохраняют порядок вставки.
 * АЛЛОКАЦИЙ НЕТ: скретчи переиспользуются между кадрами (геометрический
 * рост), записи читаются напрямую (пул записей передаётся с явным count —
 * без slice/subarray). out — переиспользуемый массив команд.
 */
export function sortFrameEntries<C>(
  entries: ReadonlyArray<FrameEntry<C>>,
  out: C[],
  count: number = entries.length,
): C[] {
  const n = count
  if (n <= 0) return out
  const keys = sortKeysScratch(n)
  const order = sortOrderScratch(n)
  for (let i = 0; i < n; i++) {
    keys[i] = packFrameKey(entries[i]!, i)
    order[i] = i
  }
  if (n <= INSERTION_THRESHOLD) insertionSort(keys, order, n)
  else radixSort(keys, order, n)
  for (let i = 0; i < n; i++) out[i] = entries[order[i] as number]!.cmd
  return out
}

// ─── Скретчи (без GC-чреджа на кадр) ────────────────────────────────────────

let keysScratch = new Float64Array(64)
let orderScratch = new Int32Array(64)
let radixScratch = new Int32Array(64)
const radixCounts = new Int32Array(256)

function sortKeysScratch(n: number): Float64Array {
  if (keysScratch.length < n) keysScratch = new Float64Array(Math.max(64, n * 2))
  return keysScratch
}

function sortOrderScratch(n: number): Int32Array {
  if (orderScratch.length < n) orderScratch = new Int32Array(Math.max(64, n * 2))
  return orderScratch
}

/**
 * Стабильная бинарная вставка: (ключ, индекс) — индекс разрешает ничьи.
 * Работает на месте в Int32Array-порядке; ключи сравниваются напрямую.
 */
function insertionSort(keys: Float64Array, order: Int32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const key = keys[i]!
    const idx = order[i]!
    // позиция вставки в [0..i] — первый j с keys[j] > key (строгое
    // неравенство = стабильность: равные остаются в порядке индексов)
    let lo = 0
    let hi = i
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (keys[mid]! <= key) lo = mid + 1
      else hi = mid
    }
    for (let j = i; j > lo; j--) {
      keys[j] = keys[j - 1]!
      order[j] = order[j - 1]!
    }
    keys[lo] = key
    order[lo] = idx
  }
}

/** Делители цифр радикса: 6×8 бит — покрывает весь 40-битный ключ (старшая
 *  цифра — только биты пасса, ключ < 2^43). Чётное число проходов —
 *  результат возвращается в исходный order без копирования. */
const RADIX_DIGITS = [1, 256, 65536, 16777216, 4294967296, 1099511627776] as const

/**
 * Стабильный LSD-радикс по 40-битному ключу: 6×8-битных цифр, считающая
 * сортировка цифры за проход — стабильна по построению.
 */
function radixSort(keys: Float64Array, order: Int32Array, n: number): void {
  if (radixScratch.length < n) radixScratch = new Int32Array(Math.max(64, n * 2))
  let src: Int32Array = order
  let dst: Int32Array = radixScratch
  for (let d = 0; d < RADIX_DIGITS.length; d++) {
    const div = RADIX_DIGITS[d]!
    radixCounts.fill(0)
    // счётчики цифр
    for (let i = 0; i < n; i++) {
      const digit = Math.floor(keys[src[i] as number]! / div) & 0xff
      radixCounts[digit]++
    }
    // эксклюзивные префиксы
    let sum = 0
    for (let b = 0; b < 256; b++) {
      const c = radixCounts[b]!
      radixCounts[b] = sum
      sum += c
    }
    // устойчивое раскладывание
    for (let i = 0; i < n; i++) {
      const s = src[i] as number
      const digit = Math.floor(keys[s]! / div) & 0xff
      dst[radixCounts[digit]! as number] = s
      radixCounts[digit] = radixCounts[digit]! + 1
    }
    const t = src
    src = dst
    dst = t
  }
  // после чётного числа проходов результат — в исходном order
  if (src !== order) order.set(src.subarray(0, n))
}
