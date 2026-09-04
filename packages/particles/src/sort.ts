/**
 * @rune/particles — the DEPTH SORT (Task 132): the painter's order for
 * alpha-blended layers.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY: an alpha-blended layer composited in slot order draws a NEAR
 * particle UNDER a FAR one whenever the near one's slot is lower — the
 * classic "the bright impact card shines through the smoke in front of
 * it" artifact. The fix is the painter's algorithm: draw the FAR
 * particles first, the NEAR ones last, and each sprite blends over
 * everything behind it. Additive layers do not need it (the blend is
 * commutative) — sorting them only costs CPU time.
 *
 * THE KEY: depth = dot(forward, position) — the camera basis's forward
 * (the unit direction the camera LOOKS, toward the target) is passed to
 * view() by the caller already (it orients the billboards). The dot
 * product grows monotonically with the view-axis depth, so a camera-
 * consistent ordering needs no eye position, no matrices, and no
 * per-particle sqrt.
 *
 * THE ORDER: BACK TO FRONT — the key DESCENDING (the farthest particle
 * first). The sorted index list feeds `order` of packInstances() /
 * fillBillboards() (both bakers then emit particles in exactly this
 * order — the soup's quad stream and the instance-record stream get the
 * IDENTICAL sequence, the backend-parity contract).
 *
 * DETERMINISM: the comparator breaks ties by the slot index (a total
 * order), so the sequence is engine-independent — the same store state
 * and camera basis produce the same draw order on every backend, every
 * engine, every run. The sort is in-place on caller-owned scratch
 * (an Int32Array of capacity for the indices, a Float32Array for the
 * keys): ZERO allocations per frame.
 *
 * NOT FOR: the GPU sim tier (the records are packed GPU-side — the CPU
 * has no positions to sort; the facade rejects render.sort + sim:'gpu'
 * loudly) and the trail kind (a ribbon is one continuous strip — the
 * per-particle painter's order does not apply).
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { ParticleFields } from './system.ts'

/** Sorts the live [0, count) particles BACK TO FRONT (far first) by the
 *  camera-basis forward axis. Writes the descending-depth index sequence
 *  into `indices[0..count)` (caller-owned, at least `count` long — the
 *  facade allocates it at capacity) and returns `count`. Deterministic,
 *  zero allocations (the keys land in the caller's scratch; the sort is
 *  an in-place subarray sort with a total-order comparator). */
export function sortDepthBackToFront(
  fields: ParticleFields,
  count: number,
  forward: readonly number[],
  indices: Int32Array,
  keys: Float32Array,
): number {
  if (count <= 0) return 0
  const fx = forward[0], fy = forward[1], fz = forward[2]
  for (let i = 0; i < count; i++) {
    indices[i] = i
    keys[i] = fx * fields.px[i] + fy * fields.py[i] + fz * fields.pz[i]
  }
  // Back to front = the key DESCENDING (dot(forward, p) grows with the
  // view-axis depth). The tie-break (b − a) makes the comparator a TOTAL
  // order: equal depths resolve to the higher slot first, the same bytes
  // on every engine — the parity contract.
  indices.subarray(0, count).sort((a, b) => keys[b] - keys[a] || b - a)
  return count
}
