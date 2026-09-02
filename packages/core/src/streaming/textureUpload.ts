/**
 * streamTexture: preview → chunks via the AIMD scheduler → progress.
 * The preview (bilinear sampling down to the budget) goes at a priority
 * one above the chunks — fast response, then a refinement to full quality.
 */

import type { UploadScheduler } from './uploadScheduler.ts'
import { chunkRect, tileForBudget, tileBytes } from './chunker.ts'
import type { TileRect } from './chunker.ts'

export type TileUploader = (tile: TileRect, bytes: Uint8Array) => void

export interface TextureUploadOptions {
  readonly priority?: number
  /** Preview budget in bytes (default 64 KB). */
  readonly previewBudget?: number
  readonly onProgress?: (fraction: number) => void
}

export interface TextureUpload {
  /** Readiness 0..1 by chunks (the preview doesn't count). */
  readonly progress: number
  cancel(): void
  /** Resolves on completion (or cancel). */
  readonly done: Promise<void>
}

export type TextureUploadResult = TextureUpload

/** Preview width — a multiple of 64 (WebGPU bytesPerRow alignment of 256). */
function previewWidth(width: number, budget: number): number {
  const scale = Math.min(1, Math.sqrt(budget / (width * width * 4)))
  const scaled = Math.max(64, Math.floor(width * scale / 64) * 64)
  return Math.min(width, scaled)
}

/** Bilinear sampling of source (w×h) into a pw×ph preview. */
function downsample(source: Uint8Array, w: number, h: number, pw: number, ph: number): Uint8Array {
  const out = new Uint8Array(pw * ph * 4)
  for (let y = 0; y < ph; y++) {
    const sy = (y + 0.5) * h / ph - 0.5
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(h - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < pw; x++) {
      const sx = (x + 0.5) * w / pw - 0.5
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(w - 1, x0 + 1)
      const fx = sx - x0
      const at = (y * pw + x) * 4
      for (let ch = 0; ch < 4; ch++) {
        const p00 = source[(y0 * w + x0) * 4 + ch]
        const p10 = source[(y0 * w + x1) * 4 + ch]
        const p01 = source[(y1 * w + x0) * 4 + ch]
        const p11 = source[(y1 * w + x1) * 4 + ch]
        out[at + ch] = bilinear(p00, p10, p01, p11, fx, fy)
      }
    }
  }
  return out
}

function bilinear(p00: number, p10: number, p01: number, p11: number, fx: number, fy: number): number {
  const top = p00 + (p10 - p00) * fx
  const bottom = p01 + (p11 - p01) * fx
  return Math.round(top + (bottom - top) * fy)
}

export function streamTexture(
  scheduler: UploadScheduler,
  source: Uint8Array,
  width: number,
  height: number,
  upload: TileUploader,
  options: TextureUploadOptions = {},
): TextureUpload {
  const priority = options.priority ?? 1
  const previewBudget = options.previewBudget ?? 64 * 1024
  let cancelled = false
  let tilesDone = 0
  const tiles = chunkRect(width, height, tileForBudget(width, previewBudget))

  // N theory: demand raises the window — a texture up to the burst cap
  // in size loads entirely into the first idle slot. Frame N draws the
  // frame N-1 load: the texture is fully visible as early as the second
  // frame, like in the old demos.
  scheduler.burst(source.length)

  let resolveDone: () => void
  const done = new Promise<void>(resolve => { resolveDone = resolve })

  function maybeFinish(): void {
    if (tilesDone >= tiles.length) resolveDone()
  }

  // Preview: a small copy — higher priority than chunks, goes first
  const pw = previewWidth(width, previewBudget)
  const ph = Math.max(1, Math.round(height * pw / width))
  const preview = downsample(source, width, height, pw, ph)
  scheduler.push({
    bytes: preview.length,
    priority: priority + 1,
    run: (): void => {
      if (cancelled) return
      upload({ x: 0, y: 0, width: pw, height: ph }, preview)
    },
  })

  // Chunks: a full row per task (K theory)
  for (const tile of tiles) {
    const bytes = tileBytes(tile, source, width)
    scheduler.push({
      bytes: bytes.length,
      priority,
      run: (): void => {
        if (cancelled) return
        upload(tile, bytes)
        tilesDone++
        options.onProgress?.(tilesDone / tiles.length)
        maybeFinish()
      },
    })
  }

  return {
    get progress(): number {
      return tiles.length === 0 ? 1 : tilesDone / tiles.length
    },
    cancel(): void {
      cancelled = true
      resolveDone()
    },
    done,
  }
}
