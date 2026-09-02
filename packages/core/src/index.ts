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
