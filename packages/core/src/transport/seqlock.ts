/**
 * Seqlock поверх SharedArrayBuffer.
 * Единственный писатель; читатели — без блокировок, tearing исключён.
 * Раскладку слота (где версия, где значение) задаёт вызывающий код.
 *
 * Версия читается/пишется через Atomics (SeqCst): порядок «нечётная версия
 * → значение → чётная версия» не разворачивается слабой памятью (ARM).
 * Значение остаётся в DataView — атомарность ему не нужна, его прикрывает
 * версия. Чтение ограничено лимитом попыток: зависший писатель (баг)
 * заканчивается ошибкой, а не вечным спином.
 */

/** Результат валидного чтения слота. */
export interface SeqlockRead {
  readonly version: number
  readonly value: number
}

/** Предел попыток чтения: живой писатель закрывает слот за наносекунды;
 *  65 536 повторов — это миллисекунды спина, дальше подозрение на livelock. */
const MAX_READ_ATTEMPTS = 1 << 16

/** Кэш Int32Array-представлений: версия обязана ходить через Atomics. */
const atomicsViews = new WeakMap<DataView, Int32Array>()

/** Int32Array поверх того же буфера, что и DataView (4-байтовое выравнивание). */
function atomicsView(data: DataView): Int32Array {
  let view = atomicsViews.get(data)
  if (view === undefined) {
    if (data.byteOffset % 4 !== 0 || data.byteLength % 4 !== 0) {
      throw new Error('rune: seqlock требует 4-байтового выравнивания буфера')
    }
    view = new Int32Array(data.buffer, data.byteOffset, data.byteLength >> 2)
    atomicsViews.set(data, view)
  }
  return view
}

/** Индекс версии в Int32Array: смещение обязано быть кратно 4. */
function versionIndex(versionAt: number): number {
  if ((versionAt & 3) !== 0) throw new Error('rune: seqlock-версия обязана лежать на 4-байтовой границе')
  return versionAt >> 2
}

/** Читает слот с валидацией: повтор при нечётной версии и при смене по ходу чтения. */
export function readSeqlock(data: DataView, versionAt: number, valueAt: number): SeqlockRead {
  const i32 = atomicsView(data)
  const at = versionIndex(versionAt)
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
    const before = Atomics.load(i32, at)
    if ((before & 1) === 0) {
      const value = data.getFloat64(valueAt, true)
      const after = Atomics.load(i32, at)
      if (before === after) return { version: before, value }
    }
  }
  throw new Error('rune: seqlock не закрылся за предел попыток — писатель держит слот (livelock)')
}

/** Пишет слот: версия нечётная → значение → версия чётная. */
export function writeSeqlock(data: DataView, versionAt: number, valueAt: number, value: number): void {
  const i32 = atomicsView(data)
  const at = versionIndex(versionAt)
  const version = Atomics.load(i32, at)
  Atomics.store(i32, at, version + 1) // вход писателя: нечётная
  data.setFloat64(valueAt, value, true)
  Atomics.store(i32, at, version + 2) // выход: чётная
}

/** Текущая версия слота без чтения значения. */
export function seqlockVersion(data: DataView, versionAt: number): number {
  return Atomics.load(atomicsView(data), versionIndex(versionAt))
}
