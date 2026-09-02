// Slice arena: 256-byte slots (WebGPU dynamic-offset alignment).
//
// Two compatible surfaces:
//  - number-aligned (active compilers): alloc(sizeBytes) → slice base
//    (256-aligned, the cursor steps by the rounded size);
//  - slice handles (legacy/diagnostics): allocSlice(size) → {base,bytes}
//    (the base is aligned, the cursor steps ONLY by the actual size),
//    slotAt/writeVec4/dirtyRanges — byte slots with merging into uploads.

export interface SliceHandle {
  /** Slice base (256-aligned). */
  readonly base: number
  /** Actual slice size in bytes (without padding). */
  readonly bytes: number
}

export interface SliceSlot {
  /** Absolute slot offset in the arena buffer (bytes). */
  readonly offset: number
  /** Slot size in bytes. */
  readonly size: number
}

/** Byte upload range (adjacent records are merged). */
export interface SliceRange {
  readonly from: number
  readonly to: number
}

export interface SliceArena {
  /** Byte buffer of the arena. */
  readonly bytes: Uint8Array
  /** Float view over the same buffer (writing uniforms). */
  readonly floats: Float32Array
  /** Allocate a slot (256-aligned); throws on overflow. */
  alloc(sizeBytes: number): number
  /** Allocate a slice handle: the base is aligned, the cursor — only by the actual size. */
  allocSlice(sizeBytes: number): SliceHandle
  /** Slot inside a slice: absolute byte offset. */
  slotAt(slice: SliceHandle, offset: number, size: number): SliceSlot
  /** Write a vec4 into a slot with value-compare; a change → dirty range. */
  writeVec4(slot: SliceSlot, x: number, y: number, z: number, w: number): void
  /** Dirty ranges: adjacent ones with a gap < 256 are merged into one upload. */
  dirtyRanges(): SliceRange[]
  /** Reset dirty ranges (after upload). */
  clearDirty(): void
  /** Reset the cursor (frame/context lifetime start). */
  reset(): void
  used(): number
  /** Usage in bytes. */
  readonly usedBytes: number
}

const ALIGN = 256

export function createSliceArena(capacityBytes: number): SliceArena {
  const bytes = new Uint8Array(capacityBytes)
  const floats = new Float32Array(bytes.buffer)
  let cursor = 0
  let dirty: SliceRange[] = []

  function alloc(sizeBytes: number): number {
    const size = Math.max(ALIGN, Math.ceil(sizeBytes / ALIGN) * ALIGN)
    if (cursor + size > capacityBytes) {
      throw new Error(`rune: slice arena overflowed (${capacityBytes} B)`)
    }
    const offset = cursor
    cursor += size
    return offset
  }

  function allocSlice(sizeBytes: number): SliceHandle {
    // The base is aligned up, the cursor steps only by the actual size:
    // dense data packing while keeping base alignment.
    const base = Math.ceil(cursor / ALIGN) * ALIGN
    if (base + sizeBytes > capacityBytes) {
      throw new Error(`rune: slice arena overflowed (${capacityBytes} B)`)
    }
    cursor = base + sizeBytes
    return { base, bytes: sizeBytes }
  }

  function slotAt(slice: SliceHandle, offset: number, size: number): SliceSlot {
    return { offset: slice.base + offset, size }
  }

  function writeVec4(slot: SliceSlot, x: number, y: number, z: number, w: number): void {
    const at = slot.offset >> 2
    if (floats[at] !== x || floats[at + 1] !== y || floats[at + 2] !== z || floats[at + 3] !== w) {
      floats[at] = x
      floats[at + 1] = y
      floats[at + 2] = z
      floats[at + 3] = w
      markDirty(slot.offset, slot.offset + slot.size)
    }
  }

  function markDirty(from: number, to: number): void {
    for (const range of dirty) {
      if (from >= range.from && to <= range.to) return // already covered
    }
    dirty.push({ from, to })
  }

  function dirtyRanges(): SliceRange[] {
    if (dirty.length === 0) return []
    const sorted = [...dirty].sort((a, b) => a.from - b.from)
    const merged: Array<{ from: number; to: number }> = []
    for (const range of sorted) {
      const last = merged[merged.length - 1]
      // Adjacent records with a gap smaller than the alignment — one upload
      // (a 16 B write at the borders of adjacent slices must not produce
      // two uploads with 240 B of garbage between them).
      if (last !== undefined && range.from - last.to < ALIGN) {
        if (range.to > last.to) last.to = range.to
      } else {
        merged.push({ from: range.from, to: range.to })
      }
    }
    return merged
  }

  function clearDirty(): void {
    dirty = []
  }

  function reset(): void {
    cursor = 0
  }

  function used(): number {
    return cursor
  }

  return {
    bytes,
    floats,
    alloc,
    allocSlice,
    slotAt,
    writeVec4,
    dirtyRanges,
    clearDirty,
    reset,
    used,
    get usedBytes() { return cursor },
  }
}
