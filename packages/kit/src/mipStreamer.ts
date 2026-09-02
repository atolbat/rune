/**
 * MipStreamer — a helper for progressive mip streaming.
 *
 * Contract (see the design round "Layer 5: MipStreamer"):
 *  - Accepts a Texture-like object with an uploadMip(level, src) method.
 *  - Accepts a source (an ImageBitmap or a function generating downsamples).
 *  - Streams mips from coarse (level=N) to fine (level=0): the preview first
 *    (N=ceil(log2(min(w,h))) — the smallest mip), then more detailed ones.
 *  - Knows nothing about the GPU: it just orchestrates uploadMip calls on the passed tex.
 *
 * Why: progressive image loading. First the user sees a blurry preview
 * (the 4x4 mip), then 64x64, then the full size. This matters especially for
 * deep-zoom tiled maps, where the full texture can weigh tens of megabytes.
 */

/** Minimal texture interface that mips can be streamed into. */
export interface MipTargetTexture {
  readonly width: number
  readonly height: number
  uploadMip(level: number, src: ImageBitmap | TexImageSource): void
}

export interface MipStreamerOptions {
  /** Use createImageBitmap for downsampling (the browser decoder).
   *  If false — a canvas downsample is used. Default true. */
  readonly useImageBitmap?: boolean
  /** Minimal mip size (1 = down to 1x1, 4 = down to 4x4). Default 4. */
  readonly minMipSize?: number
  /** How many mip levels to upload. By default — all of them down to minMipSize. */
  readonly maxLevels?: number
}

/**
 * Creates a MipStreamer.
 *
 * Usage:
 *   const streamer = createMipStreamer({ minMipSize: 4 })
 *   await streamer.streamProgressive(tex, sourceBitmap)
 *   // → tex.uploadMip(N, downsampleTo(source, 4, 4))
 *   // → tex.uploadMip(N-1, downsampleTo(source, 16, 16))
 *   // → ...
 *   // → tex.uploadMip(0, source)
 */
export function createMipStreamer(options: MipStreamerOptions = {}): MipStreamer {
  const minSize = options.minMipSize ?? 4
  const useImageBitmap = options.useImageBitmap ?? true
  const maxLevels = options.maxLevels ?? Number.POSITIVE_INFINITY

  async function streamProgressive(tex: MipTargetTexture, source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    const w = tex.width
    const h = tex.height
    // How many mips: floor(log2(min(w,h))) + 1, but not fewer than down to minSize
    const minDim = Math.min(w, h)
    let levels = 0
    let d = minDim
    while (d > minSize && levels < maxLevels) {
      d = Math.floor(d / 2)
      levels++
    }
    levels = Math.max(0, levels)

    // Stream from the smallest to the largest (progressive)
    for (let level = levels; level >= 0; level--) {
      const scale = 1 / Math.pow(2, level)
      const targetW = Math.max(1, Math.round(w * scale))
      const targetH = Math.max(1, Math.round(h * scale))
      const downsampled = await downsample(source, targetW, targetH, useImageBitmap)
      tex.uploadMip(level, downsampled)
    }
  }

  return {
    streamProgressive,
  }
}

export interface MipStreamer {
  streamProgressive(tex: MipTargetTexture, source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas): Promise<void>
}

// ─── downsample helpers ──────────────────────────────────────────────────────

async function downsample(
  source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
  w: number,
  h: number,
  useImageBitmap: boolean,
): Promise<ImageBitmap | TexImageSource> {
  // createImageBitmap with resizeWidth/Height is native, but in some
  // environments the downsample quality is mediocre. For tiled maps this is OK.
  if (useImageBitmap && source instanceof ImageBitmap) {
    return createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' })
  }
  // Fallback to canvas (in environments without createImageBitmap resize support)
  const canvas = createCanvas2D(w, h)
  // getContext('2d') is typed as RenderingContext (including WebGL*),
  // but for '2d' it is really CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D.
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('MipStreamer: 2d context unavailable')
  // drawImage downsamples automatically
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h)
  return canvas
}

function createCanvas2D(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h)
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  throw new Error('MipStreamer: neither OffscreenCanvas nor document for a canvas is available')
}
