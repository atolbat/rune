/**
 * LayoutGuard: a resize event classifier. Three verdicts:
 *  apply   — new size, apply it
 *  ignore  — debounce (the same size)
 *  runaway — an A→B→A→B loop (the DPR incident: each resize spawned a new one)
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

  /** The last 4 events alternate between two sizes — a resize loop. */
  function oscillates(): boolean {
    if (recent.length < 4) return false
    const last4 = recent.slice(-4)
    return last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]
  }

  return { classify }
}
