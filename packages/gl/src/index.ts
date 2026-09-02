// @rune/gl — meta-package: WebGL2/WebGPU renderers, show/showOn/showAny sugar.
// §9.12: createRenderer — a unified entry point with automatic backend selection.

// A single createRenderer — a layer on top of both backends (DESIGN.md §9.12).
export { createRenderer, BackendResolutionError } from './renderer.ts'
export type { Renderer, RendererOptions, AnyCommand, AnyFrameCallback, AnyRecorder } from './renderer.ts'

// Explicit constructors for strict mode.
export { createWebGL2Renderer } from './webgl2Renderer.ts'
export type { WebGL2Renderer, WebGL2RendererOptions, FrameContext, Recorder, FrameHandle, Texture, TextureView } from './webgl2Renderer.ts'
export { computeMipLevels } from './webgl2Renderer.ts'
export { createWebGpuRenderer } from './webgpuRenderer.ts'
export type { WebGpuRenderer, WebGpuRendererOptions, GpuFrameContext, GpuRecorder } from './webgpuRenderer.ts'

// M5 (Task 73): feed dual-bind — renderer.feed() on both backends.
// Channel: T0/T1/T2 — SAB/local ring (.buffer → to the worker via attachFeed),
// T3 — ping-pong (createMsgFeedWriter in the worker + applyChunks/takeRecycled).
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

// Automatic backend selection — the pure resolveBackend function + types.
// BackendId canonically lives here (showOn.ts re-exports it).
export { resolveBackend, shaderCoverage } from './autoBackend.ts'
export type { AutoDrawSpec, BackendId, BackendDecision, BackendVerdict, SpecCoverage } from './autoBackend.ts'

// Canvas helpers — OffscreenCanvas support (external canvases).
export { isOffscreenCanvas, getCanvasCssSize, canvasDpr, resolveCanvasAny } from './canvasHelpers.ts'
export type { AnyCanvas } from './canvasHelpers.ts'

// Task 78: WebGPU availability scope — BEFORE initialization, honest per-thread
// ('everywhere' | 'main-only' | 'worker-only' | 'nowhere'). A synchronous snapshot
// of facts + a micro probe of the worker (blob Worker, milliseconds, no GPU initialization).
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

// Journal — a registry of long-lived declarations for device-loss recovery
// (= switchBackend = worker migration). §9.5 P3, §5.1, §9.9, §8 task 1.
// The primitive itself lives in @rune/core; here — decorators and replay helpers
// for both backends: journalGl.ts (WebGL2) and journalGpu.ts (WebGPU, Task 57).
export { withJournal, replayJournalOn } from './journalGl.ts'
export { withJournalGpu, replayJournalOnGpu } from './journalGpu.ts'

// Task 62: ResourceJournal v2 — stable ids + content in the journal.
// resourceSession — a session over the facade (stable ids, content
// journaling, restore). Created by renderers via the resources option;
// directly useful for tests and headless scenarios.
export { createResourceSessionGL } from './resourceSessionGL.ts'
export type { ResourceSessionGL } from './resourceSessionGL.ts'
export { createResourceSessionGPU } from './resourceSessionGPU.ts'
export type { ResourceSessionGPU } from './resourceSessionGPU.ts'
export { applyResOpGL } from './resourceSessionGL.ts'

// Task 68 (legacy recovery): command portability — backend
// adapters and the switchBackend/simulateLoss harness (one replay mechanism).
export { webgl2Adapter, webgpuAdapter } from './adapters.ts'
export type { PortableSpec, BackendAdapter, CompiledOnBackend } from './adapters.ts'
export { createPortability } from './harness.ts'
export type { PortableCommand, ReplaySummary, PortabilityHarness } from './harness.ts'
