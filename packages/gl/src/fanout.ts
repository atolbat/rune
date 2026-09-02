// Task 97: canvas fan-out — "one internal canvas → N external ones".
//
// LINEAGE. The customer's idea ("the engine creates its working canvas itself,
// the external one is designated for display") was run through demo/bench-present.html — 13
// present paths on SwiftShader: transferToImageBitmap → bitmaprenderer for a single
// viewer is NOT WORSE than direct (22.9 vs 22.5 wall fps), drawImage×N is the
// working path for many viewers (multi4: −4 fps for 4 copies on software GL). DESIGN.md
// §5.5 planned present.ts (PathRegistry + PathState, a degradation machine)
// for M8 — THIS module is the first runtime slice of that plan: fan-out only.
//
// CONTRACT:
//  - source: the renderer's canvas. The rune WebGL2 path requests
//    preserveDrawingBuffer:true (acquireWebGL2) — drawImage reads the canvas
//    OUTSIDE the frame; the WebGPU canvas is also a valid CanvasImageSource; OffscreenCanvas
//    additionally opens the 'bitmap' mode (transferToImageBitmap);
//  - targets: N canvases of any size — drawImage scales (a preview grid);
//  - '2d': target.getContext('2d') is taken lazily and cached; the source is not
//    "consumed" — N copies of one frame are legal;
//  - 'bitmap': EXACTLY one target — transferFromImageBitmap eats the ImageBitmap
//    (a second viewer has nothing to receive); the source must be an OffscreenCanvas
//    (transferToImageBitmap detaches the front buffer — the frame loop does not care,
//    the next frame writes into a new buffer; bench mode 'bitmap', 138 frames);
//  - 'auto': one target + a transferable source → 'bitmap', otherwise '2d'. IMPORTANT:
//    auto does NOT probe target.getContext('bitmaprenderer') up front — the call
//    RESERVES the target's context type forever (one type per canvas, the same
//    context-conflict incident as webgpu-vs-webgl2). The probe happens at the first
//    copy(); null → an honest error with a hint mode:'2d';
//  - copy() is synchronous, reads the LAST PRESENTED frame. From a frame callback
//    that is frame N-1 (callbacks run BEFORE the tape — see step()), right after
//    renderer.step() — frame N. For mirrors/previews one frame of latency is the norm;
//  - the fan-out does NOT own either the source or the targets: dispose() only drops
//    the references and the context cache. Idempotent.

import type { AnyCanvas } from './canvasHelpers.ts'

/** Mode chosen by the user (auto — decide from the source/targets). */
export type FanoutMode = 'auto' | '2d' | 'bitmap'

/** Mode after resolving auto (what actually performs the copy). */
export type ResolvedFanoutMode = '2d' | 'bitmap'

/** One frame copy source → target (injection for headless tests). */
export type FanoutCopy = (source: AnyCanvas, target: AnyCanvas) => void

export interface FanoutOptions {
  /** 'auto' (default): 1 target + OffscreenCanvas source → 'bitmap', otherwise '2d'. */
  readonly mode?: FanoutMode
  /** Copy injection (headless tests without DOM canvases). */
  readonly copy?: FanoutCopy
}

export interface CanvasFanout {
  /** Fan out the last presented frame to all targets. */
  copy(): void
  /** Add a target (in 'bitmap' — only a single one). */
  add(target: AnyCanvas): void
  /** Remove a target (and its cached 2d context). Idempotent. */
  remove(target: AnyCanvas): void
  readonly targets: readonly AnyCanvas[]
  readonly mode: ResolvedFanoutMode
  /** Drop the references to targets and the context cache. Does not touch the canvases. Idempotent. */
  dispose(): void
}

/** The source supports transferToImageBitmap (OffscreenCanvas). */
function isTransferableSource(source: AnyCanvas): boolean {
  return typeof (source as Partial<OffscreenCanvas>).transferToImageBitmap === 'function'
}

/**
 * Pure mode-selection function (tested without DOM).
 * Rules: explicit '2d'/'bitmap' — as requested; 'auto' → 'bitmap' only with
 * exactly one target AND a transferable source (transfer consumes the bitmap —
 * it cannot feed many viewers), otherwise '2d'.
 */
export function pickFanoutMode(
  source: AnyCanvas,
  targets: readonly AnyCanvas[],
  mode: FanoutMode = 'auto',
): ResolvedFanoutMode {
  if (mode === '2d') return '2d'
  if (mode === 'bitmap') return 'bitmap'
  return targets.length === 1 && isTransferableSource(source) ? 'bitmap' : '2d'
}

/** The target's 2d context (HTMLCanvasElement | OffscreenCanvas — both can drawImage). */
function ctx2d(canvas: AnyCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  return (canvas as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null
}

/** The target's bitmaprenderer context (consumed by transferFromImageBitmap). */
function ctxBitmapRenderer(canvas: AnyCanvas): ImageBitmapRenderingContext | null {
  return (canvas as HTMLCanvasElement).getContext('bitmaprenderer') as ImageBitmapRenderingContext | null
}

/** Default copy, '2d' mode: drawImage scaled to the target size. */
function copyDrawImage(source: AnyCanvas, target: AnyCanvas): void {
  const ctx = ctx2d(target)
  if (ctx === null) {
    throw new Error(
      `rune: fanout('2d') — getContext('2d') on the target returned null (the target's context type is already taken). ` +
      'Use a fresh canvas or bitmap mode.',
    )
  }
  ctx.drawImage(source as CanvasImageSource, 0, 0, target.width, target.height)
}

/** Default copy, 'bitmap' mode: transferToImageBitmap → transferFromImageBitmap. */
function copyTransferBitmap(source: AnyCanvas, target: AnyCanvas): void {
  const ctx = ctxBitmapRenderer(target)
  if (ctx === null) {
    throw new Error(
      `rune: fanout('bitmap') — getContext('bitmaprenderer') on the target returned null (the target's context type is already taken). ` +
      "Use mode:'2d'.",
    )
  }
  const bitmap = (source as OffscreenCanvas).transferToImageBitmap()
  ctx.transferFromImageBitmap(bitmap)
}

/**
 * Fan-out: one source canvas → N target canvases.
 *
 * @throws mode:'bitmap' with a non-transferable source (an OffscreenCanvas is
 *         required) or with ≠1 target (transfer consumes the ImageBitmap — a
 *         second viewer will not receive it). 'auto' never falls into these traps.
 */
export function createFanout(
  source: AnyCanvas,
  targets: readonly AnyCanvas[],
  options: FanoutOptions = {},
): CanvasFanout {
  const mode = pickFanoutMode(source, targets, options.mode)
  if (mode === 'bitmap') {
    if (!isTransferableSource(source)) {
      throw new Error("rune: fanout('bitmap') — the source is not an OffscreenCanvas (no transferToImageBitmap). Use mode:'2d'.")
    }
    if (targets.length !== 1) {
      throw new Error(`rune: fanout('bitmap') — exactly one target (got ${targets.length}): transferFromImageBitmap consumes the ImageBitmap.`)
    }
  }

  const list: AnyCanvas[] = [...targets]
  const defaultCopy = mode === 'bitmap' ? copyTransferBitmap : copyDrawImage
  const copyOne: FanoutCopy = options.copy ?? defaultCopy
  let disposed = false

  function copy(): void {
    if (disposed) return
    for (const target of list) copyOne(source, target)
  }

  function add(target: AnyCanvas): void {
    if (disposed) return
    if (mode === 'bitmap' && list.length >= 1) {
      throw new Error("rune: fanout('bitmap') — a second target is impossible (transfer consumes the bitmap). Use mode:'2d'.")
    }
    if (!list.includes(target)) list.push(target)
  }

  function remove(target: AnyCanvas): void {
    const index = list.indexOf(target)
    if (index !== -1) list.splice(index, 1)
  }

  function dispose(): void {
    disposed = true
    list.length = 0
  }

  return { copy, add, remove, get targets() { return list }, mode, dispose }
}
