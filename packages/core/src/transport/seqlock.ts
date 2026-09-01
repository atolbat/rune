/**
 * Seqlock поверх SharedArrayBuffer.
 * Единственный писатель; читатели — без блокировок, tearing исключён.
 * Раскладку слота (где версия, где значение) задаёт вызывающий код.
 */

/** Результат валидного чтения слота. */
export interface SeqlockRead {
  readonly version: number
  readonly value: number
}

/** Читает слот с валидацией: повтор при нечётной версии и при смене по ходу чтения. */
export function readSeqlock(data: DataView, versionAt: number, valueAt: number): SeqlockRead {
  for (;;) {
    const before = data.getUint32(versionAt, true)
    if ((before & 1) === 0) {
      const value = data.getFloat64(valueAt, true)
      const after = data.getUint32(versionAt, true)
      if (before === after) return { version: before, value }
    }
  }
}

/** Пишет слот: версия нечётная → значение → версия чётная. */
export function writeSeqlock(data: DataView, versionAt: number, valueAt: number, value: number): void {
  const version = data.getUint32(versionAt, true)
  data.setUint32(versionAt, version + 1, true) // вход писателя: нечётная
  data.setFloat64(valueAt, value, true)
  data.setUint32(versionAt, version + 2, true) // выход: чётная
}

/** Текущая версия слота без чтения значения. */
export function seqlockVersion(data: DataView, versionAt: number): number {
  return data.getUint32(versionAt, true)
}
