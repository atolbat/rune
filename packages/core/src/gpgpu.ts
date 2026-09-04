/**
 * gpgpu.ts — THE DUAL-BACKEND COMPUTE TIER CONTROLLER (Task 133).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY IN THE LIBRARY (and why HERE, in @rune/core):
 * The SSBO↔transform-feedback linkage is NOT particles-specific. Any
 * GPU-resident simulation — an FFT ocean's spectrum pass, GPU skinning,
 * a cloth field, a future particle-adjacent effect — needs the SAME
 * machinery the GPGPU particle tier grew in @rune/gl (Task 131/132):
 *
 *   1. ONE ENTRY POINT that dispatches by the backend's shape:
 *        WebGPU  → compute dispatches over a storage buffer (the SSBO tier);
 *        WebGL2  → transform-feedback passes over a float texture (the TF
 *                  tier — the SSBO's twin, @rune/webgl2's createTransformPass
 *                  family is the GLSL twin of @rune/webgpu's createCompute
 *                  family: one packed uniform array, buffer/texture inputs,
 *                  one output buffer).
 *      The CONSUMER CODE is identical for both backends — which tier runs
 *      is the library's business, not the demo's. That was the "common
 *      point" of Task 132's createGpuParticles; it is abstracted here so
 *      the next GPGPU consumer does not re-invent it.
 *
 *   2. RESOURCE CONTROL — every buffer / texture / kernel / pass the tier
 *      creates is TRACKED, and dispose() tears them all down in REVERSE
 *      creation order (dependency-safe), exactly once (idempotent). The
 *      hand-rolled delete lists of the particle orchestrators (and their
 *      leak — the WebGPU compute families were never deleted, the staging
 *      uniform buffer included) are the bug this replaces.
 *
 *   3. THE UNIFORM SCRATCH — one ArrayBuffer with f32 + u32 views: GPU
 *      sim uniforms mix floats (dt, strengths) with u32s (counts, masks)
 *      over one staging block, on both backends.
 *
 * THE CONTRACTS are STRUCTURAL: SsboComputeFacade mirrors the five methods
 * a WebGPU GPUFacade already exposes; TfComputeFacade mirrors the TF family
 * a WebGL2 GLFacade already exposes. No backend package is imported —
 * core stays DOM-free and backend-free; the real facades satisfy the
 * shapes without knowing about them (the stockham.ts precedent: the plan
 * is pure data, the backends execute it).
 *
 * WHAT THIS IS NOT: not a shader factory, not a scheduler. The tier owns
 * LIFECYCLE and DISPATCH only; the passes' content (WGSL/GLSL, layouts,
 * the per-frame sequence) stays with the consumer — see @rune/gl's
 * particlesGpu.ts / particlesGpuGl.ts for the reference consumer.
 * ══════════════════════════════════════════════════════════════════════════
 */

// ─── The WebGPU compute facade shape (the SSBO path) ──────────────────────

/** The WebGPU facade's GPGPU surface (structural — a subset of
 *  @rune/webgpu's GPUFacade; the recording facade and the journal/session
 *  wrappers satisfy it too). */
export interface SsboComputeFacade {
  /** A queue-owned buffer (usage = GPU_BUFFER_USAGE bits, OR'd). */
  createExternalBuffer(byteLength: number, usage: number): number
  /** queue.writeBuffer into an external buffer (a sub-range). */
  writeExternalBuffer(
    bufferId: number,
    data: Float32Array | Uint32Array,
    byteOffset?: number,
    byteLength?: number,
  ): void
  /** A compute family: one WGSL module, one uniform staging buffer sized
   *  `uniformBytes` (rounded to 16), the five-slot bind layout
   *  (0 uniform / 1 rw / 2 ro / 3 rw / 4 ro storage) over `bufferIds`. */
  createCompute(wgsl: string, uniformBytes: number, bufferIds: readonly number[]): number
  /** Runs one entry point of the family (compute passes enqueue before the
   *  frame's render pass — the tape contract). */
  runCompute(computeId: number, entry: string, uniformData: Float32Array, workgroups: number): void
  /** Deletes a compute family (the staging uniform buffer destroyed, the
   *  registry entry dropped). Idempotent. */
  deleteCompute(computeId: number): void
  /** Deletes an external buffer. Idempotent. */
  deleteExternalBuffer(bufferId: number): void
}

// ─── The WebGL2 transform-feedback facade shape (the TF path) ─────────────

/** One transform-feedback pass declaration (the GLSL twin of a compute
 *  entry): a vertex-only program streaming its `outputs` (interleaved) into
 *  ONE buffer; attribute/texture/uniform inputs bound at run time. */
export interface TfPassDesc {
  readonly vertex: string
  readonly outputs: readonly string[]
  readonly attributes?: readonly {
    readonly name: string
    readonly size: number
    readonly stride?: number
    readonly offset?: number
    readonly divisor?: number
  }[]
  readonly textures?: readonly string[]
  readonly uniforms?: readonly { readonly name: string; readonly size: 1 | 2 | 3 | 4 }[]
}

/** The per-run bindings of a TF pass: the output buffer, the per-declaration
 *  attribute/texture ids (undefined entries are skipped) and the packed
 *  uniform array. */
export interface TfRunBindings {
  readonly bufferId: number
  readonly attribBuffers?: readonly (number | undefined)[]
  readonly textures?: readonly (number | undefined)[]
  readonly uniformData?: Float32Array
}

/** The WebGL2 facade's GPGPU surface (structural — a subset of
 *  @rune/webgl2's GLFacade). The float-TEXTURE state store is the TF tier's
 *  own business (WebGL2 forbids a TF output buffer overlapping a live
 *  vertex binding — the texture is the authoritative state, moved through
 *  a PBO round-trip). */
export interface TfComputeFacade {
  createBuffer(data: Float32Array): number
  updateBuffer(bufferId: number, data: Float32Array, byteOffset?: number): void
  createTexture(
    width: number,
    height: number,
    options?: { mipLevels?: number; maxAnisotropy?: number; format?: string },
  ): number
  texSubImage2D(
    textureId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    bytes: Uint8Array | Float32Array,
  ): void
  /** texSubImage2D with the source in a GL buffer (PIXEL_UNPACK_BUFFER) —
   *  the GPU→GPU state round-trip, zero CPU traffic. */
  texSubImage2DBuffer(
    textureId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    bufferId: number,
    byteOffset?: number,
  ): void
  createTransformPass(desc: TfPassDesc): number
  runTransformPass(passId: number, vertexCount: number, output: TfRunBindings): void
  deleteTransformPass(passId: number): void
  deleteBuffer(bufferId: number): void
  deleteTexture(textureId: number): void
}

// ─── The GPUBufferUsage bits (the spec's stable values) ───────────────────

/** GPUBufferUsage bits (the WebGPU spec's stable numbers — the controller
 *  composes them for external buffers; WebGL2 consumers ignore them). */
export const GPU_BUFFER_USAGE = {
  /** 1 — map for reading. */
  MAP_READ: 1,
  /** 2 — map for writing. */
  MAP_WRITE: 2,
  /** 4 — copy source. */
  COPY_SRC: 4,
  /** 8 — queue.writeBuffer target. */
  COPY_DST: 8,
  /** 16 — bind as an index buffer. */
  INDEX: 16,
  /** 32 — bind as a vertex buffer (the instance records of a GPGPU tier). */
  VERTEX: 32,
  /** 64 — bind as a uniform buffer. */
  UNIFORM: 64,
  /** 128 — bind as a storage buffer (read or read_write). */
  STORAGE: 128,
  /** 256 — use as an indirect argument buffer. */
  INDIRECT: 256,
} as const

// ─── The uniform scratch (f32 + u32 over one ArrayBuffer) ─────────────────

/** A uniform staging block: GPU sim uniforms mix f32s (dt, strengths,
 *  points) with u32s (counts, masks) over ONE buffer — both backends
 *  consume it as a Float32Array, the u32 view writes the integer fields
 *  at aliased offsets. */
export interface GpuUniformScratch {
  readonly bytes: ArrayBuffer
  readonly f32: Float32Array
  readonly u32: Uint32Array
}

/** Allocates a `floats`-wide uniform scratch (zeroed). */
export function createGpuScratch(floats: number): GpuUniformScratch {
  if (!Number.isInteger(floats) || floats <= 0) {
    throw new Error(`rune/core: createGpuScratch — floats must be a positive integer (got ${floats})`)
  }
  const bytes = new ArrayBuffer(floats * 4)
  return { bytes, f32: new Float32Array(bytes), u32: new Uint32Array(bytes) }
}

// ─── The tracked resource set (the lifecycle control) ─────────────────────

/** The internal registry: creation-order disposers, disposed in REVERSE
 * (dependencies die before their inputs), exactly once. */
interface ResourceSet {
  add(disposer: () => void): void
  dispose(): void
}

function createResourceSet(): ResourceSet {
  const disposers: Array<() => void> = []
  let disposed = false
  return {
    add(disposer) { if (!disposed) disposers.push(disposer) },
    dispose() {
      if (disposed) return
      disposed = true
      for (let i = disposers.length - 1; i >= 0; i--) disposers[i]()
      disposers.length = 0
    },
  }
}

// ─── The WebGPU SSBO tier ──────────────────────────────────────────────────

/** The WebGPU compute tier: a tracked wrapper over an SsboComputeFacade. */
export interface SsboComputeTier {
  readonly kind: 'ssbo'
  /** The wrapped facade (raw passthrough for the surface this tier does
   *  not own — readback probes, journal wrapping). */
  readonly backend: SsboComputeFacade
  /** An external buffer, tracked for dispose() (usage = GPU_BUFFER_USAGE
   *  bits, OR'd — STORAGE | COPY_DST for a state store, STORAGE | VERTEX
   *  for the draw-facing records). */
  createBuffer(byteLength: number, usage: number): number
  writeBuffer(
    bufferId: number,
    data: Float32Array | Uint32Array,
    byteOffset?: number,
    byteLength?: number,
  ): void
  /** A compute family (the WGSL + the five-slot bind layout), tracked for
   *  dispose() — the staging uniform buffer dies with it. */
  createKernel(wgsl: string, uniformBytes: number, bufferIds: readonly number[]): number
  runKernel(computeId: number, entry: string, uniformData: Float32Array, workgroups: number): void
  /** The uniform scratch (see createGpuScratch). */
  scratch(floats: number): GpuUniformScratch
  /** Deletes every tracked buffer and kernel, REVERSE creation order,
   *  once. The backend facade itself stays alive. */
  dispose(): void
}

/** Wraps a WebGPU-shaped facade into the tracked SSBO tier. */
export function createSsboTier(backend: SsboComputeFacade): SsboComputeTier {
  const resources = createResourceSet()
  return {
    kind: 'ssbo',
    backend,
    createBuffer(byteLength, usage) {
      const id = backend.createExternalBuffer(byteLength, usage)
      resources.add(() => backend.deleteExternalBuffer(id))
      return id
    },
    writeBuffer(bufferId, data, byteOffset, byteLength) {
      backend.writeExternalBuffer(bufferId, data, byteOffset, byteLength)
    },
    createKernel(wgsl, uniformBytes, bufferIds) {
      const id = backend.createCompute(wgsl, uniformBytes, bufferIds)
      resources.add(() => backend.deleteCompute(id))
      return id
    },
    runKernel(computeId, entry, uniformData, workgroups) {
      backend.runCompute(computeId, entry, uniformData, workgroups)
    },
    scratch: createGpuScratch,
    dispose() { resources.dispose() },
  }
}

// ─── The WebGL2 transform-feedback tier ────────────────────────────────────

/** The WebGL2 TF tier: a tracked wrapper over a TfComputeFacade. */
export interface TfComputeTier {
  readonly kind: 'transform-feedback'
  /** The wrapped facade (raw passthrough for the surface this tier does
   *  not own — draw commands, targets, journal wrapping). */
  readonly backend: TfComputeFacade
  /** A data buffer, tracked for dispose(). */
  createBuffer(init: Float32Array): number
  updateBuffer(bufferId: number, data: Float32Array, byteOffset?: number): void
  /** A float texture (the TF tier's state store — 'rgba32f' for the
   *  simulation state), tracked for dispose(). */
  createTexture(
    width: number,
    height: number,
    options?: { mipLevels?: number; maxAnisotropy?: number; format?: string },
  ): number
  texSubImage2D(
    textureId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    bytes: Uint8Array | Float32Array,
  ): void
  texSubImage2DBuffer(
    textureId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    bufferId: number,
    byteOffset?: number,
  ): void
  /** A transform-feedback pass (the GLSL twin of a compute entry), tracked
   *  for dispose(). */
  createPass(desc: TfPassDesc): number
  runPass(passId: number, vertexCount: number, bindings: TfRunBindings): void
  /** The uniform scratch (see createGpuScratch). */
  scratch(floats: number): GpuUniformScratch
  /** Deletes every tracked buffer, texture and pass, REVERSE creation
   *  order, once. The backend facade itself stays alive. */
  dispose(): void
}

/** Wraps a WebGL2-shaped facade into the tracked TF tier. */
export function createTfTier(backend: TfComputeFacade): TfComputeTier {
  const resources = createResourceSet()
  return {
    kind: 'transform-feedback',
    backend,
    createBuffer(init) {
      const id = backend.createBuffer(init)
      resources.add(() => backend.deleteBuffer(id))
      return id
    },
    updateBuffer(bufferId, data, byteOffset) {
      backend.updateBuffer(bufferId, data, byteOffset)
    },
    createTexture(width, height, options) {
      const id = backend.createTexture(width, height, options)
      resources.add(() => backend.deleteTexture(id))
      return id
    },
    texSubImage2D(textureId, x, y, width, height, bytes) {
      backend.texSubImage2D(textureId, x, y, width, height, bytes)
    },
    texSubImage2DBuffer(textureId, x, y, width, height, bufferId, byteOffset) {
      backend.texSubImage2DBuffer(textureId, x, y, width, height, bufferId, byteOffset)
    },
    createPass(desc) {
      const id = backend.createTransformPass(desc)
      resources.add(() => backend.deleteTransformPass(id))
      return id
    },
    runPass(passId, vertexCount, bindings) {
      backend.runTransformPass(passId, vertexCount, bindings)
    },
    scratch: createGpuScratch,
    dispose() { resources.dispose() },
  }
}

// ─── THE COMMON ENTRY POINT (the dispatch) ────────────────────────────────

/** Either GPGPU tier (narrow with `tier.kind`). */
export type GpgpuTier = SsboComputeTier | TfComputeTier

/** THE COMMON ENTRY POINT: wraps a backend facade into the GPGPU tier it
 *  speaks — dispatched by shape, not by type tag:
 *   createCompute      → the WebGPU SSBO compute tier;
 *   createTransformPass → the WebGL2 transform-feedback tier.
 * The consumer's frame code is identical on both — which tier runs is the
 *  library's business. Throws for a backend that speaks neither (a strict
 *  misconfiguration, not a silent CPU fallback). */
export function createGpgpu(backend: object): GpgpuTier {
  if (typeof (backend as SsboComputeFacade).createCompute === 'function') {
    return createSsboTier(backend as SsboComputeFacade)
  }
  if (typeof (backend as TfComputeFacade).createTransformPass === 'function') {
    return createTfTier(backend as TfComputeFacade)
  }
  throw new Error(
    'rune/core: createGpgpu needs a WebGPU compute facade (createCompute) or a WebGL2 transform-feedback facade (createTransformPass)',
  )
}
