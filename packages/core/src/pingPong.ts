/**
 * Ping-pong — паттерн двойного буфера (Task 112).
 *
 * Полезный паттерн GPU-симуляций, вынесенный из FFT-океана в ядро
 * (пользовательское решение Task 112: FFT — в kit, паттерны — в core).
 * Пользователи: эволюция фаз океана (ping-pong текстур), проходы БПФ
 * Стокхэма (ping-pong спектра), пост-процесс цепочки, feedback-эффекты —
 * везде «читаем из одного буфера, пишем в другой, меняем местами».
 *
 * Семантика:
 *  • current — тот, из которого ЧИТАЮТ на текущем шаге;
 *  • previous — тот, в который ПИСАЛИ на предыдущем шаге (куда писать
 *    обычно решает сам вызывающий через swap());
 *  • swap() — атомарно (одним присваиванием каждой ссылки) меняет пары
 *    местами и возвращает НОВЫЙ current (удобно в цикле проходов).
 */

export interface PingPong<A, B = A> {
  /** Буфер текущего шага (источник чтения). */
  readonly current: A
  /** Буфер предыдущего шага. */
  readonly previous: B
  /** Поменять местами; возвращает новый current (пост-swap). */
  swap(): A
  /** Индекс шага (число swap-ов по модулю 2): 0 = начальная раскладка,
   *  1 = после первого swap. Для parity-логики (как в БПФ: вход/выход
   *  зависит от чётности номера прохода). */
  readonly parity: 0 | 1
}

/** Создать ping-pong пару из двух буферов. */
export function createPingPong<A, B = A>(initial: A, other: B): PingPong<A, B> {
  let current: A = initial
  let previous: B = other
  let swaps = 0
  return {
    get current(): A {
      return current
    },
    get previous(): B {
      return previous
    },
    get parity(): 0 | 1 {
      return (swaps & 1) as 0 | 1
    },
    swap(): A {
      const next = previous as unknown as A
      previous = current as unknown as B
      current = next
      swaps++
      return current
    },
  }
}
