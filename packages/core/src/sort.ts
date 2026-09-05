/**
 * sort.ts — the painter's order as a pure SoA function (Task 141).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY HERE: the back-to-front depth sort was @rune/particles' sort.ts over
 * its own ParticleFields — but the painter's algorithm is the property of
 * every alpha-blended, depth-less renderer: sprites, instanced quads,
 * transparent batches, impostors. The abstraction is the SoA form (three
 * position arrays + the camera forward), not the particle store — the
 * consumer wrapper stays with its consumer (@rune/particles'
 * sortDepthBackToFront delegates here).
 *
 * THE KEY: depth = dot(forward, position) — the camera basis's forward
 * (the unit direction the camera LOOKS). The dot product grows
 * monotonically with the view-axis depth, so a camera-consistent ordering
 * needs no eye position, no matrices, and no per-element sqrt.
 *
 * THE ORDER: BACK TO FRONT — the key DESCENDING (the farthest element
 * first). The sorted index list feeds the consumer's draw order.
 *
 * DETERMINISM: the comparator breaks ties by the slot index (a total
 * order), so the sequence is engine-independent — the same arrays and
 * camera basis produce the same draw order on every backend, every
 * engine, every run (the parity contract). The sort is in-place on
 * caller-owned scratch (an Int32Array of capacity for the indices, a
 * Float32Array for the keys): ZERO allocations per frame.
 *
 * DOM-free by construction — like all of @rune/core.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Sorts the live [0, count) elements BACK TO FRONT (far first) by the
 *  camera-basis forward axis, over SoA position arrays. Writes the
 *  descending-depth index sequence into `indices[0..count)` (caller-owned,
 *  at least `count` long) and returns `count`. Deterministic, zero
 *  allocations (the keys land in the caller's scratch; the sort is an
 *  in-place subarray sort with a total-order comparator). */
export function sortBackToFront(
  px: Float32Array,
  py: Float32Array,
  pz: Float32Array,
  count: number,
  forward: readonly number[],
  indices: Int32Array,
  keys: Float32Array,
): number {
  if (count <= 0) return 0
  const fx = forward[0], fy = forward[1], fz = forward[2]
  for (let i = 0; i < count; i++) {
    indices[i] = i
    keys[i] = fx * px[i] + fy * py[i] + fz * pz[i]
  }
  // Back to front = the key DESCENDING (dot(forward, p) grows with the
  // view-axis depth). The tie-break (b − a) makes the comparator a TOTAL
  // order: equal depths resolve to the higher slot first, the same bytes
  // on every engine — the parity contract.
  indices.subarray(0, count).sort((a, b) => keys[b] - keys[a] || b - a)
  return count
}
