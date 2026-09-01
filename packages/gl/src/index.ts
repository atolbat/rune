// @rune/gl — мета-пакет: рендереры WebGL2/WebGPU, сахар show/showOn/showAny.
// §9.12: createRenderer — унифицированный entry point с авто-выбором бэкенда.

// Единый createRenderer — надстройка над обоими бэкендами (DESIGN.md §9.12).
export { createRenderer, BackendResolutionError } from './renderer.ts'
export type { Renderer, RendererOptions, AnyCommand, AnyFrameCallback, AnyRecorder } from './renderer.ts'

// Явные конструкторы для strict-режима.
export { createWebGL2Renderer } from './webgl2Renderer.ts'
export type { WebGL2Renderer, WebGL2RendererOptions, FrameContext, Recorder, FrameHandle, Texture, TextureView } from './webgl2Renderer.ts'
export { computeMipLevels } from './webgl2Renderer.ts'
export { createWebGpuRenderer } from './webgpuRenderer.ts'
export type { WebGpuRenderer, WebGpuRendererOptions, GpuFrameContext, GpuRecorder } from './webgpuRenderer.ts'

// M5 (Task 73): feed dual-bind — renderer.feed() на обоих бэкендах.
// Канал: T0/T1/T2 — SAB/local ринг (.buffer → воркеру через attachFeed),
// T3 — ping-pong (createMsgFeedWriter в воркере + applyChunks/takeRecycled).
export { createRendererFeedGL, createRendererFeedGPU } from './rendererFeed.ts'
export type {
  RendererFeed,
  RendererFeedOptions,
  RendererFeedStorage,
  FeedAttributeBinding,
} from './rendererFeed.ts'

export type { Surface, SurfaceOptions, PassOptions, TextureRef } from './surface.ts'

export { show } from './scene.ts'
export type { Show, ShowOptions } from './scene.ts'

export { showAny } from './showAny.ts'
export type { AnyShow } from './showAny.ts'
export { showOn, probeWebGpu } from './showOn.ts'
export type { BackendShow } from './showOn.ts'
export { showOnWebGpu } from './showWebgpu.ts'
export type { WebGpuShow } from './showWebgpu.ts'

// Авто-выбор бэкенда — чистая функция resolveBackend + типы.
// BackendId канонически живёт здесь (showOn.ts его реэкспортирует).
export { resolveBackend, shaderCoverage } from './autoBackend.ts'
export type { AutoDrawSpec, BackendId, BackendDecision, BackendVerdict, SpecCoverage } from './autoBackend.ts'

// Canvas helpers — поддержка OffscreenCanvas (внешние канвасы).
export { isOffscreenCanvas, getCanvasCssSize, canvasDpr, resolveCanvasAny } from './canvasHelpers.ts'
export type { AnyCanvas } from './canvasHelpers.ts'

// Task 78: скоуп доступности WebGPU — ДО инициализации, честно по потокам
// ('everywhere' | 'main-only' | 'worker-only' | 'nowhere'). Синхронный снимок
// фактов + микро-проба воркера (blob-Worker, миллисекунды, без GPU-инициализации).
export {
  webgpuAvailability,
  probeWebgpuScope,
  reportWebgpuMainFact,
  reportWebgpuWorkerFact,
  combineWebgpuScope,
  describeWebgpuScope,
  WEBUGPU_PROBE_MARKER,
  WEBUGPU_PROBE_SRC,
} from './webgpuScope.ts'
export type { WebgpuScope, WebgpuAvailability, WebgpuWorkerProbeState } from './webgpuScope.ts'

// Journal — реестр долгоживущих деклараций для device-loss recovery
// (= switchBackend = worker migration). §9.5 P3, §5.1, §9.9, §8 задача 1.
// Сам примитив живёт в @rune/core; здесь — декораторы и replay-helpers для
// обоих бэкендов: journalGl.ts (WebGL2) и journalGpu.ts (WebGPU, Task 57).
export { withJournal, replayJournalOn } from './journalGl.ts'
export { withJournalGpu, replayJournalOnGpu } from './journalGpu.ts'

// Task 62: ResourceJournal v2 — стабильные id + контент в журнале.
// resourceSession — сессия над фасадом (стабильные id, журналирование
// контента, restore). Создаётся рендерерами через опцию resources;
// напрямую полезна для тестов и headless-сценариев.
export { createResourceSessionGL } from './resourceSessionGL.ts'
export type { ResourceSessionGL } from './resourceSessionGL.ts'
export { createResourceSessionGPU } from './resourceSessionGPU.ts'
export type { ResourceSessionGPU } from './resourceSessionGPU.ts'
export { applyResOpGL } from './resourceSessionGL.ts'

// Task 68 (легаси-восстановление): портативность команд — адаптеры
// бэкендов и харнесс switchBackend/simulateLoss (один механизм replay).
export { webgl2Adapter, webgpuAdapter } from './adapters.ts'
export type { PortableSpec, BackendAdapter, CompiledOnBackend } from './adapters.ts'
export { createPortability } from './harness.ts'
export type { PortableCommand, ReplaySummary, PortabilityHarness } from './harness.ts'
