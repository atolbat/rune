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

// Task 198 — THE COMMON BRICKS: one device facade over both backends. The
// demos' two API dialects (gpu.* vs gl*) collapse into one syntax: the
// scene/pyramid/program/kernel/drawVisible bricks route to the backend's
// own mechanisms (compute vs transform feedback, indirect vs collapse).
// Task 200 adds the SCENARIO brick (hizScene) — the dictionary + handles
// become a one-call frame — and re-exports the clean spatial structures
// (octree + BVH) so the dist surface carries them for the demos.
export { createDevice } from './device.ts'
export type {
  RenderDevice, DeviceOptions, DeviceBackend, DeviceClear,
  SceneLayout, SceneHandle, ProgramSpec, ProgramHandle, GeometryHandle,
  PyramidHandle, CullerSpec, CullerHandle, DrawOptions, CullStats,
  DeviceSurface, UniformLane, GlAttrDecl,
  HizFrameSpec, HizFrameCall, HizFrameHandle,
  HizPassSources, HizShaderDict, HizSceneSpec, HizSceneFrame, HizSceneHandle,
  PassShaders, KernelShaders,
  DepthPassCall, DepthPassHandle, OcclusionPassCall, OcclusionPassHandle,
  HysteresisPassCall, HysteresisPassHandle,
  HistoryPassCall, HistoryPassHandle,
  FeedbackPassCall, FeedbackPassHandle,
  VisiblePassCall, VisiblePassHandle, DebugStripHandle,
  // Task 209 — the compact's debug readout (the near-first order's gate channel)
  VisibleListReadout,
} from './device.ts'
// Task 200/201 — the clean spatial structures (octree + BVH, now with the
// rays, hit tests, spheres, and the dynamic octree) and THE COMPOSABLE
// CULLING KIT (the pure policies + CPU bricks the frame recipes compose
// from): the dist surface carries them for the demos.
export {
  buildOctree, buildBVH, buildOctreeRecords, buildBVHRecords, aabbOutsideFrustum, aabbInsideFrustum, frustumPlanes,
  recordView, projectBox, frustumVerdicts,
  hysteresisPolicy, decodeVerdict, decodeStreak, HYST_STREAK_SCALE,
  flatCull, layerPolicy, clusterize, softwareOccluder,
  cameraRay, rayBoxes,
  // Task 203 — THE FRAME GRAPH (the «супер рендеринг» architecture): the
  // declarative pass/resource DAG the engine compiles (branch culling,
  // transient lifetimes + the aliasing planner, barrier emission, the
  // 3-lane overlap plan, the cross-frame version law) — pure, and the
  // executes are the caller's own brick calls. The dist surface carries
  // it for the demos.
  createFrameGraph,
  // Task 211 — THE UNIFIED DATA SURFACE (store.ts): schema-driven SoA
  // columns over ONE backing buffer, the measured growth ladder (RAB's
  // in-place remap where the runtime wins — the pick MEASURED once per
  // process), the MarkSet bitset with both iteration lanes, packed u32
  // keys (the comparator-free order), and the dirty-range surface the
  // device's partial record upload reads — the dist surface carries it
  // for the demos.
  createStore, adoptStore, createMarkSet, createMarkSetFrom,
  packKey, unpackKeyHi, unpackKeyLo,
  // Task 216 — THE KINEMATIC CHARACTER + THE ADAPTIVE SCALE GOVERNOR:
  // the walker demo's two pure core bricks (the ground-oracle controller
  // and the frame-time ladder) — the dist surface carries them for the
  // demos.
  createCharacter, createScaleGovernor,
} from '@rune/core'
export type { SpatialBox, SpatialIndex, RayHit } from '@rune/core'
export type {
  CharacterSpec, CharacterWorld, CharacterInput, CharacterState,
  Character, GroundContact,
  ScaleGovernor, ScaleGovernorSpec, ScaleGovernorSample,
} from '@rune/core'
export type {
  RecordView, ProjectedBox, HysteresisPolicy, FlatCull,
  LayerVerdict, SpatialCluster,
  FgResourceDesc, FgResource, FgPinnedRead, FgPassDesc, FgRunCtx, FgViewInfo,
  FgEdge, FgBarrier, FgLifetime, FgSlot, FgOverlap, FgStats, FgRunReport,
  CompiledFrame, FrameGraph, FgResolveHooks,
  FgResourceKind, FgPassKind, FgLane,
  SoAStore, StoreColumn, StoreKind, StoreOptions, GrowthPolicy, UploadRange, MarkSet,
} from '@rune/core'

// M5 (Task 73): feed dual-bind — renderer.feed() on both backends.
// Channel: T0/T1/T2 — SAB/local ring (.buffer → to the worker via attachFeed),
// T3 — ping-pong (createMsgFeedWriter in the worker + applyChunks/takeRecycled).
export { createRendererFeedGL, createRendererFeedGPU } from './rendererFeed.ts'
export { createGpuParticles } from './particlesGpu.ts'
export type { GpuParticles } from './particlesGpu.ts'
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
// Task 168 — THE RESTORE WIRE: the v2 resource journal factory, re-exported
// from the umbrella so the DIST surface can actually build the session path
// (`resources: createResourceJournal()` — the option that arms the
// automatic webglcontextrestored recovery). Without this re-export the
// option was bundle-unusable (the factory lived only in @rune/core's
// export surface, which the browser bundle does not re-export).
export { createResourceJournal } from '@rune/core'
export type { ResourceJournal, RestoreReport, WorkingSet } from '@rune/core'

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

// @rune/prims — the procedural geometry generators, re-exported for the
// demos and CDN consumers (the build header always promised "prims
// inside"): the basic solids the particle/mesh demos bake into soups.
export { cube, box } from '@rune/prims'
export type { CubeGeometry, BoxParams } from '@rune/prims'
// Task 216 — the terrain bricks: the height GRID (collision's half) +
// the EXACT-MESH sampler (the walker's ground oracle) + the soup builder
export { terrain, terrainGrid, gridHeightSampler, heightHills } from '@rune/prims'
export type { TerrainGrid } from '@rune/prims'
export { quad, plane } from '@rune/prims'
export type { QuadGeometry, PlaneParams } from '@rune/prims'
export { sphere, capsule, torus, torusKnot } from '@rune/prims'
export type { SphereParams, CapsuleParams, TorusParams, TorusKnotParams } from '@rune/prims'
