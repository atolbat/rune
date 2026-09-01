/**
 * stockham.ts — план проходов GPU БПФ Стокхэма (2·log₂N ping-pong проходов).
 *
 * Зачем в библиотеке: расписание проходов БПФ на ping-pong-текстурах —
 * самая тонкая часть любого FFT-океана (Tessendorf/david.li/waves,
 * jbouny/fft-ocean). Ошибка в паре «читаемая текстура → целевая текстура»
 * на ОДНОМ проходе незаметна в коде и превращает океан в «плоскую кашу с
 * швом посередине» (реальный инцидент Task 114: в WebGL2-порте при
 * log₂N чётном — N=256 — юниформ u_input первого вертикального прохода
 * попадал в другую программу и читалась протухшая текстура).
 *
 * План — ЧИСТЫЕ ДАННЫЕ: бэкенды (WebGL2/WebGPU/симулятор) исполняют его
 * независимо, а инварианты фиксируются юнит-тестами:
 *  1) длины 2·log₂N; горизонтальная ось — первые log₂N проходов;
 *  2) субтрансформ-размеры 2,4,…,N на каждой осе (Стокхэм);
 *  3) ЦЕПОЧКА: каждый проход читает ровно то, что записал предыдущий
 *     (plan[i].input === plan[i-1].target, i ≥ 1) — в т.ч. на стыке
 *     горизонталь→вертикаль;
 *  4) финальный проход пишет displacement;
 *  5) нет прохода, читающего свою же целевую текстуру.
 *
 * DOM-free по построению — как весь @rune/core.
 */

/** Целевая текстура прохода (имена как в david.li/waves). */
export type FftPassTarget = 'pingTransform' | 'pongTransform' | 'displacement'

/** Читаемая текстура прохода. */
export type FftPassInput = 'spectrum' | 'pingTransform' | 'pongTransform'

/** Один проход БПФ Стокхэма. */
export interface FftPass {
  /** Индекс прохода 0..2·log₂N−1. */
  readonly index: number
  /** Куда пишем. */
  readonly target: FftPassTarget
  /** Что читаем. */
  readonly input: FftPassInput
  /** true — горизонтальная ось (первые log₂N проходов). */
  readonly horizontal: boolean
  /** Размер под-трансформа 2^(k+1), k = index mod log₂N. */
  readonly subtransformSize: number
}

/**
 * План проходов БПФ Стокхэма для сетки resolution×resolution.
 * @param resolution степень двойки ≥ 2 (256, 512, 1024, …).
 * @throws Error если resolution — не степень двойки или меньше 2.
 */
export function fftPassPlan(resolution: number): readonly FftPass[] {
  if (!Number.isInteger(resolution) || resolution < 2 || (resolution & (resolution - 1)) !== 0) {
    throw new Error(`rune: fftPassPlan — resolution должен быть степенью двойки ≥ 2 (получено ${resolution})`)
  }
  const iterations = Math.round(Math.log(resolution) / Math.LN2) * 2
  const half = iterations / 2
  const plan: FftPass[] = []
  for (let i = 0; i < iterations; i++) {
    let target: FftPassTarget
    let input: FftPassInput
    if (i === 0) {
      target = 'pingTransform'
      input = 'spectrum'
    } else if (i === iterations - 1) {
      target = 'displacement'
      input = iterations % 2 === 0 ? 'pingTransform' : 'pongTransform'
    } else if (i % 2 === 1) {
      target = 'pongTransform'
      input = 'pingTransform'
    } else {
      target = 'pingTransform'
      input = 'pongTransform'
    }
    plan.push({
      index: i,
      target,
      input,
      horizontal: i < half,
      subtransformSize: Math.pow(2, (i % half) + 1),
    })
  }
  return plan
}
