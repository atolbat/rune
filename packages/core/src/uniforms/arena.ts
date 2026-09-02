/**
 * std140 arena: a uniform staging buffer with per-value comparison.
 * An unchanged value is NOT marked dirty (C theory: fround —
 * 0.8 as f64 ≠ 0.8 as f32, comparison in f32 suppresses false uploads).
 *
 * Two compatible surfaces:
 *  - float-API (active renderers): alloc(sizeFloats) → UniformSlot,
 *    write(slot, values) — the slot in float elements;
 *  - byte-API (uniformSet/frequencyArena/tape delivery): alloc(type) →
 *    {offset,size} in bytes, writeFloat/readFloat, dirtyRanges/importBytes.
 */

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
    return { offset: slot.base * 4, size: byteSize }
  }

  function write(slot: UniformSlot, values: ArrayLike<number> | number): boolean {
    let changed = false
    if (typeof values === 'number') {
      // Scalar float-uniform: comparison and write of the first element
      // (previously values[0] on a number gave undefined → a silent zero).
      if (Math.fround(values) !== buffer[slot.base]) {
        buffer[slot.base] = values
        changed = true
      }
    } else {
      for (let at = 0; at < slot.size; at++) {
        const next = values[at] ?? 0
        if (Math.fround(next) !== buffer[slot.base + at]) {
          buffer[slot.base + at] = next
          changed = true
        }
      }
    }
    if (changed) slot.dirty = true
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
    if (Math.fround(value) !== buffer[floatIndex]) {
      buffer[floatIndex] = value
      const owner = slotAt(floatIndex)
      if (owner !== null) owner.dirty = true
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
    if (Math.fround(x) !== buffer[base]) { buffer[base] = x; changed = true }
    if (Math.fround(y) !== buffer[base + 1]) { buffer[base + 1] = y; changed = true }
    if (Math.fround(z) !== buffer[base + 2]) { buffer[base + 2] = z; changed = true }
    if (Math.fround(w) !== buffer[base + 3]) { buffer[base + 3] = w; changed = true }
    if (changed) {
      const owner = slotAt(base)
      if (owner !== null) owner.dirty = true
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
 *  if you need to keep it). */
  const dirtyRangesOut: ByteRange[] = []
  function dirtyRanges(): ByteRange[] {
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

  function importBytes(from: number, source: Uint8Array): void {
    if (source.byteLength === 0) return
    if (from < 0 || from + source.byteLength > buffer.byteLength) {
      throw new Error('rune: importBytes goes out of the arena bounds')
    }
    bytes.set(source, from)
    const fromFloat = from >> 2
    const toFloat = (from + source.byteLength + 3) >> 2
    for (const slot of slots) {
      if (slot.base + slot.size > fromFloat && slot.base < toFloat) slot.dirty = true
    }
  }

  function clearDirty(): void {
    for (const slot of slots) slot.dirty = false
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
