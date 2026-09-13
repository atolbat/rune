// @rune/gl — device.ts, Task 198: THE COMMON BRICKS — one device facade,
// two backends, ONE demo syntax.
//
// The Task-197 answer to «can the new facades be pushed into WebGL?» was
// capability-level common ground: the same Hi-Z on both backends, two tier
// files with two API dialects (gpu.* vs gl.*). This module is the user's
// next ask made real: ОБЩИЕ КИРПИЧИКИ — the demo code path is written ONCE
// against createDevice(), and both backends execute the identical calls:
//
//   device.scene(layout)            — the instance stream (records + flags)
//   device.pyramid(w, h)            — the Hi-Z tile + the reduced levels
//   device.program(spec)            — { wg: {…}, gl: {…} } — per-language
//                                      SOURCES as data, one driver
//   device.drawInstanced(…)         — the classic occluder draw (z prepass)
//   device.occlusionCuller(…)       — THE KERNEL BRICK: WG compute / GL TF
//   device.drawVisible(…)           — THE GPU-DRAW BRICK: WG compact +
//                                      drawIndexedIndirect / GL instanced +
//                                      vertex-collapse
//   device.drawQuad(…)              — the fullscreen debug panels
//   device.readCullStats(scene)     — the SAME stats shape both backends
//   device.surface(w, h, …)         — the readback channel (parity gates)
//
// THE HONEST SPLIT (documented, not hidden): the SHADER SOURCES stay
// per-language — WGSL and GLSL ES 3.00 are different languages, and a
// translator would be a compiler, not a brick. What the demo sees is one
// SYNTAX: the frame function, the boot, the stats, the gates — all written
// once; the per-backend mechanics (compute vs transform feedback, indirect
// vs collapse, the Y-orientation and depth-range conventions) live INSIDE
// the bricks. The per-backend shader dictionaries are DATA the demo hands
// to device.program()/device.occlusionCuller().
//
// The bricks' mechanism map (the Task-197 table, now enforced by code):
//
//   brick                WebGPU                        WebGL2
//   ─────────────────    ──────────────────────────    ──────────────────────────────
//   pyramid              FBO 2×2 MAX reduce quads     the SAME FBO reduce quads
//                        (r32float targets, the        (r32f targets — Task 197's
//                        Task-196 format axis)         EXT_color_buffer_float)
//   occlusionCuller      a compute family over the     ONE transform-feedback pass
//                        scene storage + texture       (gl_VertexID = the record,
//                        slots (Task 196) — writes     the Task-132/140 contract) —
//                        the flag region in the scene  streams the flags to a buffer
//   drawVisible          ONE single-thread compact     ONE instanced draw over ALL
//                        kernel (list + indirect args) records; the vertex shader
//                        + ONE drawIndexedIndirect —   collapses flag ∉ {1,4} to a
//                        the whole visible set, GPU-   degenerate position (the
//                        driven, zero CPU readbacks    Task-193 bit-discard pattern)
//   readCullStats        args-buffer readback (async)  flag-buffer readback + a CPU
//                                                      sweep (sync, throttled)
//   uniforms             the UBO arena (packed block)  named setters (the lane map)
//
// The bricks are shipped from @rune/gl (the meta-package that already owns
// both renderer constructors) — no import cycles, and dist/rune.esm.js
// carries them through the existing entry.

import { createWebGpuRenderer } from './webgpuRenderer.ts'
import { createWebGL2Renderer } from './webgl2Renderer.ts'
import type { WebGpuRenderer } from './webgpuRenderer.ts'
import type { WebGL2Renderer } from './webgl2Renderer.ts'
import type { GPUFacade, GpuAttrSlot } from '@rune/webgpu'
import type { GLFacade } from '@rune/webgl2'
import type { AnyCanvas } from './canvasHelpers.ts'

// ─── the public types ─────────────────────────────────────────────────────

export type DeviceBackend = 'webgpu' | 'webgl2'

export interface DeviceClear {
  readonly color: readonly number[]
  readonly depth?: number
}

export interface DeviceOptions {
  readonly backend: DeviceBackend
  readonly canvas: AnyCanvas
  readonly clear?: DeviceClear
  /** Task 198 — WG: the 4x-resolve canvas (the facade's antialias growth);
   *  GL: the context cascade's antialias rung (the driver's choice). */
  readonly antialias?: boolean
  /** Clamp the live devicePixelRatio (mobile-first: a dpr-3 phone renders
   *  at dpr ≤ cap — supersampling where it pays, no 3x fill cost). */
  readonly dprCap?: number
  readonly onError?: (message: string) => void
  readonly onInfo?: (message: string) => void
  /** default true — the renderers' own ResizeObservers re-derive the
   *  backing store from the canvas CSS size + the live DPR. */
  readonly observeResize?: boolean
  /** Renderer-constructor injection for headless tests. */
  readonly createWgRenderer?: typeof createWebGpuRenderer
  readonly createGlRenderer?: typeof createWebGL2Renderer
}

/** The instance stream: [list | flags | records] words — the shared scene
 *  storage of the occlusion demos. The RECORD LAYOUT is DECLARED, not
 *  assumed: `stride` (words per record) + `fields` (the word offsets of the
 *  cull kernel's a_c/a_h feed) default to the historical 12/0/3 shape, and
 *  the GL attribute feeds + the TF kernel attributes are DERIVED from the
 *  declaration — a different scenario declares a different shape and rides
 *  the same bricks. The WG backend keeps ONE storage buffer over the words;
 *  the GL backend splits it into the float records buffer (attributes) + its
 *  own flag buffer. Task 199: `occluders` is the BOOT default of the runtime
 *  POLICY (the per-frame prepass count — see hizFrame's `occluders`). */
export interface SceneLayout {
  readonly total: number
  readonly occluders: number
  readonly words: Uint32Array
  readonly recordsF32: Float32Array
  readonly flagsWord: number
  readonly recordsWord: number
  /** words per record (default 12: center 3, half 3, color 3, spare 3). */
  readonly stride?: number
  /** word offsets of the AABB feed inside a record (defaults: 0 and 3). */
  readonly fields?: { readonly center?: number; readonly half?: number }
}

export interface SceneHandle {
  readonly total: number
  readonly occluders: number
  /** The resolved record layout (the GL feeds + the diagnostics read it). */
  readonly stride: number
  readonly fields: { readonly center: number; readonly half: number }
}

/** One named uniform slice of the packed block. mat4 = 16 words, vec4 = 4.
 *  The DEMO packs ONE Float32Array per draw; the WG side uploads it raw
 *  (the WGSL struct must match the lane order), the GL side splits it into
 *  the named setters. u32-bit lanes ride the same bytes via a Uint32Array
 *  view — the WGSL must then declare vec4<u32> (the bits land verbatim). */
export interface UniformLane {
  readonly name: string
  readonly kind: 'mat4' | 'vec4'
  readonly words: 16 | 4
}

/** A GL attribute declaration — the per-instance record feed. `from` names
 *  the buffer the DEVICE binds: 'geometry' (corner/quad), 'records' (the
 *  scene's float records), 'flags' (the culler's verdict buffer). */
export interface GlAttrDecl {
  readonly location: number
  readonly from: 'geometry' | 'records' | 'flags'
  readonly size: number
  readonly stride: number
  readonly offset: number
  readonly divisor: number
}

export interface ProgramSpec {
  readonly depth?: { test?: string; write?: boolean }
  /** Task 199 — back-face culling: 'none' (default) | 'back' | 'front'.
   *  WG: the pipeline's cullMode — with frontFace 'cw', the y-flip mirror
   *  of GL's default CCW (NDC y-up vs framebuffer y-down invert the
   *  apparent winding; without the mirror the two backends would cull
   *  OPPOSITE faces of the same mesh). GL: glEnable(CULL_FACE) + the
   *  default CCW front. The occlusion z/color passes run cull:'back' —
   *  the coplanar bottom-vs-ground z-fight dies at the source. */
  readonly cull?: 'none' | 'back' | 'front'
  /** The WebGPU leg: the full WGSL + the vertex-slot layout (the facade's
   *  GpuAttrSlot contract) + whether the shader samples a texture (group 1). */
  readonly wg?: {
    code: string
    attrs: readonly (number | GpuAttrSlot)[]
    hasTextures?: boolean
  }
  /** The WebGL2 leg: the vs/fs pair + the attribute feed + the uniform
   *  lane map (the packed block is split over the named setters). */
  readonly gl?: {
    vs: string
    fs: string
    attrs: readonly GlAttrDecl[]
    lanes: readonly UniformLane[]
  }
}

export interface ProgramHandle {
  readonly backend: DeviceBackend
  readonly depth: { test: string; write: boolean }
}

/** The internal WG program record (keyed by the public handle). */
interface WgProgramEntry {
  readonly pipelineId: number
  readonly depth: { test: string; write: boolean }
}

export interface GeometryHandle {
  readonly vertices: Float32Array
  readonly indices?: Uint16Array | Uint32Array
}

export interface PyramidHandle {
  /** The z-prepass target (level 0 + the depth attachment). */
  readonly zTarget: number
  /** Per-level texture ids (GL: the r32f FBO levels; WG: empty — the
   *  pyramid lives in the storage buffer below). */
  readonly textures: readonly number[]
  /** WG only: the max-pyramid as ONE storage buffer (the Task-196 shape);
   *  GL leaves it undefined — its kernels read the textures. */
  readonly storageId?: number
  /** WG only: the flat word offset of every level (the consumers' baked
   *  addressing). */
  readonly offsets?: readonly number[]
  readonly levels: number
  readonly width: number
  readonly height: number
  readonly dims: readonly { w: number; h: number }[]
  /** The reduce chain — call after the z prepass, before the culler. */
  build(): void
}

export interface CullerSpec {
  /** WGSL: the compute kernel — storage bindings per the scene contract
   *  (binding 1 = the scene words, read_write) + the pyramid's texture
   *  slots (bindings 6..); GLSL: the TF vertex kernel — v_flag output,
   *  a_c/a_h record attributes, the u_pyr[] sampler array. */
  readonly wgsl: string
  readonly glsl: string
  readonly entry?: string
  /** The GL transform pass's packed-uniform declaration — every lane a
   *  vec4 (u_mvp[0..3], u_misc…); the WG side uploads the SAME block raw
   *  (the WGSL struct must match the lane order; u32-bit lanes ride the
   *  bytes through a Uint32Array view — the WGSL declares vec4<u32>). */
  readonly lanes: readonly { name: string }[]
  readonly uniformBytes: number
}

export interface CullerHandle {
  /** Fire the per-record verdict pass. The block layout = the spec's lanes. */
  run(block: Float32Array): void
}

export interface DrawOptions {
  readonly target: number
  readonly clear: boolean
  readonly program: ProgramHandle
  readonly geometry: GeometryHandle
  readonly records: SceneHandle
  readonly uniforms: Float32Array
  readonly indexCount?: number
}

/** Task 199 — THE FRAME RECIPE as a brick: the Hi-Z pipeline sequence
 *  (z prepass → pyramid → cull → visible draw) owns ONE canonical order;
 *  scenarios were hand-rolling it in demo code. The spec wires the
 *  scenario's own handles (programs, culler, geometry); every call
 *  carries the per-frame policy + the scenario's packed uniform blocks
 *  (opaque data — the brick never inspects the lanes).
 *  `occluders` is THE POLICY KNOB: how many records render into the z
 *  prepass this frame — the boot default (the big static occluders), the
 *  whole scene (every instance writes depth — the «does the city occlude
 *  itself» experiment), or anything between. The cull block's hizOn word
 *  is the SCENARIO's own lane (the demo's cullBlock[16]) — patch it
 *  before the call; the brick is policy-agnostic. */
export interface HizFrameSpec {
  readonly scene: SceneHandle
  readonly pyramid: PyramidHandle
  readonly culler: CullerHandle
  readonly zPass: ProgramHandle
  readonly colorPass: ProgramHandle
  readonly geometry: GeometryHandle
}

export interface HizFrameCall {
  readonly target: number
  /** The prepass instance count — the occlusion POLICY for this frame. */
  readonly occluders: number
  readonly zUniforms: Float32Array
  readonly cullUniforms: Float32Array
  readonly colorUniforms: Float32Array
  readonly indexCount?: number
  /** clear the color target (default true). */
  readonly clear?: boolean
}

export interface HizFrameHandle {
  run(call: HizFrameCall): void
}

export interface CullStats {
  readonly drawn: number
  readonly frustum: number
  readonly occluded: number
  readonly straddle: number
}

export interface DeviceSurface {
  readonly targetId: number
  readonly width: number
  readonly height: number
  read(): Promise<{ width: number; height: number; data: Uint8Array }>
}

export interface RenderDevice {
  readonly backend: DeviceBackend
  readonly canvas: AnyCanvas
  readonly renderer: WebGpuRenderer | WebGL2Renderer
  readonly adapterInfo: string
  readonly software: boolean
  readonly antialias: boolean
  /** The WG facade / GL facade — the diagnostics channel (readbacks). */
  readonly gpu: GPUFacade | null
  readonly gl: GLFacade | null
  /** The scene buffer's raw words (WG only — the diagnostics channel;
   *  GL leaves it absent: its flags live in the culler's own buffer). */
  debugSceneWords?(scene: SceneHandle, bytes: number): Promise<Float32Array>
  scene(layout: SceneLayout): SceneHandle
  pyramid(w: number, h: number): PyramidHandle
  program(spec: ProgramSpec): ProgramHandle
  geometry(vertices: Float32Array, indices?: Uint16Array | Uint32Array): GeometryHandle
  drawInstanced(options: DrawOptions & { instances: number }): void
  drawVisible(options: DrawOptions): void
  drawQuad(options: {
    target: number
    clear: boolean
    program: ProgramHandle
    pyramid: PyramidHandle
    level: number
    uniforms: Float32Array
  }): void
  occlusionCuller(scene: SceneHandle, pyramid: PyramidHandle, spec: CullerSpec): CullerHandle
  /** Task 199 — the whole Hi-Z frame in ONE call (the recipe as a brick). */
  hizFrame(spec: HizFrameSpec): HizFrameHandle
  readCullStats(scene: SceneHandle): Promise<CullStats>
  surface(width: number, height: number, options?: { depth?: boolean }): DeviceSurface
  submit(): void
  dispose(): void
}

// ─── the library-internal shaders (generic — no scene constants baked) ────

/** The GL twin of the reduce — FBO fullscreen quads over the r32f levels
 *  (the Task-197 shape; WG rides the compute family above). */
const REDUCE_GLSL_VS = `#version 300 es
layout(location=0) in vec2 a_q;
void main() { gl_Position = vec4(a_q, 0.0, 1.0); }`
const REDUCE_GLSL_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  ivec2 d = textureSize(u_src, 0);
  int x0 = min(p.x, d.x - 1);
  int x1 = min(p.x + 1, d.x - 1);
  int y0 = min(p.y, d.y - 1);
  int y1 = min(p.y + 1, d.y - 1);
  float a = texelFetch(u_src, ivec2(x0, y0), 0).r;
  float b = texelFetch(u_src, ivec2(x1, y0), 0).r;
  float c = texelFetch(u_src, ivec2(x0, y1), 0).r;
  float dd = texelFetch(u_src, ivec2(x1, y1), 0).r;
  o = vec4(max(max(a, b), max(c, dd)), 0.0, 0.0, 1.0);
}`

/** THE COMPACT (WG-only — the drawVisible brick's first half): the flags →
 *  the stable ascending visible list + the drawIndexedIndirect args + the
 *  stats block. Single thread, no atomics — the STABLE draw order the
 *  pixel-parity gates demand (an atomic-order flip at an equal-depth
 *  collision would fake a divergence).
 * Task 199 — EVERY RECORD IS TESTED: the pre-196-199 kernel short-circuited
 *  the first k records to visible (the pyramid builders never tested
 *  themselves); the occluder boundary is now a POLICY, not a kernel
 *  constant, and testing the builders is SOUND — the max-reduced pyramid
 *  makes any contributor's own footprint max ≥ its own front surface ≥ its
 *  nearest AABB corner, so a contributor never self-culls, and one occluder
 *  fully behind another is honestly culled (the same pixels, fewer draws).
 * THE SLOT MAP: the compute family's fixed storage types alternate
 * rw/ro/rw — the scene (rw, the list writes) rides binding 1, a 16-byte
 * UNUSED read-only placeholder sits at binding 2 (a layout may declare
 * more than the entry reads; the placeholder keeps the args at binding 3,
 * the next rw slot), the args (rw) at binding 3. */
const COMPACT_WGSL = `
struct CompactParams { words: vec4<u32> }
@group(0) @binding(0) var<uniform> params: CompactParams;
@group(0) @binding(1) var<storage, read_write> scene: array<u32>;
@group(0) @binding(3) var<storage, read_write> args: array<u32>;
@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x != 0u) { return; }
  let n = params.words.x;      // the record count
  let indexCount = params.words.y;
  let flagsOff = params.words.z;
  // words.w — the boot-time occluder count, carried for diagnostics only
  var out = 0u; var frustum = 0u; var occluded = 0u; var straddle = 0u;
  for (var i = 0u; i < n; i = i + 1u) {
    let f = scene[flagsOff + i];
    let visible = f == 1u || f == 4u;
    if (visible) {
      scene[out] = i;          // the list region (word 0) — ascending, stable
      out = out + 1u;
      if (f == 4u) { straddle = straddle + 1u; }
    } else if (f == 2u) {
      frustum = frustum + 1u;
    } else if (f == 3u) {
      occluded = occluded + 1u;
    }
  }
  // the stats block: drawn = ALL visible records — the accounting invariant
  // frustum + occluded + drawn === n (the GL CPU-sweep twin counts from 0)
  args[0u] = out;
  args[1u] = frustum;
  args[2u] = occluded;
  args[3u] = straddle;
  // drawIndexedIndirect at byte 32: [indexCount, instanceCount, firstIndex,
  // baseVertex, firstInstance] — words 8..12
  args[8u] = indexCount;
  args[9u] = out;
}`

// ─── the internal scene bookkeeping (per backend) ─────────────────────────

interface WgScene {
  handle: SceneHandle
  bufferId: number
  argsId: number
  compactId: number
  compactBlock: Float32Array
  compactU32: Uint32Array
}

interface GlScene {
  handle: SceneHandle
  recBuf: number
  flagBuf: number
  flagScratch: Float32Array
}

/** The GL program record (keyed by the public handle). */
interface GlProgram {
  programId: number
  depth: { test: string; write: boolean }
  cull: 'none' | 'back' | 'front'
  lanes: readonly UniformLane[]
  attrs: readonly GlAttrDecl[]
}

// the quad banks: WG draws a 6-vertex triangle list, GL a 4-vertex strip —
// the device owns both; drawQuad normalizes them away.
const QUAD_LIST = new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1])
const QUAD_STRIP = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])

const WG_USAGE = { STORAGE: 0x80, INDIRECT: 0x100, COPY_SRC: 0x4, COPY_DST: 0x8 }

// ─── the device boot ──────────────────────────────────────────────────────

/** Task 198 — createDevice: ONE boot syntax for both backends. The renderers
 *  own the canvas lifecycle (DPR-aware backing store, ResizeObservers); the
 *  bricks own the pipeline mechanics. Throws the honest refusal when the
 *  backend is missing (the caller degrades — the demo falls back). */
export async function createDevice(options: DeviceOptions): Promise<RenderDevice> {
  const onError = options.onError
  const color = options.clear?.color ?? [0.07, 0.08, 0.11, 1]
  const clear = {
    color: [color[0] ?? 0.07, color[1] ?? 0.08, color[2] ?? 0.11, color[3] ?? 1] as [number, number, number, number],
    depth: options.clear?.depth ?? 1,
  }
  // mobile-first DPR: clamp the LIVE devicePixelRatio once at boot — below
  // the cap the override stays undefined so mid-session zoom moves re-derive
  // the store; above it the clamp pins the fill cost.
  const liveDpr = typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1
  const dprOverride = options.dprCap !== undefined && liveDpr > options.dprCap ? options.dprCap : undefined
  const observeResize = options.observeResize !== false

  if (options.backend === 'webgpu') {
    const createWg = options.createWgRenderer ?? createWebGpuRenderer
    // the GPU-process storm channel: 4 attempts, the Task-197 cadence
    let renderer: WebGpuRenderer | null = null
    let lastError: unknown = null
    for (let attempt = 0; attempt < 4 && renderer === null; attempt++) {
      try {
        renderer = await createWg({
          canvas: options.canvas,
          dpr: dprOverride,
          clear: { color: clear.color, depth: clear.depth },
          onGpuError: onError,
          antialias: options.antialias === true,
          observeResize,
          multiDraw: false,
        })
      } catch (error) {
        lastError = error
        await new Promise(r => setTimeout(r, 900))
      }
    }
    if (renderer === null) throw lastError instanceof Error ? lastError : new Error('rune: the WebGPU renderer refused to boot')
    return createWgDevice(renderer, options, clear)
  }

  const createGl = options.createGlRenderer ?? createWebGL2Renderer
  const renderer = createGl({
    canvas: options.canvas,
    dpr: dprOverride,
    clear: { color: clear.color, depth: clear.depth },
    onGlError: onError,
    observeResize,
    multiDraw: false,
  })
  return createGlDevice(renderer, options, clear)
}

// ─── the WebGPU leg ───────────────────────────────────────────────────────

function adapterInfoOf(renderer: WebGpuRenderer): string {
  try {
    const info = renderer.gpu?.adapter?.info
    if (info === undefined || info === null) return ''
    return `${info.description ?? ''} ${info.architecture ?? ''} ${info.vendor ?? ''}`
  } catch {
    return ''
  }
}

function createWgDevice(renderer: WebGpuRenderer, options: DeviceOptions, clear: { color: [number, number, number, number]; depth: number }): RenderDevice {
  const gpu = renderer.gpu
  const onInfo = options.onInfo
  const adapterInfo = adapterInfoOf(renderer)
  const software = /swiftshader|software|llvmpipe|basic render/i.test(adapterInfo)
  // the UBO arena cursor: 256-aligned slots, reset at every submit — the
  // tier's fixed-offset dance (0 / 256 / 512+L·256) becomes a rolling alloc
  let arenaCursor = 0
  let pipelineSeq = 0
  const scenes = new Map<SceneHandle, WgScene>()
  const wgPrograms = new Map<ProgramHandle, WgProgramEntry>()

  function allocUniforms(bytes: Uint8Array): number {
    const offset = arenaCursor
    gpu.uploadUniforms(offset, bytes)
    arenaCursor += Math.max(256, Math.ceil(bytes.byteLength / 256) * 256)
    return offset
  }

  function scene(layout: SceneLayout): SceneHandle {
    const handle: SceneHandle = {
      total: layout.total,
      occluders: layout.occluders,
      stride: layout.stride ?? 12,
      fields: { center: layout.fields?.center ?? 0, half: layout.fields?.half ?? 3 },
    }
    const bufferId = gpu.createExternalBuffer(layout.words.byteLength, WG_USAGE.STORAGE | WG_USAGE.COPY_DST | WG_USAGE.COPY_SRC)
    gpu.writeExternalBuffer(bufferId, layout.words)
    const argsId = gpu.createExternalBuffer(64, WG_USAGE.STORAGE | WG_USAGE.INDIRECT | WG_USAGE.COPY_SRC)
    // the rw/ro/rw placeholder: the compact's scene rides binding 1 (rw),
    // the args binding 3 (the next rw) — binding 2 takes an unused 16-byte
    // read-only placeholder (a layout may declare more than the entry reads)
    const placeholderId = gpu.createExternalBuffer(16, WG_USAGE.STORAGE)
    const compactBlock = new Float32Array(4)
    const compactU32 = new Uint32Array(compactBlock.buffer)
    compactU32[0] = layout.total
    compactU32[1] = 36 // the indexCount — refreshed by every drawVisible
    compactU32[2] = layout.flagsWord
    compactU32[3] = layout.occluders // diagnostics only (the Task-199 policy note)
    const compactId = gpu.createCompute(COMPACT_WGSL, 16, [bufferId, placeholderId, argsId])
    scenes.set(handle, { handle, bufferId, argsId, compactId, compactBlock, compactU32 })
    return handle
  }

  function pyramid(w: number, h: number): PyramidHandle {
    // THE STORAGE PYRAMID (the Task-196 proven shape — the honest WG leg of
    // the brick): level 0 IS the z tile (the r32f target the z-prepass
    // renders into, its depth attachment keeping the NEAREST occluder per
    // pixel); the reduce rides ONE compute family — zToMip0 (the tile read
    // through the family's TEXTURE slot) + reduceL1..reduceLmax with the
    // per-level offsets BAKED as entry points (the family uniform is
    // frame-static by design). The GL twin reduces as FBO quads — the
    // mechanism is the backend's own, the CONTRACT (the max-pyramid + the
    // consumers) is one. (The FBO-quad shape was tried on WG first — the
    // container's SwiftShader silently drops the render that follows a
    // compute pass reading ten render-target textures; the Task-196 shape
    // is the one the production gates have always run.)
    const dims = [{ w, h }]
    let cw = w, ch = h
    for (;;) {
      cw = Math.max(1, Math.ceil(cw / 2))
      ch = Math.max(1, Math.ceil(ch / 2))
      dims.push({ w: cw, h: ch })
      if (cw === 1 && ch === 1) break
    }
    const offsets = [0]
    for (let L = 1; L < dims.length; L++) offsets.push(offsets[L - 1] + dims[L - 1].w * dims[L - 1].h)
    const words = offsets[offsets.length - 1] + dims[dims.length - 1].w * dims[dims.length - 1].h
    const zTexId = gpu.createTexture(w, h, 'r32float')
    const zTarget = gpu.createTarget(zTexId, w, h, true, [1, 1, 1, 1])
    const storageId = gpu.createExternalBuffer(words * 4, WG_USAGE.STORAGE | WG_USAGE.COPY_DST | WG_USAGE.COPY_SRC)
    // the generated reduce family (the baked constants — the Task-196 code)
    let REDUCE = ''
    for (let L = 1; L < dims.length; L++) {
      const wi = dims[L - 1], wo = dims[L]
      const oi = offsets[L - 1], oo = offsets[L]
      REDUCE += `
@compute @workgroup_size(64)
fn reduceL${L}(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= ${wo.w * wo.h}u) { return; }
  let x = t % ${wo.w}u;
  let y = t / ${wo.w}u;
  let x0 = min(x * 2u, ${wi.w - 1}u);
  let x1 = min(x * 2u + 1u, ${wi.w - 1}u);
  let y0 = min(y * 2u, ${wi.h - 1}u);
  let y1 = min(y * 2u + 1u, ${wi.h - 1}u);
  let a = pyramid[${oi}u + y0 * ${wi.w}u + x0];
  let b = pyramid[${oi}u + y0 * ${wi.w}u + x1];
  let c = pyramid[${oi}u + y1 * ${wi.w}u + x0];
  let d = pyramid[${oi}u + y1 * ${wi.w}u + x1];
  pyramid[${oo}u + t] = max(max(a, b), max(c, d));
}
`
    }
    const PYR_WGSL = `
@group(0) @binding(1) var<storage, read_write> pyramid: array<f32>;
@group(0) @binding(6) var zTex: texture_2d<f32>;
@compute @workgroup_size(64)
fn zToMip0(@builtin(global_invocation_id) gid: vec3<u32>) {
  // THE FLAT 1D GRID: thread t = y * w + x (the family's dispatch is
  // one-dimensional — a 2D gid here silently covered only the first rows)
  let t = gid.x;
  if (t >= ${w * h}u) { return; }
  let x = t % ${w}u;
  let y = t / ${w}u;
  let z = textureLoad(zTex, vec2<i32>(vec2<u32>(x, y)), 0).r;
  pyramid[t] = z;
}
${REDUCE}`
    const reduceId = gpu.createCompute(PYR_WGSL, 16, [storageId], [{ kind: 'sampled', textureId: zTexId }])
    const flat = (w2: number, h2: number): number => Math.max(1, Math.ceil(w2 * h2 / 64))
    const block = new Float32Array(4)
    const levels = dims.length
    const build = (): void => {
      // the z-pass leaves its render pass open — the compute dispatch needs
      // it closed (the facade's tape contract)
      gpu.endPass()
      gpu.runCompute(reduceId, 'zToMip0', block, flat(w, h))
      for (let L = 1; L < levels; L++) {
        gpu.runCompute(reduceId, `reduceL${L}`, block, flat(dims[L].w, dims[L].h))
      }
    }
    return { zTarget, textures: [], storageId, offsets, levels, width: w, height: h, dims, build }
  }

  function program(spec: ProgramSpec): ProgramHandle {
    if (spec.wg === undefined) {
      throw new Error(`rune: createDevice('webgpu').program — the spec carries no wg leg (the WGSL source is the brick's data; without it there is nothing to build)`)
    }
    const pipelineId = ++pipelineSeq
    const depth = { test: spec.depth?.test ?? 'less', write: spec.depth?.write ?? true }
    gpu.ensurePipeline(pipelineId, spec.wg.code, spec.wg.attrs, spec.wg.hasTextures === true, {
      depth: { test: depth.test as 'less', write: depth.write },
      // Task 199 — the cull axis: frontFace 'ccw' matches GL's default CCW
      // front FACE-FOR-FACE (the empirical cross-tier gate settled the
      // convention: the glprobe's 7–47% px / Δmax 144 divergence under the
      // 'cw' mirror was exactly the opposite-faces artifact — the WG front
      // is the SAME physical face as GL's, no y-flip compensation needed)
      raster: { cull: spec.cull ?? 'none', frontFace: 'ccw' },
    })
    const handle: ProgramHandle = { backend: 'webgpu', depth }
    wgPrograms.set(handle, { pipelineId, depth })
    return handle
  }

  function geometry(vertices: Float32Array, indices?: Uint16Array | Uint32Array): GeometryHandle {
    return { vertices, indices }
  }

  function bindGeometryFeed(vertices: Float32Array, indices?: Uint16Array | Uint32Array, size = 3): void {
    gpu.bindVertexBuffer(0, vertices, size)
    if (indices !== undefined) {
      gpu.bindIndexBuffer(indices)
    }
  }

  function drawInstanced(optionsIn: DrawOptions & { instances: number }): void {
    const s = scenes.get(optionsIn.records)
    if (s === undefined) throw new Error('rune: drawInstanced — the records handle is not this device\'s scene')
    const prog = wgPrograms.get(optionsIn.program)
    if (prog === undefined) throw new Error('rune: drawInstanced — the program handle is not this device\'s own')
    const offset = allocUniforms(new Uint8Array(optionsIn.uniforms.buffer, optionsIn.uniforms.byteOffset, optionsIn.uniforms.byteLength))
    gpu.bindTarget(optionsIn.target, optionsIn.clear)
    gpu.usePipeline(prog.pipelineId)
    gpu.bindStorageBuffer(s.bufferId)
    bindGeometryFeed(optionsIn.geometry.vertices, optionsIn.geometry.indices)
    gpu.bindUniforms(offset)
    const count = optionsIn.indexCount ?? 36
    if (optionsIn.geometry.indices !== undefined) gpu.drawIndexed(count, optionsIn.instances)
    else gpu.draw(optionsIn.instances * count, 1)
  }

  function drawVisible(optionsIn: DrawOptions): void {
    const s = scenes.get(optionsIn.records)
    if (s === undefined) throw new Error('rune: drawVisible — the records handle is not this device\'s scene')
    const prog = wgPrograms.get(optionsIn.program)
    if (prog === undefined) throw new Error('rune: drawVisible — the program handle is not this device\'s own')
    // 1. THE COMPACT — must run BEFORE the render pass opens (the facade's
    //    tape contract: compute inside an open render pass is refused)
    s.compactU32[1] = optionsIn.indexCount ?? 36
    gpu.runCompute(s.compactId, 'compact', s.compactBlock, 1)
    // 2. THE PASS + ONE GPU-DRIVEN DRAW — the whole visible set, the
    //    instanceCount GPU-written, zero CPU readbacks
    const offset = allocUniforms(new Uint8Array(optionsIn.uniforms.buffer, optionsIn.uniforms.byteOffset, optionsIn.uniforms.byteLength))
    gpu.bindTarget(optionsIn.target, optionsIn.clear)
    gpu.usePipeline(prog.pipelineId)
    gpu.bindStorageBuffer(s.bufferId)
    bindGeometryFeed(optionsIn.geometry.vertices, optionsIn.geometry.indices)
    gpu.bindUniforms(offset)
    gpu.drawIndexedIndirect(s.argsId, 32)
  }

  function drawQuad(optionsIn: { target: number; clear: boolean; program: ProgramHandle; pyramid: PyramidHandle; level: number; uniforms: Float32Array }): void {
    const prog = wgPrograms.get(optionsIn.program)
    if (prog === undefined) throw new Error('rune: drawQuad — the program handle is not this device\'s own')
    if (optionsIn.pyramid.storageId === undefined) throw new Error('rune: drawQuad — the pyramid brick carries no storage (the WG panel reads the pyramid buffer)')
    const offset = allocUniforms(new Uint8Array(optionsIn.uniforms.buffer, optionsIn.uniforms.byteOffset, optionsIn.uniforms.byteLength))
    gpu.bindTarget(optionsIn.target, optionsIn.clear)
    gpu.usePipeline(prog.pipelineId)
    gpu.bindStorageBuffer(optionsIn.pyramid.storageId)
    gpu.bindVertexBuffer(0, QUAD_LIST, 2)
    gpu.bindUniforms(offset)
    gpu.draw(6, 1)
  }

  function occlusionCuller(sceneHandle: SceneHandle, pyramidHandle: PyramidHandle, spec: CullerSpec): CullerHandle {
    const s = scenes.get(sceneHandle)
    if (s === undefined) throw new Error('rune: occlusionCuller — the scene handle is not this device\'s own')
    if (pyramidHandle.storageId === undefined) {
      throw new Error('rune: occlusionCuller — the pyramid brick carries no storage (the WG kernel reads array<f32> at binding 2 — the Task-196 contract)')
    }
    // THE SLOT MAP: the scene (rw) at binding 1, the pyramid storage (ro) at
    // binding 2 — the facade's fixed compute types [rw, ro, rw] match EXACTLY
    const computeId = gpu.createCompute(spec.wgsl, spec.uniformBytes, [s.bufferId, pyramidHandle.storageId])
    const entry = spec.entry ?? 'cull'
    const workgroups = Math.max(1, Math.ceil(sceneHandle.total / 64))
    return {
      run(block: Float32Array): void {
        gpu.runCompute(computeId, entry, block, workgroups)
      },
    }
  }

  function hizFrame(spec: HizFrameSpec): HizFrameHandle {
    // the handles must all be this device's own — the honest refusals ride
    // the underlying bricks (drawInstanced/drawVisible/culler each verify)
    const s = scenes.get(spec.scene)
    if (s === undefined) throw new Error('rune: hizFrame — the scene handle is not this device\'s own')
    void s
    return {
      run(call: HizFrameCall): void {
        // 1. THE Z PREPASS — the first `occluders` records write the pyramid's
        //    level-0 tile (THE POLICY: the boot default, the whole city, or
        //    anything between — a per-frame decision, no re-compile, no
        //    re-upload)
        drawInstanced({
          target: spec.pyramid.zTarget,
          clear: true,
          program: spec.zPass,
          geometry: spec.geometry,
          records: spec.scene,
          uniforms: call.zUniforms,
          instances: call.occluders,
          indexCount: call.indexCount,
        })
        // 2. THE PYRAMID — the 2×2 MAX reduce chain
        spec.pyramid.build()
        // 3. THE CULL — the per-record verdicts (the kernel is POLICY-FREE:
        //    it tests every record; the cull block's own hizOn word is the
        //    scenario's parity-gate lane, patched before the call)
        spec.culler.run(call.cullUniforms)
        // 4. THE COLOR PASS — the visible set, GPU-driven
        drawVisible({
          target: call.target,
          clear: call.clear ?? true,
          program: spec.colorPass,
          geometry: spec.geometry,
          records: spec.scene,
          uniforms: call.colorUniforms,
          indexCount: call.indexCount,
        })
      },
    }
  }

  async function readCullStats(sceneHandle: SceneHandle): Promise<CullStats> {
    const s = scenes.get(sceneHandle)
    if (s === undefined) throw new Error('rune: readCullStats — the scene handle is not this device\'s own')
    const f = await gpu.readExternalBuffer(s.argsId, 16)
    const u = new Uint32Array(f.buffer, 0, 4)
    return { drawn: u[0], frustum: u[1], occluded: u[2], straddle: u[3] }
  }

  function surface(width: number, height: number, surfaceOptions?: { depth?: boolean }): DeviceSurface {
    const s = renderer.surface({ width, height, depth: surfaceOptions?.depth ?? true, color: clear.color })
    return { targetId: s.targetId, width, height, read: () => s.read() }
  }

  const device: RenderDevice = {
    backend: 'webgpu',
    canvas: options.canvas,
    renderer,
    adapterInfo,
    software,
    antialias: options.antialias === true,
    gpu,
    gl: null,
    scene,
    pyramid,
    program,
    geometry,
    drawInstanced,
    drawVisible,
    drawQuad,
    occlusionCuller,
    hizFrame,
    readCullStats,
    surface,
    debugSceneWords: (sceneHandle: SceneHandle, bytes: number) => {
      const s = scenes.get(sceneHandle)
      if (s === undefined) return Promise.reject(new Error('rune: debugSceneWords — not this device\'s scene'))
      return gpu.readExternalBuffer(s.bufferId, bytes)
    },
    submit(): void {
      gpu.endPass() // an open render pass must not outlive the encoder
      gpu.submit()
      arenaCursor = 0 // the frame's slots are re-used — the tier's fixed-offset discipline, rolled
    },
    dispose(): void {
      try { renderer.dispose() } catch { /* a lost device is already dead */ }
    },
  }
  if (software && onInfo !== undefined) {
    onInfo(`software adapter detected (${adapterInfo.trim() || 'unknown'}) — the canvas present path degrades (snapshot mode is the demo's call)`)
  }
  return device
}

// ─── the WebGL2 leg ───────────────────────────────────────────────────────

function createGlDevice(renderer: WebGL2Renderer, options: DeviceOptions, clear: { color: [number, number, number, number]; depth: number }): RenderDevice {
  const gl = renderer.gl
  const onInfo = options.onInfo
  const scenes = new Map<SceneHandle, GlScene>()
  const programs = new Map<ProgramHandle, GlProgram>()
  let geometryBuf = 0
  let quadBuf = 0
  let reduceProgramId = 0

  function scene(layout: SceneLayout): SceneHandle {
    const handle: SceneHandle = {
      total: layout.total,
      occluders: layout.occluders,
      stride: layout.stride ?? 12,
      fields: { center: layout.fields?.center ?? 0, half: layout.fields?.half ?? 3 },
    }
    const recBuf = gl.createBuffer(layout.recordsF32, 'static')
    const flagBuf = gl.createBuffer(new Float32Array(layout.total), 'dynamic')
    scenes.set(handle, {
      handle,
      recBuf,
      flagBuf,
      flagScratch: new Float32Array(layout.total),
    })
    return handle
  }

  function pyramid(w: number, h: number): PyramidHandle {
    const textures: number[] = [gl.createTexture(w, h, { format: 'r32f' })]
    // the depthBits ladder: 32f stores the EXACT f32 z (the cull-vs-attachment
    // quantization gap disappears); a driver refusal walks down honestly
    let zTarget = 0
    let landed = 0
    for (const bits of [32, 24, 16] as const) {
      try {
        zTarget = gl.createTarget(textures[0], w, h, true, [1, 1, 1, 1], bits)
        landed = bits
        break
      } catch { /* the ladder tries the next precision */ }
    }
    if (landed === 0) {
      throw new Error('rune: the r32f z-target could not attach (EXT_color_buffer_float missing? — the Hi-Z pyramid needs float render targets)')
    }
    if (landed !== 32 && onInfo !== undefined) {
      onInfo(`depth32f renderbuffer refused by the driver — the z prepass rides DEPTH_COMPONENT${landed} (the 1e-5 cull slack covers the quantization gap)`)
    }
    const dims = [{ w, h }]
    const targets: number[] = []
    let cw = w, ch = h
    for (;;) {
      cw = Math.max(1, Math.ceil(cw / 2))
      ch = Math.max(1, Math.ceil(ch / 2))
      const tex = gl.createTexture(cw, ch, { format: 'r32f' })
      textures.push(tex)
      targets.push(gl.createTarget(tex, cw, ch, false, [0, 0, 0, 1]))
      dims.push({ w: cw, h: ch })
      if (cw === 1 && ch === 1) break
    }
    if (reduceProgramId === 0) {
      reduceProgramId = gl.createProgram(REDUCE_GLSL_VS, REDUCE_GLSL_FS)
      quadBuf = gl.createBuffer(QUAD_STRIP)
    }
    const levels = textures.length
    const build = (): void => {
      gl.useProgram(reduceProgramId)
      gl.setUniform1i(reduceProgramId, 'u_src', 0)
      gl.setDepthMode('always', false)
      gl.setCull('none')
      gl.bindVertexBuffer(quadBuf, 0, 2)
      for (let L = 1; L < levels; L++) {
        gl.bindTarget(targets[L - 1], true)
        gl.bindTexture(textures[L - 1], 0)
        gl.drawArrays('triangle-strip', 0, 4, 1)
      }
    }
    return { zTarget, textures, levels, width: w, height: h, dims, build }
  }

  function program(spec: ProgramSpec): ProgramHandle {
    if (spec.gl === undefined) {
      throw new Error(`rune: createDevice('webgl2').program — the spec carries no gl leg (the GLSL sources are the brick's data; without them there is nothing to build)`)
    }
    const programId = gl.createProgram(spec.gl.vs, spec.gl.fs)
    const depth = { test: spec.depth?.test ?? 'less', write: spec.depth?.write ?? true }
    const handle: ProgramHandle = { backend: 'webgl2', depth }
    programs.set(handle, { programId, depth, cull: spec.cull ?? 'none', lanes: spec.gl.lanes, attrs: spec.gl.attrs })
    return handle
  }

  function geometry(vertices: Float32Array, indices?: Uint16Array | Uint32Array): GeometryHandle {
    geometryBuf = gl.createBuffer(vertices)
    if (indices !== undefined) gl.createElementBuffer(indices)
    return { vertices, indices }
  }

  function setUniformLanes(prog: GlProgram, block: Float32Array): void {
    let word = 0
    for (const lane of prog.lanes) {
      const view = block.subarray(word, word + lane.words)
      if (lane.kind === 'mat4') gl.setUniformMatrix4(prog.programId, lane.name, view)
      else gl.setUniform4fv(prog.programId, lane.name, view)
      word += lane.words
    }
  }

  function openPass(target: number, clearTarget: boolean, prog: GlProgram): void {
    if (target === 0) {
      // the GL facade's canvas bind does not clear — the explicit twin
      gl.bindTarget(0, false)
      if (clearTarget) gl.clear(clear.color, clear.depth)
    } else {
      gl.bindTarget(target, clearTarget)
    }
    gl.useProgram(prog.programId)
    gl.setDepthMode(prog.depth.test, prog.depth.write)
    // Task 199 — the program's own cull face (the spec's default 'none'
    // keeps the historical behavior; the z/color passes run 'back' — the
    // front stays GL's default CCW, the WG twin mirrors it with 'cw')
    gl.setCull(prog.cull)
  }

  function bindAttrs(prog: GlProgram, s: GlScene, geometryVertices: Float32Array, withFlags: boolean): void {
    gl.bindVertexBuffer(geometryBuf, 0, 3)
    for (const attr of prog.attrs) {
      if (attr.from === 'records') {
        gl.bindVertexBuffer(s.recBuf, attr.location, attr.size, attr.stride, attr.offset, attr.divisor)
      } else if (attr.from === 'flags' && withFlags) {
        gl.bindVertexBuffer(s.flagBuf, attr.location, attr.size, attr.stride, attr.offset, attr.divisor)
      }
    }
  }

  function drawInstanced(optionsIn: DrawOptions & { instances: number }): void {
    const s = scenes.get(optionsIn.records) as GlScene | undefined
    if (s === undefined) throw new Error('rune: drawInstanced — the records handle is not this device\'s scene')
    const prog = programs.get(optionsIn.program) as GlProgram | undefined
    if (prog === undefined) throw new Error('rune: drawInstanced — the program handle is not this device\'s own')
    openPass(optionsIn.target, optionsIn.clear, prog)
    setUniformLanes(prog, optionsIn.uniforms)
    bindAttrs(prog, s, optionsIn.geometry.vertices, false)
    if (optionsIn.geometry.indices !== undefined) {
      gl.drawElements(elementBufferOf(optionsIn.geometry.indices), optionsIn.indexCount ?? 36, optionsIn.instances, optionsIn.geometry.indices instanceof Uint16Array)
    }
  }

  // the GL facade's drawElements takes the element-buffer id — the device
  // creates it at geometry() time and keys it by the array identity
  const elementBuffers = new Map<Uint16Array | Uint32Array, number>()
  function elementBufferOf(indices: Uint16Array | Uint32Array): number {
    let id = elementBuffers.get(indices)
    if (id === undefined) {
      id = gl.createElementBuffer(indices)
      elementBuffers.set(indices, id)
    }
    return id
  }

  function drawVisible(optionsIn: DrawOptions): void {
    const s = scenes.get(optionsIn.records) as GlScene | undefined
    if (s === undefined) throw new Error('rune: drawVisible — the records handle is not this device\'s scene')
    const prog = programs.get(optionsIn.program) as GlProgram | undefined
    if (prog === undefined) throw new Error('rune: drawVisible — the program handle is not this device\'s own')
    openPass(optionsIn.target, optionsIn.clear, prog)
    setUniformLanes(prog, optionsIn.uniforms)
    // ONE instanced draw over ALL records; the vertex shader collapses
    // flag ∉ {1,4} to a degenerate position — GPU-side visibility
    bindAttrs(prog, s, optionsIn.geometry.vertices, true)
    if (optionsIn.geometry.indices !== undefined) {
      gl.drawElements(elementBufferOf(optionsIn.geometry.indices), optionsIn.indexCount ?? 36, s.handle.total, true)
    }
  }

  function drawQuad(optionsIn: { target: number; clear: boolean; program: ProgramHandle; pyramid: PyramidHandle; level: number; uniforms: Float32Array }): void {
    const prog = programs.get(optionsIn.program) as GlProgram | undefined
    if (prog === undefined) throw new Error('rune: drawQuad — the program handle is not this device\'s own')
    openPass(optionsIn.target, optionsIn.clear, prog)
    setUniformLanes(prog, optionsIn.uniforms)
    gl.setDepthMode('always', false) // the debug panels ride over the scene
    gl.bindTexture(optionsIn.pyramid.textures[optionsIn.level] ?? 0, 0)
    gl.bindVertexBuffer(quadBuf === 0 ? (quadBuf = gl.createBuffer(QUAD_STRIP)) : quadBuf, 0, 2)
    gl.drawArrays('triangle-strip', 0, 4, 1)
  }

  function occlusionCuller(sceneHandle: SceneHandle, pyramidHandle: PyramidHandle, spec: CullerSpec): CullerHandle {
    const s = scenes.get(sceneHandle) as GlScene | undefined
    if (s === undefined) throw new Error('rune: occlusionCuller — the scene handle is not this device\'s own')
    // the TF pass: N vertices (gl_VertexID = the record), a_c/a_h from the
    // records buffer, the pyramid's levels as the sampler array, v_flag out.
    // Task 199 — the AABB feed's stride/offsets are DERIVED from the scene's
    // DECLARED record layout (a different scenario = a different
    // declaration, the same brick)
    const strideBytes = sceneHandle.stride * 4
    const passId = gl.createTransformPass({
      vertex: spec.glsl,
      outputs: ['v_flag'],
      attributes: [
        { name: 'a_c', size: 3, stride: strideBytes, offset: sceneHandle.fields.center * 4 },
        { name: 'a_h', size: 3, stride: strideBytes, offset: sceneHandle.fields.half * 4 },
      ],
      textures: pyramidHandle.textures.map((_, L) => `u_pyr[${L}]`),
      uniforms: spec.lanes.map(lane => ({ name: lane.name, size: 4 })),
    })
    // the lane split for the TF pass's uniformData (the facade's packed form)
    const total = spec.lanes.length * 4
    return {
      run(block: Float32Array): void {
        // THE NEUTRAL TARGET FIRST (the feedback-loop lesson): after the
        // reduce loop the current FBO is the last pyramid target — its
        // attachment is about to be sampled by this pass, and WebGL2
        // silently drops such a draw. The canvas (the default framebuffer,
        // no texture attachments) is the neutral vantage.
        gl.bindTarget(0, false)
        const packed = block.length === total ? block : block.subarray(0, total)
        gl.runTransformPass(passId, sceneHandle.total, {
          bufferId: s.flagBuf,
          attribBuffers: [s.recBuf, s.recBuf],
          textures: pyramidHandle.textures as unknown as number[],
          uniformData: packed,
        })
      },
    }
  }

  async function readCullStats(sceneHandle: SceneHandle): Promise<CullStats> {
    const s = scenes.get(sceneHandle) as GlScene | undefined
    if (s === undefined) throw new Error('rune: readCullStats — the scene handle is not this device\'s own')
    const ok = gl.readBuffer(s.flagBuf, s.flagScratch)
    if (!ok) throw new Error('rune: the flag buffer readback was refused')
    let drawn = 0, frustum = 0, occluded = 0, straddle = 0
    // Task 199 — the sweep counts EVERY record (the kernel tests them all —
    // the WG compact twin): the invariant is frustum + occluded + drawn ===
    // total. A flag 0 (a record never culled this session) lands in NO
    // bucket — the honest form of the pre-boot stats.
    for (let i = 0; i < sceneHandle.total; i++) {
      const f = s.flagScratch[i]
      if (f === 1) drawn++
      else if (f === 2) frustum++
      else if (f === 3) occluded++
      else if (f === 4) { straddle++; drawn++ }
    }
    return { drawn, frustum, occluded, straddle }
  }

  function hizFrame(spec: HizFrameSpec): HizFrameHandle {
    // the honest refusals ride the underlying bricks (each verifies its own
    // handles); here only the scene must resolve — the culler's TF pass and
    // the draws all key off it
    const s = scenes.get(spec.scene) as GlScene | undefined
    if (s === undefined) throw new Error('rune: hizFrame — the scene handle is not this device\'s own')
    void s
    return {
      run(call: HizFrameCall): void {
        // 1. THE Z PREPASS — the first `occluders` records write the tile
        drawInstanced({
          target: spec.pyramid.zTarget,
          clear: true,
          program: spec.zPass,
          geometry: spec.geometry,
          records: spec.scene,
          uniforms: call.zUniforms,
          instances: call.occluders,
          indexCount: call.indexCount,
        })
        // 2. THE PYRAMID — the FBO reduce chain (closes the z-pass FBO too)
        spec.pyramid.build()
        // 3. THE CULL — the TF pass (the neutral-canvas-first lesson lives
        // inside the culler brick)
        spec.culler.run(call.cullUniforms)
        // 4. THE COLOR PASS — ONE instanced draw, the collapse hides the
        // occluded records
        drawVisible({
          target: call.target,
          clear: call.clear ?? true,
          program: spec.colorPass,
          geometry: spec.geometry,
          records: spec.scene,
          uniforms: call.colorUniforms,
          indexCount: call.indexCount,
        })
      },
    }
  }

  function surface(width: number, height: number, surfaceOptions?: { depth?: boolean }): DeviceSurface {
    // the depth ladder: 24 matches the WG surface's depth24plus (the
    // cross-tier bounded-parity gate rides the same precision class)
    let s: ReturnType<WebGL2Renderer['surface']> | null = null
    for (const bits of [24, 16] as const) {
      try {
        s = renderer.surface({ width, height, depth: surfaceOptions?.depth ?? true, color: clear.color, depthBits: bits })
        break
      } catch { /* the next rung */ }
    }
    if (s === null) throw new Error('rune: the GL validation surface could not attach a depth renderbuffer')
    const fixed = s
    return { targetId: fixed.targetId, width, height, read: () => fixed.read() }
  }

  return {
    backend: 'webgl2',
    canvas: options.canvas,
    renderer,
    adapterInfo: 'WebGL2 (ANGLE)',
    software: false,
    antialias: true, // the context cascade's first rung — the driver's own MSAA
    gpu: null,
    gl,
    scene,
    pyramid,
    program,
    geometry,
    drawInstanced,
    drawVisible,
    drawQuad,
    occlusionCuller,
    hizFrame,
    readCullStats,
    surface,
    submit(): void {
      // the GL tier's drain: the renderer's frame boundary reads the GL
      // error queue (the honest cadence — one drain per submitted frame)
      try { renderer.step(Date.now()) } catch { /* the frame-error path already went through onGlError */ }
    },
    dispose(): void {
      try { renderer.dispose() } catch { /* already dead */ }
    },
  }
}
