/**
 * Dynamic geometry (Task 109): feeds that rebuild geometry based on
 * external state (camera/distance) — "CLOD at the level of reworking the
 * geometry". The COMMON CONTRACT of a feed:
 *   • geometry  — the current geometry (the reference is stable between
 *     rebuilds);
 *   • update(…) — check the state; true = the geometry has been rebuilt
 *     (the reference is NEW — re-push the attributes into the render
 *     command);
 *   • rebuilds  — rebuild counter (diagnostics/logging).
 *
 * The integration point with the renderer — hot swapping of command
 * attributes (CompiledCommand.updateAttributes in @rune/gl): the feed
 * returned true → updateAttributes({a_pos, a_normal, a_uv}) + a dynamic
 * count.
 *
 * SSBO perspective: a feed whose geometry is computed ON the GPU (a kernel
 * writes positions into a storage buffer, vertices are pulled from the
 * SSBO in the shader) keeps the same update() contract but does not
 * recreate attributes — it re-launches the dispatch (see DESIGN.md §5.5,
 * "GPU displacement" — the next slice).
 */

import type { Geometry } from './types.ts'

export interface PrimitiveFeedParams {
  /** Level geometry generator: detail multiplier k → Geometry. */
  readonly make: (detailK: number) => Geometry
  /**
   * Level detail multipliers, NEAR → FAR
   * (default [2, 1, 0.5, 0.25]).
   */
  readonly levels?: readonly number[]
  /**
   * Distance thresholds between levels, ascending; length = levels−1
   * (default [3, 6, 12]).
   */
  readonly thresholds?: readonly number[]
  /**
   * Hysteresis against chattering: the level switches "farther" when
   * dist > threshold·(1+h), "closer" when dist < threshold·(1−h)
   * (default 0.15 — like PRESSURE_HYSTERESIS in present).
   */
  readonly hysteresis?: number
}

export interface PrimitiveFeed {
  /** Current level geometry (the reference changes after update() = true). */
  readonly geometry: Geometry
  /** Index of the current level (0 — the most detailed). */
  readonly level: number
  /** Check the distance; true = the level changed, geometry is new. */
  update(dist: number): boolean
  /** Geometry rebuild counter. */
  readonly rebuilds: number
}

/**
 * An LOD feed for ONE primitive: the camera approaching → higher
 * resolution, moving away → lower (rebuild ONLY on level change — not
 * every frame).
 *
 * Hysteresis: within the threshold·(1±h) band the decision sticks — a
 * camera orbit of length near the threshold must not cause a sawtooth of
 * rebuilds.
 */
export function createPrimitiveFeed(params: PrimitiveFeedParams): PrimitiveFeed {
  const levels = params.levels ?? [2, 1, 0.5, 0.25]
  const thresholds = params.thresholds ?? [3, 6, 12]
  const hysteresis = params.hysteresis ?? 0.15
  if (levels.length < 1) throw new Error('rune: prims — the LOD feed requires at least one level')
  if (thresholds.length !== levels.length - 1) {
    throw new Error(`rune: prims — the LOD feed: ${thresholds.length} thresholds, ${levels.length} levels (need levels−1 = ${levels.length - 1})`)
  }
  let level = 0
  let geometry = params.make(levels[0]!)
  let rebuilds = 1
  return {
    get geometry(): Geometry {
      return geometry
    },
    get level(): number {
      return level
    },
    get rebuilds(): number {
      return rebuilds
    },
    update(dist: number): boolean {
      let next = level
      // Moving away: a threshold is crossed UPWARD only with a margin (1+h)
      for (let i = level; i < thresholds.length; i++) {
        if (dist > thresholds[i]! * (1 + hysteresis)) next = i + 1
      }
      // Approaching: a threshold is crossed DOWNWARD only with a margin (1−h)
      for (let i = level - 1; i >= 0; i--) {
        if (dist < thresholds[i]! * (1 - hysteresis)) next = i
      }
      if (next === level) return false
      level = next
      geometry = params.make(levels[level]!)
      rebuilds++
      return true
    },
  }
}
