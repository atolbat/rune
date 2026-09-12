/**
 * RectPacker — packs rectangles into a larger rectangle.
 *
 * Contract (see the design round "Use case B: Runtime packing"):
 *  - A purely algorithmic task. Knows nothing about the GPU, textures, ImageBitmap.
 *  - The user packs slots, then copies the bits into the region themselves via
 *    Texture.uploadSubImage(x, y, bitmap).
 *  - Algorithms: 'shelf' (fast, for uniform sizes — tiles) and
 *    'maxrects' (the classic for mixed sizes).
 *
 * Typical flow:
 *   const packer = createRectPacker(2048, 2048, { algorithm: 'maxrects' })
 *   const slots = packer.pack([
 *     { id: 'grass', w: 64, h: 64 },
 *     { id: 'stone', w: 64, h: 64 },
 *   ])
 *   if (!slots) throw new Error('Did not fit — a larger atlas is needed')
 *   // slots: [{ id: 'grass', x: 0, y: 0, w: 64, h: 64 }, ...]
 */

export interface RectInput {
  /** Slot identifier — user-supplied, for matching later. */
  readonly id: string
  readonly w: number
  readonly h: number
}

export interface RectSlot extends RectInput {
  /** Position in the atlas (top-left). */
  readonly x: number
  readonly y: number
}

export interface RectPackerOptions {
  /** Packing algorithm. Default 'shelf'.
   *  - 'shelf': lays out rows of height = max height in the row.
   *    O(n log n), good for tile atlases.
   *  - 'maxrects': the classic MAXRECTS-BSSF. O(n^2) in the worst case,
   *    but packs mixed sizes well. */
  readonly algorithm?: 'shelf' | 'maxrects'
  /** Gap between slots (against mip bleeding). Default 0. */
  readonly padding?: number
}

/** Packer state. */
export interface RectPacker {
  /** Pack a set of rectangles. Returns null if they do not fit.
   *
   *  The pack is INCREMENTAL and ATOMIC: repeated calls fill the FREE space
   *  of the same atlas (never re-placing over earlier slots), and a null
   *  return leaves the packer state exactly as it was before the call —
   *  a failed batch changes nothing. */
  pack(items: readonly RectInput[]): RectSlot[] | null
  /** Current fill ratio (by area). */
  readonly usedArea: number
  /** Atlas width/height. */
  readonly width: number
  readonly height: number
}

export function createRectPacker(width: number, height: number, options: RectPackerOptions = {}): RectPacker {
  const algorithm = options.algorithm ?? 'shelf'
  const padding = options.padding ?? 0

  let usedArea = 0

  // ─── persistent layout state ─────────────────────────────────────────────
  // The incremental contract: pack() used to be STATELESS — every call
  // restarted from the top-left corner, so the second batch silently
  // OVERLAPPED the first (the atlas docstring promised "repeated calls pack
  // into the free space" — the packer never delivered it). Now the layout
  // state lives in the closure and survives across calls.
  // shelf: the cursor of the row being filled + that row's height.
  let shelfX = padding
  let shelfY = padding
  let shelfRowHeight = 0
  // maxrects: the free-rectangle list, seeded with the whole atlas ONCE.
  let freeList: FreeRect[] | null = null

  function pack(items: readonly RectInput[]): RectSlot[] | null {
    if (algorithm === 'shelf') return packShelf(items)
    return packMaxRects(items)
  }

  // ─── Shelf packer ────────────────────────────────────────────────────────
  //
  // Lays out rows. Each row has a height = the max height in that row.
  // Works well for uniform tiles (all 64x64 — perfect).

  function packShelf(items: readonly RectInput[]): RectSlot[] | null {
    // Sort by height descending — this is the First-Fit Decreasing heuristic.
    const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w)
    const slots: RectSlot[] = []
    // Atomicity: a null return rolls the cursor back — a failed batch
    // changes nothing.
    const startX = shelfX
    const startY = shelfY
    const startRowHeight = shelfRowHeight
    const startArea = usedArea

    for (const item of sorted) {
      const w = item.w + padding * 2
      const h = item.h + padding * 2
      // Does not fit into the current row — move to a new row
      if (shelfX + w > width + padding) {
        shelfY += shelfRowHeight
        shelfX = padding
        shelfRowHeight = 0
        // An item wider than a FRESH row fits nowhere in this atlas (the
        // wrap above assumed the next row is wide enough — a wide-but-short
        // item used to be placed out of bounds here).
        if (shelfX + w > width + padding) {
          shelfX = startX; shelfY = startY; shelfRowHeight = startRowHeight; usedArea = startArea
          return null
        }
      }
      // Does not fit vertically — the atlas is too small
      if (shelfY + h > height + padding) {
        shelfX = startX; shelfY = startY; shelfRowHeight = startRowHeight; usedArea = startArea
        return null
      }
      slots.push({ id: item.id, x: shelfX, y: shelfY, w: item.w, h: item.h })
      usedArea += item.w * item.h
      shelfX += w
      shelfRowHeight = Math.max(shelfRowHeight, h)
    }
    return slots
  }

  // ─── MaxRects packer (BSSF variant) ───────────────────────────────────────
  //
  // The classic MAXRECTS-BSSF algorithm (Best Short Side Fit). Maintains
  // free rectangles; when a new slot is placed, it splits the intersected ones.
  // Good for mixed sizes.

  interface FreeRect { x: number; y: number; w: number; h: number }

  function packMaxRects(items: readonly RectInput[]): RectSlot[] | null {
    // Free rectangles. Initially — the whole atlas; then PERSISTENT across
    // calls (the incremental contract).
    if (freeList === null) {
      freeList = [{ x: padding, y: padding, w: width - padding * 2, h: height - padding * 2 }]
    }
    const free = freeList
    const slots: RectSlot[] = []
    const sorted = [...items].sort((a, b) => (b.w * b.h) - (a.w * a.h))
    // Atomicity: a null return restores the free list exactly (the splits
    // below mutate it in place).
    const backup = free.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h }))
    const startArea = usedArea

    const fail = (): null => {
      free.length = 0
      for (const r of backup) free.push(r)
      usedArea = startArea
      return null
    }

    for (const item of sorted) {
      const w = item.w + padding * 2
      const h = item.h + padding * 2
      // Best Short Side Fit: find a free rect that fits, minimizing
      // the short remaining side.
      let best: { rect: FreeRect; score: number } | null = null
      for (const rect of free) {
        if (rect.w >= w && rect.h >= h) {
          const shortSide = Math.min(rect.w - w, rect.h - h)
          const longSide = Math.max(rect.w - w, rect.h - h)
          const score = shortSide * 1000 + longSide // the short side dominates
          if (best === null || score < best.score) {
            best = { rect, score }
          }
        }
      }
      if (best === null) return fail() // does not fit
      const chosen = best.rect
      slots.push({ id: item.id, x: chosen.x + padding, y: chosen.y + padding, w: item.w, h: item.h })
      usedArea += item.w * item.h
      // Split the intersected free rectangles
      const newFree: FreeRect[] = []
      for (const rect of free) {
        if (!intersects(rect, chosen, w, h)) {
          newFree.push(rect)
          continue
        }
        // Split into parts
        for (const part of splitRect(rect, { x: chosen.x, y: chosen.y, w, h })) {
          if (part.w > 0 && part.h > 0) newFree.push(part)
        }
      }
      // Intermediate cleanup: drop free rects fully contained in others
      free.length = 0
      outer: for (let i = 0; i < newFree.length; i++) {
        for (let j = 0; j < newFree.length; j++) {
          if (i === j) continue
          if (contains(newFree[j], newFree[i])) continue outer
        }
        free.push(newFree[i])
      }
    }
    return slots
  }

  function intersects(a: FreeRect, b: FreeRect, bw: number, bh: number): boolean {
    return !(b.x >= a.x + a.w || b.x + bw <= a.x || b.y >= a.y + a.h || b.y + bh <= a.y)
  }

  function splitRect(free: FreeRect, used: FreeRect): FreeRect[] {
    const result: FreeRect[] = []
    // Left piece
    if (used.x > free.x) result.push({ x: free.x, y: free.y, w: used.x - free.x, h: free.h })
    // Right piece
    if (used.x + used.w < free.x + free.w) result.push({ x: used.x + used.w, y: free.y, w: free.x + free.w - (used.x + used.w), h: free.h })
    // Top piece
    if (used.y > free.y) result.push({ x: free.x, y: free.y, w: free.w, h: used.y - free.y })
    // Bottom piece
    if (used.y + used.h < free.y + free.h) result.push({ x: free.x, y: used.y + used.h, w: free.w, h: free.y + free.h - (used.y + used.h) })
    return result
  }

  function contains(outer: FreeRect, inner: FreeRect): boolean {
    return outer.x <= inner.x && outer.y <= inner.y &&
      outer.x + outer.w >= inner.x + inner.w &&
      outer.y + outer.h >= inner.y + inner.h
  }

  return {
    pack,
    get usedArea() { return usedArea },
    get width() { return width },
    get height() { return height },
  }
}
