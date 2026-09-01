/**
 * MipStreamer — helper для progressive mip-стриминга.
 *
 * Контракт (см. дизайн-раунд «Слой 5: MipStreamer»):
 *  - Принимает Texture-подобный объект с методом uploadMip(level, src).
 *  - Принимает source (ImageBitmap или функция, генерирующая даунсэмплы).
 *  - Стримит мипы от грубого (level=N) к тонкому (level=0): сначала превью
 *    (N=ceil(log2(min(w,h))) — самый маленький мип), потом более детальные.
 *  - Не знает про GPU: просто оркеструет вызовы uploadMip на переданном tex.
 *
 * Зачем: progressive image loading. Сначала юзер видит размытое превью
 * (4x4 мип), потом 64x64, потом полный размер. Это особенно важно для
 * тайловых карт с глубоким зумом (deep-zoom), где полная текстура может
 * весить десятки мегабайт.
 */

/** Минимальный интерфейс текстуры, к которой можно стримить мипы. */
export interface MipTargetTexture {
  readonly width: number
  readonly height: number
  uploadMip(level: number, src: ImageBitmap | TexImageSource): void
}

export interface MipStreamerOptions {
  /** Использовать createImageBitmap для даунсэмплинга (броузерный декодер).
   *  Если false — используется canvas downsample. Default true. */
  readonly useImageBitmap?: boolean
  /** Минимальный размер мипа (1 = до 1x1, 4 = до 4x4). Default 4. */
  readonly minMipSize?: number
  /** Сколько мип-уровней загрузить. По умолчанию — все до minMipSize. */
  readonly maxLevels?: number
}

/**
 * Создаёт MipStreamer.
 *
 * Использование:
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
    // Сколько мипов: floor(log2(min(w,h))) + 1, но не меньше чем до minSize
    const minDim = Math.min(w, h)
    let levels = 0
    let d = minDim
    while (d > minSize && levels < maxLevels) {
      d = Math.floor(d / 2)
      levels++
    }
    levels = Math.max(0, levels)

    // Стримим от самого маленького к самому большому (progressive)
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
  // createImageBitmap с resizeWidth/Height — нативный, но в некоторых средах
  // качество даунсэмплинга посредственное. Для тайловых карт это OK.
  if (useImageBitmap && source instanceof ImageBitmap) {
    return createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' })
  }
  // Fallback на canvas (в средах без createImageBitmap с resize)
  const canvas = createCanvas2D(w, h)
  // getContext('2d') типизируется как RenderingContext (включая WebGL*),
  // но для '2d' реально приходит CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D.
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('MipStreamer: 2d context unavailable')
  // drawImage автоматически даунсэмплирует
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
  throw new Error('MipStreamer: нет ни OffscreenCanvas, ни document для canvas')
}
