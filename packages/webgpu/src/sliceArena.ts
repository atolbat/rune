// Slice-арена: слоты по 256 байт (dynamic-offset выравнивание WebGPU).
//
// Две совместимые поверхности:
//  - число-выравнивание (активные компиляторы): alloc(sizeBytes) → база
//    среза (256-выровнена, курсор шагает округлённым размером);
//  - срезы-указатели (легаси/диагностика): allocSlice(size) → {base,bytes}
//    (база выровнена, курсор шагает ТОЛЬКО фактическим размером),
//    slotAt/writeVec4/dirtyRanges — байтовые слоты со слиянием в загрузки.

export interface SliceHandle {
  /** База среза (256-выровнена). */
  readonly base: number
  /** Фактический размер среза в байтах (без набивки). */
  readonly bytes: number
}

export interface SliceSlot {
  /** Абсолютное смещение слота в буфере арены (байты). */
  readonly offset: number
  /** Размер слота в байтах. */
  readonly size: number
}

/** Байтовый диапазон загрузки (соседние записи сливаются). */
export interface SliceRange {
  readonly from: number
  readonly to: number
}

export interface SliceArena {
  /** Байтовый буфер арены. */
  readonly bytes: Uint8Array
  /** Float-вид поверх того же буфера (запись юниформов). */
  readonly floats: Float32Array
  /** Выделить слот (256-выровнен); выбрасывает при переполнении. */
  alloc(sizeBytes: number): number
  /** Выделить срез-указатель: база выровнена, курсор — только фактический размер. */
  allocSlice(sizeBytes: number): SliceHandle
  /** Слот внутри среза: абсолютное байтовое смещение. */
  slotAt(slice: SliceHandle, offset: number, size: number): SliceSlot
  /** Записать vec4 в слот со value-compare; изменение → грязный диапазон. */
  writeVec4(slot: SliceSlot, x: number, y: number, z: number, w: number): void
  /** Грязные диапазоны: соседние с зазором < 256 сливаются в одну загрузку. */
  dirtyRanges(): SliceRange[]
  /** Сброс грязных диапазонов (после загрузки). */
  clearDirty(): void
  /** Сброс курсора (начало кадра/жизни контекста). */
  reset(): void
  used(): number
  /** Занятость в байтах. */
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
      throw new Error(`rune: slice-арена переполнена (${capacityBytes} Б)`)
    }
    const offset = cursor
    cursor += size
    return offset
  }

  function allocSlice(sizeBytes: number): SliceHandle {
    // База выравнивается вверх, курсор шагает только фактическим размером:
    // плотная упаковка данных при сохранении выравнивания баз.
    const base = Math.ceil(cursor / ALIGN) * ALIGN
    if (base + sizeBytes > capacityBytes) {
      throw new Error(`rune: slice-арена переполнена (${capacityBytes} Б)`)
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
      if (from >= range.from && to <= range.to) return // уже покрыто
    }
    dirty.push({ from, to })
  }

  function dirtyRanges(): SliceRange[] {
    if (dirty.length === 0) return []
    const sorted = [...dirty].sort((a, b) => a.from - b.from)
    const merged: Array<{ from: number; to: number }> = []
    for (const range of sorted) {
      const last = merged[merged.length - 1]
      // Соседние записи с зазором меньше выравнивания — одна загрузка
      // (запись 16 Б на границах соседних срезов не должна давать
      // две загрузки с 240 Б мусора между ними).
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
