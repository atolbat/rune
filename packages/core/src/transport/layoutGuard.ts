/**
 * LayoutGuard: классификатор событий ресайза. Три вердикта:
 *  apply   — новый размер, применять
 *  ignore  — дребезг (тот же размер)
 *  runaway — петля A→B→A→B (инцидент DPR: каждый ресайз порождал новый)
 */

export type ResizeVerdict = 'apply' | 'ignore' | 'runaway'

export interface ResizeResult {
  readonly verdict: ResizeVerdict
  readonly cssWidth: number
  readonly cssHeight: number
}

export interface LayoutGuardApi {
  classify(width: number, height: number): ResizeResult
}

const HISTORY = 6

export function createLayoutGuard(): LayoutGuardApi {
  const recent: string[] = []

  function classify(width: number, height: number): ResizeResult {
    const key = `${Math.round(width)}x${Math.round(height)}`
    if (recent.length > 0 && recent[recent.length - 1] === key) {
      return { verdict: 'ignore', cssWidth: width, cssHeight: height }
    }
    recent.push(key)
    if (recent.length > HISTORY) recent.shift()
    if (oscillates()) {
      return { verdict: 'runaway', cssWidth: width, cssHeight: height }
    }
    return { verdict: 'apply', cssWidth: width, cssHeight: height }
  }

  /** Последние 4 события чередуют два размера — петля ресайза. */
  function oscillates(): boolean {
    if (recent.length < 4) return false
    const last4 = recent.slice(-4)
    return last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]
  }

  return { classify }
}
