// Chunker: row-by-row slicing of a texture into tiles (a large chunk — K theory).

export interface TileRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Full-width tiles (rows of tileH height, the last one is clipped). */
export function chunkRect(width: number, height: number, tileH: number): TileRect[] {
  if (tileH < 1) throw new Error('rune: chunkRect requires tileH >= 1')
  const tiles: TileRect[] = []
  for (let y = 0; y < height; y += tileH) {
    const rows = Math.min(tileH, height - y)
    tiles.push({ x: 0, y, width, height: rows })
  }
  return tiles
}

/** Tile count without building the array — exactly chunkRect(...).length.
 *  (Bug smell of the previous version: chunkRect.length — the function's
 *  arity (3), not the array length; the result "coincidentally converged".) */
export function countTiles(width: number, height: number, tileH: number): number {
  if (tileH < 1) throw new Error('rune: countTiles requires tileH >= 1')
  if (height <= 0) return 0
  return Math.ceil(height / tileH)
}

/** Tile height under a byte budget (ceiling of 256 rows, minimum 1). */
export function tileForBudget(width: number, budgetBytes: number): number {
  const rowBytes = width * 4
  if (rowBytes <= 0) return 1
  return Math.max(1, Math.min(256, Math.floor(budgetBytes / rowBytes)))
}

/**
 * Tile bytes: a full row — subarray without a copy; a horizontal slice —
 * a dense copy (GPU rows must be contiguous).
 */
export function tileBytes(tile: TileRect, source: Uint8Array, sourceWidth: number): Uint8Array {
  if (tile.width === sourceWidth) {
    return source.subarray(tile.y * sourceWidth * 4, (tile.y + tile.height) * sourceWidth * 4)
  }
  const out = new Uint8Array(tile.width * tile.height * 4)
  for (let row = 0; row < tile.height; row++) {
    const from = ((tile.y + row) * sourceWidth + tile.x) * 4
    out.set(source.subarray(from, from + tile.width * 4), row * tile.width * 4)
  }
  return out
}
