/**
 * groupBounds.ts — the GROUP-SPHERE cache (Task 191 N4 state, extracted for
 * Task 193 so BOTH consumers share it: the collect's pre-reject (instances.ts)
 * and the cull's TAIL SEGMENT CLASSIFICATION (culling.ts — the Task-193
 * theory B). culling.ts cannot import instances.ts (instances imports
 * culling for bitsBase) — the state had to live one level below both.
 *
 * A group's bounding sphere = the minimal-ish sphere enclosing the group
 * SEGMENT members' world spheres (an AABB pass + a radius pass — the
 * Task-189 dossier's shape; O(|g|) over the tail segment, O(n) in the
 * legacy layout). The cache is per scene (a WeakMap keyed by the views
 * object — the Task-190 lesson: module-level arrays collide across scenes)
 * and maintained INCREMENTALLY through the Task-85 stamp discipline:
 *   • a member's sphereW changes — updateWorld already stamped groupTouch
 *     of that member's group (sphereW is RECOMPUTED there);
 *   • a composition change — Task 191 makes setGroup stamp the OLD and the
 *     NEW group;
 *   • a grouped INTERNAL node's auto-bound changes — Task 191 makes the
 *     refit stamp that group (the combine rewrites sphereW). Internal
 *     nodes are not segment members, but the stamp keeps the discipline
 *     uniform (an extra rebuild is only a fee, never a correctness issue).
 * A stale sphere can only ever be an OVER-estimate (destroyed members) —
 * still enclosing, still sound; an UNDER-estimate (a member created
 * without an updateWorld pass) is outside the "fresh spheres" cull
 * contract documented in culling.ts.
 *
 * SOUNDNESS DOMAIN (the documented contract, same family as Task 190/191):
 * the spheres reason about bits PRODUCED BY A REAL CULL over the same
 * sphereW/planes — the pipeline contract. Raw `views.sphereW[i] = …` hacks
 * bypass every stamp in this family and are outside every consumer's
 * domain (the Task-186 property fixture writes bits directly — it runs
 * under the kill-switches).
 */

import type { SceneViews } from './layout.ts'
import { H_GROUP_COUNT, H_NODE_COUNT, tailLayoutOn } from './layout.ts'

/** Task 191 — the state: groupMax × 4 floats + the built stamps. */
export interface GroupSphereState {
  /** groupMax × 4: (cx, cy, cz, r); r ≤ 0 — empty/unknown, never classify. */
  readonly spheres: Float32Array
  /** Per group: the groupTouch stamp the sphere covers (−1 — never built). */
  readonly built: Int32Array
}

const groupSpheres = new WeakMap<SceneViews, GroupSphereState>()

/** The per-scene state (lazily allocated once — the Task-190 WeakMap lesson). */
export function groupSpheresFor(views: SceneViews): GroupSphereState {
  let state = groupSpheres.get(views)
  if (state === undefined) {
    state = {
      spheres: new Float32Array(views.groupMax * 4),
      built: new Int32Array(views.groupMax).fill(-1),
    }
    groupSpheres.set(views, state)
  }
  return state
}

/** Task 191's honest build counter (re-exported through groupSphereCounters). */
let sphereBuilds = 0

/** The number of sphere builds since load (diagnostics/tests). */
export function groupSphereBuildCount(): number {
  return sphereBuilds
}

/** Builds group g's sphere: the segment's rank range with the tail layout
 * (O(|g|) — the Task-189 dossier's segment-sphere win; the sphere encloses
 * exactly what the SEGMENT scan can collect, so the consumers stay sound in
 * both modes); the full O(n) rank walk otherwise (Task 191). */
export function buildGroupSphere(views: SceneViews, g: number): void {
  const n = views.headerI[H_NODE_COUNT]
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
  const { order, group, sphereW, groupTouch } = views
  const state = groupSpheresFor(views)
  const o4g = g * 4
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  let count = 0
  const useSegment = tailLayoutOn() && g >= 0 && g < groupCount
  const segFrom = useSegment ? views.gStart[g] : 0
  const segTo = useSegment ? views.gStart[g + 1] : n
  for (let r = segFrom; r < segTo; r++) {
    const slot = order[r]
    if (!useSegment && group[slot] !== g) continue
    const o4 = slot * 4
    const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2], rad = sphereW[o4 + 3]
    const x0 = cx - rad, x1 = cx + rad, y0 = cy - rad, y1 = cy + rad, z0 = cz - rad, z1 = cz + rad
    if (x0 < minX) minX = x0
    if (x1 > maxX) maxX = x1
    if (y0 < minY) minY = y0
    if (y1 > maxY) maxY = y1
    if (z0 < minZ) minZ = z0
    if (z1 > maxZ) maxZ = z1
    count++
  }
  if (count === 0) {
    state.spheres[o4g + 3] = -1 // empty — never classify (the scan is cheap)
  } else {
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5
    let radius = 0
    for (let r = segFrom; r < segTo; r++) {
      const slot = order[r]
      if (!useSegment && group[slot] !== g) continue
      const o4 = slot * 4
      const dx = sphereW[o4] - cx, dy = sphereW[o4 + 1] - cy, dz = sphereW[o4 + 2] - cz
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + sphereW[o4 + 3]
      if (d > radius) radius = d
    }
    state.spheres[o4g] = cx
    state.spheres[o4g + 1] = cy
    state.spheres[o4g + 2] = cz
    state.spheres[o4g + 3] = radius
  }
  state.built[g] = groupTouch[g]
  sphereBuilds++
}
