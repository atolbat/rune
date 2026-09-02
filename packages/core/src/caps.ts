/**
 * Caps — backend capabilities module (M4, DESIGN.md §11.4 + §5.2).
 *
 * Contract (dossier v1.0 §11.4, added in addendum §5.2):
 *  - caps.has(FeatureId): boolean            — is the feature available natively?
 *  - caps.format(f, axis): FormatSupport    — 6-axis format matrix
 *  - caps.path(name): PathSupport           — present-path portability
 *  - caps.ext(name): unknown | null        — escape-hatch to the raw extension
 *  - caps.stats(): RendererStats           — cpuMs, gpuMs, memoryEstimate, hit-rate
 *  - caps.invalidate(): void                — cache reset (after device-loss / backend-swap)
 *
 * Design: a backend-agnostic skeleton in @rune/core. The backend (WebGL2 / WebGPU)
 * probes the real environment and supplies `CapsQuery` — a structure with measured
 * capabilities. `createCaps(query, statsProvider)` builds a closed object with
 * interface methods.
 *
 * RendererStats — runtime metrics, updated by the renderer every frame.
 * cpuMs — a performance.now() wrapper around the frame callback (cheap, everywhere).
 * gpuMs — requires EXT_disjoint_timer_query (WebGL2) or pipeline-statistics-query
 * (WebGPU feature). Without the extension = null — honest, not a fake 0.
 * memoryEstimate — a manual counter: texture size (w*h*channels*bytesPerChannel)
 * + buffer size. In @rune/webgl2 realGL keeps a Map<textureId, GPUTexture>
 * — bytes are counted there as well.
 *
 * Contract 5 (gate honesty): an unavailable capability is null or 'none'
 * in the matrix, not a silent crash. caps.has('float-blend') === false
 * on Mali without EXT_float_blend — the user can gate code on this.
 */

// ─── FeatureId — canonical feature names ──────────────────────────────────────
//
// WebGPU features ↔ FeatureId mapping (per the canon):
//   texture-compression-astc  → 'astc'
//   texture-compression-bc    → 'bc1' | 'bc3' | 'bc7' (one flag → 3 FeatureIds)
//   texture-compression-etc2  → 'etc2'
//   depth-clamping            → 'depth-clamp'
//   timestamp-query           → 'timestamp-query'
//   pipeline-statistics-query → 'pipeline-stats'
//   occlusion-query           → 'occlusion-query'
//   bgra8unorm-storage        → 'bgra8-storage'
//   float32-filterable        → 'float32-filterable'
//
// WebGL2 extensions ↔ FeatureId mapping:
//   WEBGL_compressed_texture_astc  → 'astc'
//   WEBGL_compressed_texture_s3tc  → 'bc1' | 'bc3' (BC1=RGB DXT1, BC3=RGBA DXT5)
//   EXT_texture_compression_rgtc   → 'bc4' | 'bc5'
//   WEBGL_compressed_texture_etc   → 'etc2'
//   WEBGL_compressed_texture_pvrtc → 'pvrtc'
//   EXT_color_buffer_float         → 'float32-render' | 'float32-blend'
//   EXT_float_blend                → 'float32-blend'
//   OES_texture_float              → 'float32-texture'
//   OES_texture_half_float         → 'float16-texture'
//   EXT_texture_filter_anisotropic → 'anisotropic'
//   ANGLE_instanced_arrays          → 'instancing' (but in WebGL2 — native!)
//   EXT_disjoint_timer_query_webgl2 → 'timestamp-query'
//   OES_texture_float_linear       → 'float32-filterable'
//
// 'instancing' is native in WebGL2 (gl.drawArraysInstanced), no extension needed.
// In WebGPU — always present (drawIndirect/vertex buffers), but limits.maxDrawBuffers
// may be 0 in a software fallback.

export type FeatureId =
  // Compression
  | 'astc'
  | 'etc2'
  | 'bc1'
  | 'bc3'
  | 'bc4'
  | 'bc5'
  | 'bc7'
  | 'pvrtc'
  // Texture formats
  | 'float16-texture'
  | 'float32-texture'
  | 'float16-render'
  | 'float32-render'
  | 'float16-blend'
  | 'float32-blend'
  | 'float32-filterable'
  | 'rg11b10ufloat-render'
  | 'shared-exponent'
  // Filtering / sampling
  | 'anisotropic'
  | 'linear-filter-half-float'
  | 'linear-filter-float'
  // Geometry / draw
  | 'instancing'
  | 'draw-indirect'
  | 'multi-draw-indirect'
  | 'base-instance'
  // Compute
  | 'compute'
  | 'storage-buffer'
  | 'storage-texture'
  // Render
  | 'msaa-2x'
  | 'msaa-4x'
  | 'msaa-8x'
  | 'msaa-16x'
  | 'depth-texture'
  | 'depth-clamp'
  | 'wireframe'
  // Queries / timing
  | 'timestamp-query'
  | 'occlusion-query'
  | 'pipeline-stats'
  // Buffer / memory
  | 'map-buffer'
  | 'persistent-mapping'
  // Surfaces
  | 'offscreen-canvas'
  | 'video-frame'
  | 'bgra8-storage'

/** String aliases are allowed for extensions not listed in FeatureId. */
export type FeatureName = FeatureId | (string & {})

// ─── FormatAxis — 6 axes of the format portability matrix ──────────────────────

export type FormatAxis =
  | 'sampled'    // texturing (texture() in the shader)
  | 'render'     // as a render target (color attachment)
  | 'blend'      // blending works when used as a render target
  | 'filter'     // linear filtering available (not just nearest)
  | 'msaa'       // multisample render target
  | 'storage'    // storage texture (imageStore / writeonly storage)

// ─── FormatSupport — support level ───────────────────────────────────────

export type FormatSupport =
  | 'native'    // natively supported by the GPU
  | 'fallback'  // emulation (slow) — not for a production hot path
  | 'none'      // not supported

// ─── PathSupport — present-path portability (simplified for M4) ────────────
//
// A full PathRegistry with PathState (healthy/degraded/disabled via Decay.ratio)
// — that is M8 (#61, #62). In M4 — a simplified PathSupport: supported/unsupported.
// RendererStats and degradationRatio will arrive in M8 with PathState.

export type PathSupport = 'supported' | 'unsupported' | 'unknown'

// ─── RendererStats — per-frame runtime metrics ──────────────────────────────────
//
// Updated by the renderer every frame. Snapshot via caps.stats().
// hitRate — for now always 1.0 (no shader compilation cache with invalidatable
// state); will be wired when cache-invalidation triggers appear.

export interface RendererStats {
  /** CPU-side time to process a frame (ms). Includes: frame callback, recorder
   *  push, dispatch Tape. Does not include rAF-wait. Measured via performance.now(). */
  readonly cpuMs: number
  /** GPU-side time to draw (ms). null if there is no timer-query extension
   *  (EXT_disjoint_timer_query / pipeline-statistics-query). Honestly null —
   *  not a fake 0. */
  readonly gpuMs: number | null
  /** Estimate of GPU memory used (bytes). Sum: textures (w*h*channels*bpc) +
   *  vertex buffers (data.length * 4 for Float32Array). Not exact — does not count
   *  mip chains (×1.33) or alignment/padding. Good enough for dashboards. */
  readonly memoryEstimate: number
  /** Number of draw calls in the last frame. */
  readonly drawCalls: number
  /** Frame counter since start. */
  readonly frameCount: number
  /** Cache hit-rate (0..1). For now always 1.0 — no invalidations. */
  readonly hitRate: number
}

// ─── CapsQuery — what the backend probes and supplies to createCaps ─────────────

/**
 * The backend-dependent part of Caps. Filled in by webgl2/capsProbe or webgpu/capsProbe
 * at renderer startup. createCaps(query) builds a closed Caps object.
 */
export interface CapsQuery {
  /** The set of available FeatureIds. */
  readonly features: ReadonlySet<FeatureName>
  /** Map of format × axis → support. Key — `${format}|${axis}`. */
  readonly formatMatrix: ReadonlyMap<string, FormatSupport>
  /** Map of present-path → support. */
  readonly paths: ReadonlyMap<string, PathSupport>
  /** Map of extension name → raw object (getExtension / features.has). */
  readonly extensions: ReadonlyMap<string, unknown>
  /** Adapter limits (maxTextureSize, maxBufferSize, maxTextureUnits, etc.). */
  readonly limits: Readonly<Record<string, number>>
  /** Backend string: 'webgl2' | 'webgpu' | 'webgl1' | 'software'. */
  readonly backend: string
}

// ─── StatsProvider — renderer callback for fresh metrics ─────────────────

export type StatsProvider = () => RendererStats

// ─── Caps — public interface (dossier §11.4) ───────────────────────────────

export interface Caps {
  /** Whether the feature is available natively (not 'fallback'). */
  has(f: FeatureName): boolean
  /** Format support along an axis. */
  format(f: string, axis: FormatAxis): FormatSupport
  /** Present-path portability (simplified for M4). */
  path(name: string): PathSupport
  /** Raw extension (escape-hatch). null if unavailable. */
  ext(name: string): unknown | null
  /** Fresh frame metrics. */
  stats(): RendererStats
  /** Adapter limit (maxTextureSize2D, maxBufferSize, ...). */
  limit(name: string): number | null
  /** Backend. */
  readonly backend: string
  /** Cache reset — call after device-loss / backend-swap. */
  invalidate(): void
}

// ─── createCaps — factory ────────────────────────────────────────────────────
//
// Takes a query (the probing result) and a statsProvider (a renderer callback).
// statsProvider may be null at createCaps time (the renderer has not yet started the
// frame loop) — stats() returns zero-state, then statsProvider is attached.

const ZERO_STATS: RendererStats = {
  cpuMs: 0,
  gpuMs: null,
  memoryEstimate: 0,
  drawCalls: 0,
  frameCount: 0,
  hitRate: 1.0,
}

export function createCaps(query: CapsQuery, statsProvider: StatsProvider | null = null): Caps {
  // Snapshot of the query at creation time. invalidate() — rebuilds the snapshot
  // (e.g., after device-loss the user re-probes and recreates caps).
  const snapshot = query
  let statsRef = statsProvider

  function formatKey(f: string, axis: FormatAxis): string {
    return `${f}|${axis}`
  }

  return {
    has(f) {
      return snapshot.features.has(f)
    },
    format(f, axis) {
      return snapshot.formatMatrix.get(formatKey(f, axis)) ?? 'none'
    },
    path(name) {
      return snapshot.paths.get(name) ?? 'unknown'
    },
    ext(name) {
      return snapshot.extensions.get(name) ?? null
    },
    stats() {
      if (!statsRef) return ZERO_STATS
      return statsRef()
    },
    limit(name) {
      const v = snapshot.limits[name]
      return v === undefined ? null : v
    },
    get backend() {
      return snapshot.backend
    },
    invalidate() {
      // Marks the snapshot as requiring a re-probe. The actual reprobe
      // is done by the backend (calls probeGLCaps / probeGPUCaps again and
      // creates a new Caps). invalidate() — a convention: call on
      // device-lost / contextlost.
      // Here we simply reset statsProvider — the user may pass a new one.
      statsRef = null
    },
  }
}

// ─── StatsCollector — CPU-side frame time measurement ──────────────────────
//
// The renderer wraps the frame callback in statsCollector.beginFrame()/endFrame().
// beginFrame returns a timer which endFrame() reads for cpuMs. drawCalls
// and memoryEstimate are updated via separate setters — the recorder posts the drawCall count
// after each recording, realGL posts memoryEstimate after createTexture/createBuffer.
//
// gpuMs: if statsCollector is connected to a GpuTimer (setGpuTimer), endFrame()
// pulls timer.result() of the previous frame (GPU timer is async — the result arrives
// not immediately). This gives gpuMs with a 1-frame lag (a typical pattern in GPU
// profiling: frame N pulls the timer, frame N+1 reads the result). Without a GpuTimer
// gpuMs = null (honest, not a fake 0).

export interface StatsCollector {
  beginFrame(): void
  endFrame(): void
  addDrawCall(): void
  addMemory(bytes: number): void
  subMemory(bytes: number): void
  /** Current snapshot — what caps.stats() returns. */
  snapshot(): RendererStats
  /** Reset per-frame counters (called by beginFrame). */
  resetForFrame(): void
  /** Attach a GPU-timer (if available). null — no extension, gpuMs = null. */
  setGpuTimer(timer: GpuTimer | null): void
}

// ─── GpuTimer — GPU-side frame time measurement ──────────────────────────────
//
// GPU timer-query works asynchronously: begin()/end() write markers into the
// GPU command stream, result() reads the result once the GPU gets there.
// Because of this the typical pattern — frame N calls begin/end, frame N+1
// pulls result() and gets gpuMs.
//
// WebGL2: EXT_disjoint_timer_query_webgl2 — beginQuery(TIME_ELAPSED)/endQuery,
// the result is read via getQueryObject in the next frame. If disjoint=GPU
// reset — we discard it and re-run.
//
// WebGPU: timestamp-query feature — beginEndWriteTimestamp, the result is read
// via resolveQuerySet into a buffer. Implemented in packages/webgpu/src/gpuTimer.ts
// (createGpuGpuTimer) and attached in realGPU.ts when the adapter has the
// 'timestamp-query' feature. On adapters without the feature gpuTimer=null, gpuMs=null.

export interface GpuTimer {
  /** Start the timer in the current frame. beginFrame()/endFrame() call
   *  this between themselves. Idempotent: if already started — no-op. */
  begin(): void
  /** Finish the timer. Closes the query. */
  end(): void
  /** Reads the previous frame's result. null if:
   *   - the timer was not started (first frame)
   *   - GPU disjoint (reset) — we discard
   *   - the extension is unavailable
   *  Returns ms (float). With a 1-frame lag. */
  result(): number | null
}

export function createStatsCollector(now: () => number = () => performance.now()): StatsCollector {
  let frameStart = 0
  let cpuMs = 0
  let drawCalls = 0
  let memoryEstimate = 0
  let frameCount = 0
  let gpuTimer: GpuTimer | null = null
  let gpuMs: number | null = null

  return {
    beginFrame() {
      frameStart = now()
      drawCalls = 0
      cpuMs = 0
      frameCount++
      // GPU timer: begin at frame start (under the frame callback wrapper).
      // result() is NOT read here (it is asynchronous) — but in snapshot(), after
      // endFrame has already closed the previous frame's query.
      if (gpuTimer !== null) {
        // Read the PREVIOUS frame's result (it was closed in a past endFrame).
        const prev = gpuTimer.result()
        gpuMs = prev
        gpuTimer.begin()
      }
    },
    endFrame() {
      cpuMs = now() - frameStart
      if (gpuTimer !== null) {
        gpuTimer.end()
      }
    },
    addDrawCall() {
      drawCalls++
    },
    addMemory(bytes) {
      memoryEstimate += bytes
    },
    subMemory(bytes) {
      memoryEstimate = Math.max(0, memoryEstimate - bytes)
    },
    snapshot() {
      return {
        cpuMs,
        gpuMs: gpuTimer === null ? null : gpuMs,
        memoryEstimate,
        drawCalls,
        frameCount,
        hitRate: 1.0,
      }
    },
    resetForFrame() {
      drawCalls = 0
    },
    setGpuTimer(timer) {
      gpuTimer = timer
      gpuMs = timer === null ? null : gpuMs
    },
  }
}
