// Ячейка-сигнал: значение + версия (для dirty-проверок) + подписчики.
// Уведомления — через schedule() из batch.ts: вне batch мгновенно,
// внутри batch/epoch.frame — один раз на выходе (§9.11.2: пуш в signal
// внутри кадра → реактивные derive получают согласованное состояние).

import { reportRead } from './tracking.ts'
import { schedule } from './batch.ts'

export interface SignalOptions {
  /** Имя для диагностики. */
  readonly name?: string
}

export interface SignalCell<T> {
  get value(): T
  set value(next: T)
  peek(): T
  subscribe(fn: (value: T) => void): () => void
  /** Монотонный счётчик записей — основа dirty-проверок live-команд. */
  readonly version: number
}

export function signal<T>(initial: T, _options: SignalOptions = {}): SignalCell<T> {
  let current = initial
  let version = 0
  const subscribers = new Set<(value: T) => void>()

  function subscribe(fn: (value: T) => void): () => void {
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  const cell: SignalCell<T> = {
    get value() {
      reportRead(cell)
      return current
    },
    set value(next: T) {
      if (next === current) return
      current = next
      version++
      // Значение фиксируется на момент записи: подписчик видит то, что
      // записали, даже если за время batch ячейку переписали снова
      // (каждая запись планирует своё уведомление — эффекты дедуплицируются
      // на своём уровне, см. EffectCell.queueRerun).
      const snapshot = current
      schedule(() => {
        // Снимок: подписчик может отписаться/переподписаться (effect rebind,
        // derive rebind) прямо в колбэке — мутация живого Set во время
        // итерации вместе с синхронным schedule даёт живоблок.
        for (const fn of [...subscribers]) fn(snapshot)
      })
    },
    peek: () => current,
    subscribe,
    get version() { return version },
  }
  return cell
}
