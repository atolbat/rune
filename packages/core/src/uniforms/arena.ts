/**
 * std140 arena: a uniform staging buffer with per-value comparison.
 * An unchanged value is NOT marked dirty (C theory: fround —
 * 0.8 as f64 ≠ 0.8 as f32, comparison in f32 suppresses false uploads).
 * Task 179 — THE NaN GUARD: fround(NaN) !== NaN is ALWAYS true, so a
 * NaN-valued lane re-dirtied its slot on EVERY write (a silent per-frame
 * re-upload leak). A lane whose current AND next values are both NaN is
 * now STABLE (writes once); NaN → number and number → NaN still count as
 * changes. The GPU keeps receiving the NaN — this is the leak fix, not a
 * value sanitizer.
 *
 * Two compatible surfaces:
 *  - float-API (active renderers): alloc(sizeFloats) → UniformSlot,
 *    write(slot, values) — the slot in float elements;
 *  - byte-API (uniformSet/frequencyArena/tape delivery): alloc(type) →
 *    {offset,size} in bytes, writeFloat/readFloat, dirtyRanges/importBytes.
 */

/** Task 179 — the NaN-stable lane compare: changed unless BOTH are NaN
 * (fround(NaN) !== NaN is always true — the pre-179 compare re-dirtied a
 * NaN lane on every write; see the module's Task-179 note). */
function laneChanged(next: number, cur: number): boolean {
  if (next !== next && cur !== cur) return false
  return Math.fround(next) !== cur
}

export interface DirtyRange {
  /** Range begin in buffer arrays. */
  begin: number
  /** End (exclusive). */
  end: number
}

/** Byte range (for frame delivery between worlds). */
export interface ByteRange {
  /** Begin in bytes from the start of the arena buffer. */
  from: number
  /** End (exclusive) in bytes. */
  to: number
}

/** Byte slot descriptor (byte-API). */
export interface UniformSlotBytes {
  /** Field offset in bytes from the start of the arena buffer. */
  readonly offset: number
  /** Field size in bytes. */
  readonly size: number
}

export interface UniformSlot {
  /** Offset in float elements of the buffer. */
  readonly base: number
  /** Number of floats. */
  readonly size: number
  /** Dirty since the last upload. */
  dirty: boolean
}

export interface UniformArena {
  readonly buffer: Float32Array
  /** Byte view over the same buffer (frame delivery). */
  readonly bytes: Uint8Array
  /** Linear slot allocation (bump; float-API). */
  alloc(size: number): UniformSlot
  /** Slot allocation by TYPE NAME (byte-API: 'mat4' → 64 bytes). */
  alloc(type: string): UniformSlotBytes
  /** Write with comparison; true = the value changed (float-API).
   *  A scalar (float-uniform) is written into the slot's first element. */
  write(slot: UniformSlot, values: ArrayLike<number> | number): boolean
  /** Write a single float at a byte offset with comparison (byte-API). */
  writeFloat(slot: number | UniformSlotBytes, value: number): void
  /** Read a float at a byte offset (byte-API). */
  readFloat(slot: number | UniformSlotBytes, index?: number): number
  /** All slots marked dirty (a snapshot). */
  dirtySlots(): UniformSlot[]
  /** Dirty ranges in BYTES, merged from adjacent slots (byte-API).
   *  The returned array is REUSED between calls — consume it (or copy)
   *  before calling dirtyRanges() again. */
  dirtyRanges(): ByteRange[]
  /** Write a vec4 into a slot with value-compare (byte-API). */
  writeVec4(slot: UniformSlot | UniformSlotBytes, x: number, y: number, z: number, w: number): void
  /** Whether the slot is dirty (diagnostics/benchmarks). */
  isDirty(slot: UniformSlot | UniformSlotBytes): boolean
  /** Pours delivered bytes in, marking intersected slots dirty. */
  importBytes(from: number, bytes: Uint8Array): void
  /** Reset dirty flags (after upload). */
  clearDirty(): void
  /** Usage in floats. */
  used(): number
  /** Usage in bytes (byte-API). */
  readonly usedBytes: number
}

/** Uniform type sizes in bytes (an ABI subset). */
const TYPE_BYTES: Record<string, number> = {
  float: 4, int: 4, uint: 4, bool: 4,
  vec2: 8, vec3: 12, vec4: 16,
  ivec2: 8, ivec3: 12, ivec4: 16,
  uvec2: 8, uvec3: 12, uvec4: 16,
  bvec2: 8, bvec3: 12, bvec4: 16,
  mat2: 16, mat3: 48, mat4: 64,
}

export function createUniformArena(floats: number = 1 << 16): UniformArena {
  const buffer = new Float32Array(floats)
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const slots: UniformSlot[] = []
  const /** slot bases, ascending (bump allocation) */ bases: number[] = []
  let cursor = 0
  // Last slot hit by a lookup: writes of one command's fields are clustered,
  // so a single comparison usually resolves the owner (O(1) fast path).
  let lastHit = 0
  // Task 144 — the dirty LIST: clearDirty() used to walk ALL slots
  // (O(S) per frame even when one value changed). Marks now append the
  // slot here (guard: already-dirty → no-op), clear walks the list
  // (O(dirty)) and empties it. Semantics preserved exactly: every reader
  // (isDirty/dirtySlots/dirtyRanges) still reads the live slot.dirty flag;
  // born-dirty survives (alloc marks); importBytes marks. An external
  // slot.dirty = false (the executor's per-field upload clear) stays
  // harmless — the list member is re-cleared as a no-op, and a later mark
  // pushes it again (duplicates inside one cycle are bounded and benign).
  const dirtyList: UniformSlot[] = []
  function markDirty(slot: UniformSlot): void {
    if (slot.dirty) return
    slot.dirty = true
    dirtyList.push(slot)
  }

  function alloc(sizeOrType: number | string): UniformSlot | UniformSlotBytes {
    if (typeof sizeOrType === 'string') {
      const byteSize = TYPE_BYTES[sizeOrType]
      if (byteSize === undefined) throw new Error(`rune: unknown uniform type "${sizeOrType}"`)
      return allocBytes(byteSize)
    }
    return allocFloats(sizeOrType)
  }

  function allocFloats(size: number): UniformSlot {
    if (cursor + size > floats) throw new Error(`rune: uniform arena overflowed (${floats} float)`)
    const slot: UniformSlot = { base: cursor, size, dirty: true }
    cursor += size
    bases.push(slot.base)
    slots.push(slot)
    dirtyList.push(slot) // born dirty — the direct push (the literal + the list entry, no call)
    return slot
  }

  /** Allocation by size in bytes: the slot stores float metrics, the byte descriptor goes out. */
  function allocBytes(byteSize: number): UniformSlotBytes {
    const size = byteSize / 4
    if (cursor + size > floats) throw new Error(`rune: uniform arena overflowed (${floats} float)`)
    const slot: UniformSlot = { base: cursor, size, dirty: true }
    cursor += size
    bases.push(slot.base)
    slots.push(slot)
    dirtyList.push(slot) // born dirty — the direct push (the literal + the list entry, no call)
    return { offset: slot.base * 4, size: byteSize }
  }

  function write(slot: UniformSlot, values: ArrayLike<number> | number): boolean {
    let changed = false
    if (typeof values === 'number') {
      // Scalar float-uniform: comparison and write of the first element
      // (previously values[0] on a number gave undefined → a silent zero).
      // Task 179 — THE NaN GUARD (see the module's Task-179 note): a NaN
      // scalar would re-dirty the slot on EVERY write (fround(NaN) !== NaN);
      // NaN → NaN is now stable — writes once, uploads once.
      const next = values as number
      if (next !== next && buffer[slot.base] !== buffer[slot.base]) return false
      if (Math.fround(next) !== buffer[slot.base]) {
        buffer[slot.base] = next
        changed = true
      }
    } else {
      for (let at = 0; at < slot.size; at++) {
        const next = values[at] ?? 0
        const cur = buffer[slot.base + at]
        // Task 179 — THE NaN GUARD: NaN === NaN for the compare only (a
        // stable NaN lane stops re-dirtying the slot every frame — the
        // silent re-upload leak class the Task-178 audit documented).
        if (next !== next && cur !== cur) continue
        if (Math.fround(next) !== cur) {
          buffer[slot.base + at] = next
          changed = true
        }
      }
    }
    if (changed) markDirty(slot)
    return changed
  }

  /** Owner lookup — O(log S): the bump allocator guarantees strictly ascending,
 *  non-overlapping bases, so a binary search over bases is exact (no
 *  forward-walk correction needed; the found candidate IS the only owner). */
  function slotAt(floatIndex: number): UniformSlot | null {
    // Fast path: the previous hit (a command's fields are written in clusters).
    const hit = slots[lastHit]
    if (hit !== undefined && floatIndex >= hit.base && floatIndex < hit.base + hit.size) return hit
    if (bases.length === 0) return null
    // Binary search: the greatest base <= floatIndex.
    let low = 0
    let high = bases.length - 1
    let found = -1
    while (low <= high) {
      const mid = (low + high) >>> 1
      if (bases[mid] <= floatIndex) { found = mid; low = mid + 1 } else { high = mid - 1 }
    }
    if (found === -1) return null
    const owner = slots[found]
    if (floatIndex >= owner.base + owner.size) return null
    lastHit = found
    return owner
  }

  function byteOffsetOf(slot: number | UniformSlotBytes): number {
    return typeof slot === 'number' ? slot : slot.offset
  }

  function writeFloat(slot: number | UniformSlotBytes, value: number): void {
    const offset = byteOffsetOf(slot)
    if (offset % 4 !== 0 || offset < 0 || offset >= buffer.byteLength) {
      throw new Error(`rune: writeFloat — invalid offset ${offset}`)
    }
    const floatIndex = offset >> 2
    // Task 179 — THE NaN GUARD: a stable NaN writes once (the compare's
    // fround(NaN) !== NaN was a per-call re-dirty of the owning slot).
    if (value !== value && buffer[floatIndex] !== buffer[floatIndex]) return
    if (Math.fround(value) !== buffer[floatIndex]) {
      buffer[floatIndex] = value
      const owner = slotAt(floatIndex)
      if (owner !== null) markDirty(owner)
    }
  }

  function readFloat(slot: number | UniformSlotBytes, index = 0): number {
    const offset = byteOffsetOf(slot)
    return buffer[(offset >> 2) + index]
  }

  function floatIndexOf(slot: UniformSlot | UniformSlotBytes): number {
    return 'base' in slot ? slot.base : slot.offset >> 2
  }

  function writeVec4(slot: UniformSlot | UniformSlotBytes, x: number, y: number, z: number, w: number): void {
    const base = floatIndexOf(slot)
    let changed = false
    // Four direct scalar comparisons (no [x,y,z,w] allocation on the hot path).
    // Task 179 — THE NaN GUARD per lane: a stable NaN lane no longer re-dirties
    // the slot (the fround(NaN) !== NaN leak, every write call).
    if (laneChanged(x, buffer[base])) { buffer[base] = x; changed = true }
    if (laneChanged(y, buffer[base + 1])) { buffer[base + 1] = y; changed = true }
    if (laneChanged(z, buffer[base + 2])) { buffer[base + 2] = z; changed = true }
    if (laneChanged(w, buffer[base + 3])) { buffer[base + 3] = w; changed = true }
    if (changed) {
      const owner = slotAt(base)
      if (owner !== null) markDirty(owner)
    }
  }

  function isDirty(slot: UniformSlot | UniformSlotBytes): boolean {
    const owner = slotAt(floatIndexOf(slot))
    return owner !== null && owner.dirty
  }

  function dirtySlots(): UniformSlot[] {
    return slots.filter(slot => slot.dirty)
  }

  /** Dirty ranges in BYTES, merged from adjacent slots (byte-API).
 *  Slots are ascending by construction — one pass, no sort, no filter/map
 *  intermediate arrays; the output array is reused between calls (copy it
 *  if you need to keep it).
 *  Task 146 — the O(dirty) walk (the Task-144 clearDirty sibling): the
 *  marks now live on the dirty LIST, so sparse frames walk only the marked
 *  entries instead of every slot (a 5000-slot frame with 13 dirty paid the
 *  full 5000-slot scan per call). Two load-only passes: pass 1 filters the
 *  live members (the list may hold stale externally-cleared entries — the
 *  executor's per-field upload clear — and bounded duplicates) and detects
 *  ascending order; pass 2 merges in the exact V0 shape. Guards: a dense
 *  list (≥90% of all slots — the indirection cannot pay there) or ANY
 *  disorder (marks out of alloc order) falls back to the full-slot walk,
 *  which is byte-for-byte the pre-Task-146 code — always-correct, and the
 *  adversarial shapes measured even (all-dirty ±0.9%, shuffled marks +8%
 *  — the wasted pass-1, documented as the trade). */
  const dirtyRangesOut: ByteRange[] = []
  function dirtyRangesWalk(): ByteRange[] {
    let write = 0
    for (let at = 0; at < slots.length; at++) {
      const slot = slots[at]
      if (!slot.dirty) continue
      const from = slot.base * 4
      const to = (slot.base + slot.size) * 4
      const last = write > 0 ? dirtyRangesOut[write - 1] : undefined
      if (last !== undefined && from <= last.to) {
        if (to > last.to) last.to = to
      } else {
        if (write < dirtyRangesOut.length) {
          const reuse = dirtyRangesOut[write]
          reuse.from = from
          reuse.to = to
        } else {
          dirtyRangesOut.push({ from, to })
        }
        write++
      }
    }
    dirtyRangesOut.length = write
    return dirtyRangesOut
  }
  function dirtyRanges(): ByteRange[] {
    const list = dirtyList
    if (list.length * 10 >= slots.length * 9) return dirtyRangesWalk()
    let ascending = true
    let prevBase = -1
    for (let i = 0; i < list.length; i++) {
      const slot = list[i]
      if (!slot.dirty) continue
      if (slot.base < prevBase) ascending = false
      else prevBase = slot.base
    }
    if (!ascending) return dirtyRangesWalk()
    let write = 0
    for (let i = 0; i < list.length; i++) {
      const slot = list[i]
      if (!slot.dirty) continue
      const from = slot.base * 4
      const to = (slot.base + slot.size) * 4
      const last = write > 0 ? dirtyRangesOut[write - 1] : undefined
      if (last !== undefined && from <= last.to) {
        if (to > last.to) last.to = to
      } else {
        if (write < dirtyRangesOut.length) {
          const reuse = dirtyRangesOut[write]
          reuse.from = from
          reuse.to = to
        } else {
          dirtyRangesOut.push({ from, to })
        }
        write++
      }
    }
    dirtyRangesOut.length = write
    return dirtyRangesOut
  }

  function importBytes(from: number, source: Uint8Array): void {
    if (source.byteLength === 0) return
    if (from < 0 || from + source.byteLength > buffer.byteLength) {
      throw new Error('rune: importBytes goes out of the arena bounds')
    }
    bytes.set(source, from)
    const fromFloat = from >> 2
    const toFloat = (from + source.byteLength + 3) >> 2
    // The bump allocator guarantee: bases ascending, ranges DISJOINT — so the
    // intersecting slots form a contiguous rank range. Lower-bound by "the
    // slot ends after fromFloat" (ends are ascending for disjoint ranges),
    // then walk while the slot starts before toFloat: O(log S + k) instead of
    // the full O(S) scan per delivered frame (tape delivery, worker frames).
    let low = 0
    let high = slots.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (bases[mid] + slots[mid].size > fromFloat) high = mid
      else low = mid + 1
    }
    for (let at = low; at < slots.length; at++) {
      const slot = slots[at]
      if (slot.base >= toFloat) break
      markDirty(slot)
    }
  }

  function clearDirty(): void {
    for (let i = 0; i < dirtyList.length; i++) dirtyList[i].dirty = false
    dirtyList.length = 0
  }

  function used(): number {
    return cursor
  }

  return {
    buffer,
    get bytes() { return bytes },
    alloc: alloc as unknown as {
      (size: number): UniformSlot
      (type: string): UniformSlotBytes
    },
    write,
    writeFloat,
    readFloat,
    writeVec4,
    isDirty,
    dirtySlots,
    dirtyRanges,
    importBytes,
    clearDirty,
    used,
    get usedBytes() { return cursor * 4 },
  }
}
