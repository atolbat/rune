// Task 97: канвас-фан-аут — «один внутренний канвас → N внешних».
//
// РОДОСЛОВНАЯ. Мысль заказчика («движок создаёт рабочий канвас сам, внешний
// назначается на показ») прогнана через demo/bench-present.html — 13 present-
// путей на SwiftShader: transferToImageBitmap → bitmaprenderer на одном
// зрителе НЕ ХУЖЕ direct (22.9 против 22.5 wall fps), drawImage×N — рабочий
// путь многих зрителей (multi4: −4 fps за 4 копии на софтверном GL). DESIGN.md
// §5.5 планировал present.ts (PathRegistry + PathState, деградационная машина)
// на M8 — ЭТОТ модуль первый рантайм-срез того плана: только фан-аут.
//
// КОНТРАКТ:
//  - источник: канвас рендерера. WebGL2-путь rune запрашивает
//    preserveDrawingBuffer:true (acquireWebGL2) — drawImage читает канвас
//    ВНЕ кадра; WebGPU-канвас тоже валидный CanvasImageSource; OffscreenCanvas
//    дополнительно открывает режим 'bitmap' (transferToImageBitmap);
//  - цели: N канвасов любого размера — drawImage масштабирует (превью-сетка);
//  - '2d': цель.getContext('2d') берётся лениво и кэшируется; источник не
//    «потребляется» — N копий одного кадра легальны;
//  - 'bitmap': РОВНО одна цель — transferFromImageBitmap съедает ImageBitmap
//    (второму зрителю нечего принять); источник обязан быть OffscreenCanvas
//    (transferToImageBitmap отсоединяет фронт-буфер — фрейм-циклу безразлично,
//    следующий кадр пишет в новый буфер; bench-режим 'bitmap', 138 кадров);
//  - 'auto': одна цель + передаваемый источник → 'bitmap', иначе '2d'. ВАЖНО:
//    авто НЕ пробит target.getContext('bitmaprenderer') вперёд — вызов
//    РЕЗЕРВИРУЕТ тип контекста цели навсегда (один тип на канвас, тот же
//    инцидент context-conflict, что и webgpu-vs-webgl2). Проба — при первом
//    copy(); null → честная ошибка с подсказкой mode:'2d';
//  - copy() синхронный, читает ПОСЛЕДНИЙ ПРЕДСТАВЛЕННЫЙ кадр. Из frame-колбэка
//    это кадр N-1 (колбэки исполняются ДО ленты — см. step()), сразу после
//    renderer.step() — кадр N. Для зеркал/превью один кадр латентности — норма;
//  - фан-аут НЕ владеет ни источником, ни целями: dispose() снимает только
//    ссылки и кэш контекстов. Идемпотентен.

import type { AnyCanvas } from './canvasHelpers.ts'

/** Режим, выбранный пользователем (auto — решить по источнику/целям). */
export type FanoutMode = 'auto' | '2d' | 'bitmap'

/** Режим после разрешения auto (то, что реально исполняет копию). */
export type ResolvedFanoutMode = '2d' | 'bitmap'

/** Одна копия кадра источник → цель (инъекция для headless-тестов). */
export type FanoutCopy = (source: AnyCanvas, target: AnyCanvas) => void

export interface FanoutOptions {
  /** 'auto' (default): 1 цель + OffscreenCanvas-источник → 'bitmap', иначе '2d'. */
  readonly mode?: FanoutMode
  /** Инъекция копии (headless-тесты без DOM-канвасов). */
  readonly copy?: FanoutCopy
}

export interface CanvasFanout {
  /** Размножить последний представленный кадр во все цели. */
  copy(): void
  /** Добавить цель (в 'bitmap' — только единственную). */
  add(target: AnyCanvas): void
  /** Убрать цель (и её кэшированный 2d-контекст). Идемпотентно. */
  remove(target: AnyCanvas): void
  readonly targets: readonly AnyCanvas[]
  readonly mode: ResolvedFanoutMode
  /** Снять ссылки на цели и кэш контекстов. Не трогает канвасы. Идемпотентно. */
  dispose(): void
}

/** Источник поддерживает transferToImageBitmap (OffscreenCanvas). */
function isTransferableSource(source: AnyCanvas): boolean {
  return typeof (source as Partial<OffscreenCanvas>).transferToImageBitmap === 'function'
}

/**
 * Чистая функция выбора режима (тестируется без DOM).
 * Правила: явный '2d'/'bitmap' — как просили; 'auto' → 'bitmap' только при
 * ровно одной цели И передаваемом источнике (transfer потребляет битмап —
 * много зрителей им не накормить), иначе '2d'.
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

/** 2d-контекст цели (HTMLCanvasElement | OffscreenCanvas — оба умеют drawImage). */
function ctx2d(canvas: AnyCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  return (canvas as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null
}

/** bitmaprenderer-контекст цели (потребляется transferFromImageBitmap). */
function ctxBitmapRenderer(canvas: AnyCanvas): ImageBitmapRenderingContext | null {
  return (canvas as HTMLCanvasElement).getContext('bitmaprenderer') as ImageBitmapRenderingContext | null
}

/** Копия по умолчанию, режим '2d': drawImage с масштабом под размер цели. */
function copyDrawImage(source: AnyCanvas, target: AnyCanvas): void {
  const ctx = ctx2d(target)
  if (ctx === null) {
    throw new Error(
      `rune: fanout('2d') — getContext('2d') на цели вернул null (тип контекста цели уже занят). ` +
      'Используйте свежий канвас или режим bitmap.',
    )
  }
  ctx.drawImage(source as CanvasImageSource, 0, 0, target.width, target.height)
}

/** Копия по умолчанию, режим 'bitmap': transferToImageBitmap → transferFromImageBitmap. */
function copyTransferBitmap(source: AnyCanvas, target: AnyCanvas): void {
  const ctx = ctxBitmapRenderer(target)
  if (ctx === null) {
    throw new Error(
      `rune: fanout('bitmap') — getContext('bitmaprenderer') на цели вернул null (тип контекста цели уже занят). ` +
      "Используйте mode:'2d'.",
    )
  }
  const bitmap = (source as OffscreenCanvas).transferToImageBitmap()
  ctx.transferFromImageBitmap(bitmap)
}

/**
 * Фан-аут: один канвас-источник → N канвасов-целей.
 *
 * @throws mode:'bitmap' с непередаваемым источником (нужен OffscreenCanvas)
 *         или с ≠1 целью (transfer потребляет ImageBitmap — второй зритель
 *         не примет). 'auto' никогда не попадает в эти ловушки.
 */
export function createFanout(
  source: AnyCanvas,
  targets: readonly AnyCanvas[],
  options: FanoutOptions = {},
): CanvasFanout {
  const mode = pickFanoutMode(source, targets, options.mode)
  if (mode === 'bitmap') {
    if (!isTransferableSource(source)) {
      throw new Error("rune: fanout('bitmap') — источник не OffscreenCanvas (нет transferToImageBitmap). Используйте mode:'2d'.")
    }
    if (targets.length !== 1) {
      throw new Error(`rune: fanout('bitmap') — ровно одна цель (получено ${targets.length}): transferFromImageBitmap потребляет ImageBitmap.`)
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
      throw new Error("rune: fanout('bitmap') — вторая цель невозможна (transfer потребляет битмап). Используйте mode:'2d'.")
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
