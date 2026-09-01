// Производный сигнал: пересчитывается, когда версии зависимостей ушли вперёд.
// Семантика подписки — PUSH: при изменении зависимости производный со
// подписчиками пересчитывается сразу (вне batch — немедленно, внутри —
// на границе кадра через schedule). Без подписчиков пересчёт ЛЕНИВЫЙ:
// первая же читка .value увидит новый stamp и пересчитает (глава досье
// «реактивность без eager-шторма»).

import { popCollector, pushCollector, reportRead } from './tracking.ts'
import type { SignalCell } from './signal.ts'
import type { Unsubscribe } from './types.ts'

export interface DerivedSignal<T> {
  get value(): T
  peek(): T
  subscribe(fn: (value: T) => void): () => void
  readonly version: number
}

export function derive<T>(compute: () => T): DerivedSignal<T> {
  let deps: SignalCell<unknown>[] = []
  let cached = collect()
  let cachedStamp = stamp()
  const subscribers = new Set<(value: T) => void>()
  let unsubscribes: Unsubscribe[] = []

  /** Пересчитать, собрав зависимости через стек трекинга. */
  function collect(): T {
    deps = []
    pushCollector(deps)
    const next = compute()
    popCollector()
    return next
  }

  /** Сумма версий зависимостей — дешёвый «снимок» чистоты. */
  function stamp(): number {
    let sum = 0
    for (const dep of deps) sum += (dep as SignalCell<unknown>).version
    return sum
  }

  /** Подписаться на каждую текущую зависимость (после collect). */
  function rebind(): void {
    for (const unsubscribe of unsubscribes) unsubscribe()
    unsubscribes = deps.map(dep =>
      dep.subscribe(() => {
        // Push-путь включён только при наличии подписчиков; иначе лениво.
        if (subscribers.size > 0) revalidate()
      }),
    )
  }

  function revalidate(): boolean {
    if (stamp() === cachedStamp) return false
    const previous = cached
    cached = collect()
    cachedStamp = stamp()
    rebind()
    if (cached !== previous && subscribers.size > 0) {
      // Снимок подписчиков: колбэк может отписаться или (через derive-цепочку)
      // переподписать зависимости — итерируем копию (см. signal.ts).
      for (const fn of [...subscribers]) fn(cached)
    }
    return true
  }

  const derived: DerivedSignal<T> = {
    get value() {
      revalidate()
      reportRead(derived)
      return cached
    },
    peek: () => {
      revalidate()
      return cached
    },
    subscribe(fn: (value: T) => void): (() => void) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    get version() {
      revalidate()
      return cachedStamp
    },
  }
  rebind()
  return derived
}
