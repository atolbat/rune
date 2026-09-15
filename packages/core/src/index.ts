// @rune/core — signals, epochs, tapes, segments/live, the uniform arena,
// streaming (AIMD), the transient pool, layoutGuard. DOM-free by construction.
// Modules restored after the environment reset (Task 68): batch/effect,
// uniformSet/frequencyArena, feed, uploadQueue, sharedRegistry,
// reflectGlsl/reflectWgsl, serializeTape/parseTape — legacy surfaces
// returned to the public API (tests + the tape package + portability harness).

export { signal } from './signal/signal.ts'
export type { SignalOptions, SignalCell } from './signal/signal.ts'
export { derive } from './signal/derive.ts'
export type { ReadableSignal, Subscriber, Unsubscribe } from './signal/types.ts'
export { batch, schedule } from './signal/batch.ts'
export { effect } from './signal/effect.ts'

export { createEpoch } from './epoch/epoch.ts'
export type { EpochHarness } from './epoch/epoch.ts'
export { createTransientPool } from './pool/transientPool.ts'
export type { TransientPool, TransientPoolStats } from './pool/transientPool.ts'

export { OpCode } from './tape/opcodes.ts'
export { createTapeWriter } from './tape/writer.ts'
export type { TapeWriter, WriterColumns } from './tape/writer.ts'
export { writerView } from './tape/layout.ts'
export type { TapeView } from './tape/layout.ts'
export { serializeTape, parseTape } from './tape/serialize.ts'
export type { ParsedTape } from './tape/serialize.ts'
export { createSegmentStore } from './tape/segments.ts'
export type { Segment, SegmentStore } from './tape/segments.ts'

export { createLiveCommand } from './live/liveCommand.ts'
export type { LiveCommand } from './live/liveCommand.ts'
export { buildFrame, buildFrameReRecording } from './live/frameBuilder.ts'

export { createUniformArena } from './uniforms/arena.ts'
export type { UniformArena, UniformSlot, DirtyRange, ByteRange, UniformSlotBytes } from './uniforms/arena.ts'
export { createUniformSet } from './uniforms/uniformSet.ts'
export type { UniformSet, UniformSetSchema, UniformSetFieldType, UniformSetValue } from './uniforms/uniformSet.ts'
export { createFrequencyArena } from './uniforms/frequencyArena.ts'
export type { FrequencyArena } from './uniforms/frequencyArena.ts'

export { createUploadScheduler } from './streaming/uploadScheduler.ts'
export type { UploadScheduler, UploadSchedulerOptions } from './streaming/uploadScheduler.ts'
export { chunkRect, countTiles, tileForBudget, tileBytes } from './streaming/chunker.ts'
export type { TileRect } from './streaming/chunker.ts'
export { streamTexture } from './streaming/textureUpload.ts'
export type { TextureUpload, TextureUploadOptions, TextureUploadResult, TileUploader } from './streaming/textureUpload.ts'

export { createLayoutGuard } from './transport/layoutGuard.ts'
export type { LayoutGuardApi, ResizeResult, ResizeVerdict } from './transport/layoutGuard.ts'
export { createSharedRegistry, attachSharedRegistry, nameHash, schemaHash, SHARED_MAGIC } from './transport/sharedRegistry.ts'
export type { SharedRegistry, SharedMirror } from './transport/sharedRegistry.ts'

// M5 (Task 73): cross-thread transports T0–T3 + T3 ping-pong feeds.
export { detectTransport, hasSharedArrayBuffer, createTransport, createTransportHost, attachTransport, createMsgFeedWriter, createMsgFeedReader } from './transport/transport.ts'
export type {
  TransportMode,
  TransportProbe,
  TransportHost,
  TransportClient,
  TransportPair,
  TransportDescriptor,
  TransportFeedMeta,
  TransportFeedView,
  TransportFeedChunk,
  TransportFrameMessage,
  MsgFeedWriterHandle,
  MsgFeedReaderHandle,
} from './transport/transport.ts'

export { createFeed, attachFeed, feedStride, feedFieldSize } from './feed/feed.ts'
export type { Feed, FeedWriter, FeedLayout, FeedFieldFormat, FeedPolicy, FeedOptions, FeedBacking } from './feed/feed.ts'

export { createUploadQueue } from './streaming/uploadQueue.ts'
export type { UploadQueue, UploadJob } from './streaming/uploadQueue.ts'

export { reflectGlsl } from './shader/glslReflect.ts'
export type { GlslReflection, UniformInfo, AttributeInfo } from './shader/glslReflect.ts'
export { reflectWgsl } from './shader/wgslReflect.ts'
export type { WgslReflection, WgslUniformInfo, WgslAttributeInfo, WgslTextureInfo, WgslEntryPoints } from './shader/wgslReflect.ts'

export { createJournal, toFloat32Array } from './journal/journal.ts'
export type {
  Journal,
  JournalSnapshot,
  DeclOp,
  ClearColor,
} from './journal/journal.ts'

// Task 62: ResourceJournal v2 — stable ids + content in the journal.
// Task 65: WorkingSet + selectResidentOps — soft reset (lazy residency).
export { createResourceJournal, selectResidentOps } from './journal/resourceJournal.ts'
export type {
  ResourceJournal,
  ResourceJournalSnapshot,
  ResOp,
  ContentRef,
  ContentManifestEntry,
  RestoreReport,
  // TextureFormat now comes from formats.ts (Task 110) — a superset
  // of the old journal type ('rgba8unorm'|'canvas'|'rgba16float'|'rgba32float' ⊂ TextureFormatId|'canvas').
  ClearColor2,
  WorkingSet,
  ResidentSelection,
} from './journal/resourceJournal.ts'
export {
  decideRecovery,
  createLossBudget,
  classifyGpuError,
  classifyDeviceLost,
  LOSS_STORM_WINDOW_MS,
  LOSS_STORM_MAX,
} from './journal/lossPolicy.ts'
export type { LossKind, LossBackend, LossEvent, LossDecision, LossBudget, RecoveryStrategy } from './journal/lossPolicy.ts'

// Task 66: LRU residency policy — memory pressure between losses
// (pressure → evict: GPU memory estimate → budget → LRU eviction).
// Task 67: textureFormatBytesPerPixel — HDR format weight estimate.
export { estimateTextureBytes, selectLRUEvictions, textureFormatBytesPerPixel } from './journal/residency.ts'
export type { ResidencyEntry, EvictionSelection, EvictionReport, ResidencyStats } from './journal/residency.ts'

export { createCaps, createStatsCollector } from './caps.ts'
export type {
  Caps,
  CapsQuery,
  StatsProvider,
  StatsCollector,
  GpuTimer,
  RendererStats,
  FeatureId,
  FeatureName,
  FormatAxis,
  FormatSupport,
  PathSupport,
} from './caps.ts'

// Task 110 (FFT ocean): the full texture format catalog — the shared axis
// of pipeline/target variants for WebGL2 and WebGPU (formats.ts).
export type {
  TextureFormatFamily,
  TextureFormatKind,
  TextureFormatNumeric,
  TextureFormatSampleType,
  TextureFormatInfo,
  TextureFormatId,
  TextureFormat,
} from './formats.ts'
export { TEXTURE_FORMATS, textureFormatInfo, normalizeTextureFormat } from './formats.ts'

// ─── Task 133: the foundation primitives moved out of @rune/particles ──────
// The dual-backend GPGPU tier controller (the SSBO↔transform-feedback
// common point: the dispatch, the tracked-resource lifecycle, the uniform
// scratch) + the deterministic simplex noise (the CPU↔GPU-parity tables)
// + the repo-standard integer-hash uniform. Abstract, consumer-agnostic.
export { createGpgpu, createSsboTier, createTfTier, createGpuScratch, GPU_BUFFER_USAGE } from './gpgpu.ts'
export type {
  GpgpuTier,
  SsboComputeFacade,
  TfComputeFacade,
  SsboComputeTier,
  TfComputeTier,
  TfPassDesc,
  TfRunBindings,
  GpuUniformScratch,
} from './gpgpu.ts'
export { simplex3, PERM, GRAD3 } from './noise.ts'
export { hash01 } from './random.ts'

// ─── Task 141: the sort/cull foundation moved out of @rune/particles ───────
// The Gribb–Hartmann frustum (one extraction for the scene culler, the
// particle bakers and the GPU render tier's shader test), the bitonic
// sort network's plan (the (k, j) sequence + the pad/sentinel pair — the
// stockham.ts precedent: a plan as pure data, backends execute), and the
// SoA painter's order. Abstract, consumer-agnostic.
export {
  frustumPlanes, classifySphere, sphereOutsideFrustum,
  SPHERE_OUTSIDE, SPHERE_INTERSECT, SPHERE_INSIDE, FRUSTUM_PLANE_COUNT,
} from './frustum.ts'

// ─── Task 200: the clean hierarchical cull structures ──────────────────────
// The octree (uniform subdivision, region queries) and the BVH (longest-axis
// median splits, tight bounds) — both pure, both over the same SpatialBox
// contract, both driving the SAME AABB–plane predicate the Hi-Z kernel
// mirrors on the GPU. The CPU-side spatial index the GPU-driven demos
// lacked: a worker's pre-shipping cull, an occluder ranking, a marquee.
// Task 201: rays (queryRay/raycast), spheres, points (hit tests), and the
// dynamic octree (insert/remove/update) grew the same surface.
export { buildOctree, buildBVH, buildOctreeRecords, buildBVHRecords, aabbOutsideFrustum, aabbInsideFrustum } from './spatial.ts'
export type { SpatialBox, SpatialIndex, RayHit } from './spatial.ts'
// ─── Task 211: THE UNIFIED DATA SURFACE ────────────────────────────────────
// The Task-210 array laws applied as a SYSTEM: schema-driven SoA columns
// over ONE backing buffer (createStore — fresh; adoptStore — the scene
// buffer's own pattern, zero copies), the measured growth ladder (RAB's
// in-place remap where the runtime wins, the copy twin elsewhere — 'auto'
// MEASURES once per process), the MarkSet bitset companion (both iteration
// modes — the sparse word-walk and the dense rank scan, the crossover
// documented), packed u32 keys (the comparator-free order), and the
// dirty-range surface the GPU mirrors read (coalesced, 4-aligned —
// writeBuffer / bufferSubData over the same bytes, no staging).
export {
  createStore, adoptStore, createMarkSet, createMarkSetFrom,
  packKey, unpackKeyHi, unpackKeyLo,
} from './store.ts'
export type {
  StoreColumn, StoreKind, StoreOptions, GrowthPolicy, UploadRange, SoAStore, MarkSet,
} from './store.ts'
// Task 201 — THE COMPOSABLE CULLING KIT: the policies (hysteresis, flat
// billboards, layers) and the CPU bricks (the software occluder, the
// vegetation clustering, the picking ray) the frame recipes compose from.
// Pure, device-free, SoA over the scenario's own Float32Array.
export {
  recordView, projectBox, frustumVerdicts,
  hysteresisPolicy, decodeVerdict, decodeStreak, HYST_STREAK_SCALE,
  flatCull, layerPolicy, clusterize, softwareOccluder,
  cameraRay, rayBoxes,
} from './culling.ts'
export type {
  RecordView, ProjectedBox, HysteresisPolicy, FlatCull,
  LayerVerdict, SpatialCluster,
} from './culling.ts'
// ─── Task 203: THE FRAME GRAPH — the «супер рендеринг» architecture ────────
// Render passes as declarative data (versioned resource handles), the
// frame compiled into a DAG: dead-branch culling (the shadows-off class),
// transient lifetimes + the memory-aliasing planner (the console's slot
// math), automatic barrier emission, the 3-lane async-compute overlap
// plan, and the cross-frame version law that makes temporal reuse (the
// amortized cull, the two-pass HZB) a first-class, MEASURED concept.
// Pure/DOM-free — the executes are the caller's own brick calls.
export { createFrameGraph } from './framegraph.ts'
export type {
  FgResourceDesc, FgResource, FgPinnedRead, FgPassDesc, FgRunCtx, FgViewInfo,
  FgEdge, FgBarrier, FgLifetime, FgSlot, FgOverlap, FgStats, FgRunReport,
  CompiledFrame, FrameGraph, FgResolveHooks,
  FgResourceKind, FgPassKind, FgLane,
} from './framegraph.ts'
export {
  bitonicPadCount, bitonicPassSequence, BITONIC_PAD_KEY, BITONIC_SENTINEL,
} from './gpu/bitonic.ts'
export { sortBackToFront, RADIX_16BIT_MIN } from './sort.ts'
export type { SortScratch } from './sort.ts'

// ─── Task 216: THE KINEMATIC CHARACTER + THE ADAPTIVE SCALE ────────────────
// The first-person walker's two pure bricks: the character controller (a
// ground-oracle-driven kinematic body — the ray law, the feel laws: coyote
// / buffer / step-up / glue, the mover carry, fixed-substep determinism,
// zero steady-state allocations) and the render-scale governor (the
// mobile-first adaptive resolution: an EMA over frame times, a hysteresis
// ladder with cooldown — pure, testable, engine-free).
export { createCharacter } from './character.ts'
export type {
  CharacterSpec, CharacterWorld, CharacterInput, CharacterState,
  Character, GroundContact,
} from './character.ts'
export { createScaleGovernor } from './scale.ts'
export type { ScaleGovernor, ScaleGovernorSpec, ScaleGovernorSample } from './scale.ts'
