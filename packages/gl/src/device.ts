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

/** The instance stream: [list | flags | hist | records] words — the shared
 *  scene storage of the occlusion demos. The RECORD LAYOUT is DECLARED, not
 *  assumed: `stride` (words per record) + `fields` (the word offsets of the
 *  cull kernel's a_c/a_h feed) default to the historical 12/0/3 shape, and
 *  the GL attribute feeds + the TF kernel attributes are DERIVED from the
 *  declaration — a different scenario declares a different shape and rides
 *  the same bricks. The WG backend keeps ONE storage buffer over the words;
 *  the GL backend splits it into the float records buffer (attributes) + its
 *  own flag buffer. Task 199: `occluders` is the BOOT default of the runtime
 *  POLICY (the per-frame prepass count — see depthPass's `occluders`).
 *  Task 201: `histWord` — the OPTIONAL hysteresis region ([list: N][flags:
 *  N][hist: N][records: ...], one word per record). Declared = the temporal
 *  policy has a home: the WG leg keeps it in the storage buffer, the GL leg
 *  keeps its own ping-pong pair; the draw/stats read the SMOOTHED verdicts.
 *  Absent = the frame is byte-identical to the pre-201 shape (no hist
 *  machinery, the honest refusal from hysteresisPass). */
export interface SceneLayout {
  readonly total: number
  readonly occluders: number
  readonly words: Uint32Array
  readonly recordsF32: Float32Array
  readonly flagsWord: number
  readonly recordsWord: number
  /** Task 201 — the hysteresis region's word offset (see the interface doc).
   *  WG: must fit inside `words` ([histWord, histWord+total) checked);
   *  GL: a marker (the buffers are the device's own). */
  readonly histWord?: number
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
  /** Task 201 — the declared hist region's word offset, or null (the
   *  scene carries no hysteresis home; hysteresisPass refuses honestly). */
  readonly histWord: number | null
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
 *  scene's float records), 'flags' (the culler's verdict buffer), 'rawFlags'
 *  (Task 207 — the RAW verdict buffer specifically, bypassing the smoothed
 *  hist feed: the same-frame feedback fill reads what THIS frame's first
 *  cull just TF-wrote, never the hysteresis fold's output). */
export interface GlAttrDecl {
  readonly location: number
  readonly from: 'geometry' | 'records' | 'flags' | 'rawFlags'
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
  /** Task 209 — THE NEAR-FIRST ORDER (WG-only): after the compact, the
   *  family's `order` entry bitonic-sorts the visible list by (depth
   *  bucket, record index) so the color pass rides early-Z rejection
   *  behind the front layer. The GL collapse draw has no list — the
   *  option is a documented no-op there. */
  readonly order?: boolean
}

/** Task 209 — the compact's debug readout (readList): the list region
 *  (valid for [0..drawn)) + the FULL verdict words the compact read (raw
 *  or hist per the scene's declaration — the depth bucket rides bits
 *  16..23 on the WG leg) + the drawn count from the args. */
export interface VisibleListReadout {
  readonly list: Uint32Array
  readonly verdicts: Uint32Array
  readonly drawn: number
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
  /** Task 201 — the hysteresis K (default 3; meaningful only when the
   *  scene declared a hist region — the raw recipe then inserts the
   *  temporal pass between the cull and the draw). */
  readonly hysteresisFrames?: number
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
  /** Task 201 — the temporal policy's gate (the scene needs a hist
   *  region; the identity gate keeps the frame byte-identical). */
  readonly hysteresis?: boolean
}

export interface HizFrameHandle {
  run(call: HizFrameCall): void
}

// ─── Task 201 — THE COMPOSABLE PASS BRICKS (the regl/WebGPU syntax) ───────
// The user's ask made literal: «кирпичи, из которых я мог бы создать данный
// куллинг — не одной строкой, а комбинацией фич». The scenario OWNS the
// recipe now — each PASS is a brick built once (its program, its lane
// packing, its intrinsic states), RUN per frame with semantic props:
//
//   const depth  = device.depthPass({ scene, mesh, shaders: dict.z, pyramid })
//   const occl   = device.occlusionPass({ scene, pyramid, kernel: dict.cull })
//   const smooth = device.hysteresisPass({ scene, frames: 3 })
//   const color  = device.visiblePass({ scene, mesh, shaders: dict.color })
//   const strip  = device.debugStrip({ pyramid, shaders: dict.panel })
//
//   depth.run({ camera, occluders })        // 1. the z prepass
//   pyramid.build()                         // 2. the 2x2 max reduce
//   occl.run({ camera, gate: true })        // 3. the frustum + Hi-Z verdicts
//   smooth.run({ gate: true })              // 4. the temporal policy
//   color.run({ target, camera, light })    // 5. the visible set
//
// Each brick packs its OWN uniform lanes (the Task-200 footguns — the
// dither's y-mirror, the cull gate — stay dead: the scenario passes
// semantics, never lane offsets). Hi-Z is NOT hardcoded in the composition
// — it is what the occlusionPass brick + the pyramid resource implement; a
// CPU software-occlusion brick (the @rune/core kit's softwareOccluder)
// composes into the same frame shape. The uniform LANE CONTRACT the bricks
// pack (the dictionary's own):
//   z:     u_mvp (mat4)
//   cull:  u_mvp (mat4) + u_misc (vec4: x = the culling gate)
//   color: u_mvp (mat4) + u_misc (vec4: x = the GL dither's y-mirror height)
//         + u_light (vec4) + u_cam (vec4)
//   panel: u_rect (vec4) + u_info (vec4)
//
// ─── Task 200 — THE SCENARIO BRICK: hizScene (the composition sugar) ───────
// The recipe brick (hizFrame) took the SEQUENCE off the scenario's hands;
// hizScene takes the MECHANICS off them too — and Task 201 reframed it:
// hizScene is now THE COMPOSITION SUGAR over the pass bricks above (the
// same five handles, one frame() call). The scenario that wants the bricks
// in its own hands composes them directly (the demo's tier.js does exactly
// that); the scenario that wants one sentence keeps this.

/** One pass's shader column — the dictionary's z / color / panel shape
 *  (the exact HizPassSources contract): the brick builds its own program
 *  with the pass's intrinsic states (the depth passes test 'less' + write
 *  + cull 'back' — the consistent-winding contract; the panels ride
 *  'always' + no write). */
export type PassShaders = HizPassSources

/** The occlusion kernel column — the dictionary's `cull` shape (the raw
 *  sources as data; the occlusionPass brick wires the scene + the pyramid
 *  around them). */
export interface KernelShaders {
  readonly wg: { readonly code: string; readonly entry?: string; readonly uniformBytes: number }
  readonly gl: string
  readonly lanes: readonly { readonly name: string }[]
}

export interface DepthPassCall {
  /** the camera's view-projection (column-major mat4). */
  readonly camera: { readonly mvp: ArrayLike<number> }
  /** THE OCCLUDER POLICY: how many records write the z prepass this frame
   *  (default: the scene's boot occluders). */
  readonly occluders?: number
  readonly indexCount?: number
}
export interface DepthPassHandle {
  /** THE Z PREPASS — the first `occluders` records into the pyramid's
   *  level-0 tile (the POLICY: the boot default, the whole city, anything
   *  between — a per-frame decision, no re-compile, no re-upload). */
  run(call: DepthPassCall): void
}

export interface OcclusionPassCall {
  readonly camera: { readonly mvp: ArrayLike<number> }
  /** the Hi-Z gate (false = the OFF leg of the parity gates). */
  readonly gate?: boolean
}
export interface OcclusionPassHandle {
  /** THE VERDICT PASS — every record's frustum + Hi-Z test (the kernel is
   *  POLICY-FREE: it tests every record; the gate rides the block's own
   *  misc lane, packed here). */
  run(call: OcclusionPassCall): void
}

export interface HysteresisPassCall {
  /** false (default) = the IDENTITY gate — the pass still RUNS (a scene
   *  with a hist region must keep it coherent every frame: the draw and
   *  the stats read the SMOOTHED verdicts) and copies the raw verdicts
   *  verbatim: byte-identical to the no-hysteresis frame. */
  readonly gate?: boolean
}
export interface HysteresisPassHandle {
  /** THE TEMPORAL POLICY (the Frostbite hysteresis, the BF3 shape): an
   *  occluded verdict must hold `frames` consecutive frames before the
   *  cull lands; a visible verdict shows IMMEDIATELY. Pixel-safe by
   *  construction — a box kept visible one extra frame is a box the kernel
   *  already proved occluded; the depth test buries it behind the very wall
   *  that occludes it. The image never changes; the draw count decays. */
  run(call: HysteresisPassCall): void
}

// ─── Task 202 — THE HISTORY PASS BRICK (the two-pass HZB, phase 1) ─────────
// The published shape (Nanite: «the first pass uses the HZB from last
// frame»; Aaltonen's two-phase occlusion; the CryEngine coverage buffer):
// last frame's visible geometry becomes this frame's occluder set, so the
// pyramid's coverage is the FULL SCENE's, not the K walls' — the city
// occludes itself at the cost of ONE extra depth-only draw of the
// survivors. THE OPTIMIZATION BEYOND THE PAPERS: no reprojection. The
// published variants reproject the previous frame's DEPTH TEXTURE into
// the current camera (a gather with dilation heuristics, disocclusion
// holes, stale near depth from moved geometry); this brick RE-RENDERS the
// previous frame's VISIBLE SET at the current camera instead — the set
// lags one frame, the geometry is exact. Sound by construction: every
// texel the history draw writes is a surface that exists THIS frame at
// THIS camera; a box the feedback culls is behind geometry drawn this
// frame. The lag costs coverage (freshly disoccluded regions carry no
// history — the K-wall fill covers them, the set catches up one frame
// later), never a pixel. WG: the indirect draw over the compacted list
// (the args carry the last frame's instanceCount — zero on a cold start,
// the honest no-op); GL: the collapse draw over all records reading the
// verdict feed (hist-encoded or raw — floor() decodes both).
export interface HistoryPassCall {
  readonly camera: { readonly mvp: ArrayLike<number> }
  /** THE FILL POLICY: how many records run the plain z prepass on top of
   *  the history (the K walls — the hole-filler; the identity leg when the
   *  gate is off; the whole city, anything between). */
  readonly occluders?: number
  /** false (default) = the IDENTITY gate: only the fill prepass runs —
   *  the frame is byte-identical to depthPass's (the parity gates' OFF
   *  leg). true = the prev-visible set draws first, the fill merges on
   *  top (the depth test keeps the nearest surface per texel). */
  readonly gate?: boolean
  readonly indexCount?: number
}
export interface HistoryPassHandle {
  /** THE FEEDBACK PREPASS — the pyramid's level-0 tile: the previous
   *  frame's visible set (gate on) + the occluder fill, depth-only. */
  run(call: HistoryPassCall): void
}

// ─── Task 207 — THE SAME-FRAME FEEDBACK BRICK (the two-pass HZB's
// CURRENT-FRAME phase 2 — the field report's own ask: «the colored boxes
// still don't occlude the rear colored boxes»). Where the history brick
// seeds phase 1 with the PREVIOUS frame's visible set (a one-frame lag),
// this brick re-culls within the frame: the FIRST cull's fresh RAW
// verdicts (flags ∈ {1,4}) re-render DEPTH-ONLY into the pyramid tile,
// the pyramid rebuilds, and a SECOND cull lands — the colored city
// occludes ITSELF at the CURRENT camera, zero temporal lag, for the price
// of the SURVIVORS' depth (V1 ⊆ N — never the whole scene's fill the
// brute «city occludes» policy pays). Sound by the same law the
// city-occluders experiment proved: a builder never self-culls, and a box
// the second cull removes is behind a surface drawn THIS frame at THIS
// camera (the cover-transfer induction carries any culled occluder's
// contribution to the present surface in front of it). WG: the storage
// flags read directly in the vertex shader (no compact, no hist — the
// temporal fold still runs ONCE per frame, on the FINAL verdicts); GL:
// the collapse draw on the RAW verdict buffer (the rawFlags feed — the
// TF-output→attribute law the no-hist configuration field-proved).
export interface FeedbackPassCall {
  readonly camera: { readonly mvp: ArrayLike<number> }
  readonly indexCount?: number
}
export interface FeedbackPassHandle {
  /** THE SAME-FRAME FEEDBACK FILL — the first cull's fresh visible set,
   *  depth-only into the pyramid's level-0 tile (the second cull's seed). */
  run(call: FeedbackPassCall): void
}

export interface VisiblePassCall {
  readonly target: number
  readonly camera: { readonly mvp: ArrayLike<number>; readonly eye: ArrayLike<number> }
  readonly light?: ArrayLike<number>
  readonly clear?: boolean
  readonly indexCount?: number
  /** Task 209 — the near-first list order for this draw (WG-only; see
   *  DrawOptions.order — the early-Z harvest). */
  readonly order?: boolean
}
export interface VisiblePassHandle {
  /** THE VISIBLE SET — the compacted indirect draw (WG) / the collapse
   *  draw (GL). The packed color lanes (mvp + the dither's y-mirror height
   *  + the light + the eye) ride the brick — the scenario passes
   *  SEMANTICS, never lane offsets. */
  run(call: VisiblePassCall): void
}

export interface DebugStripHandle {
  /** THE PYRAMID DEBUG STRIP — one panel quad per mip level. */
  run(call: { readonly target: number }): void
}

type PyramidSpec = PyramidHandle | { readonly width: number; readonly height: number }

/** One draw-pass column of the scenario's shader dictionary (z / color /
 *  panel) — the exact ProgramSpec shape the device bricks take. */
export interface HizPassSources {
  readonly wg: { readonly code: string; readonly attrs: readonly (number | GpuAttrSlot)[]; readonly hasTextures?: boolean }
  readonly gl: { readonly vs: string; readonly fs: string; readonly attrs: readonly GlAttrDecl[]; readonly lanes: readonly UniformLane[] }
}

/** The scenario's whole shader dictionary (the demo's buildShaders()
 *  product): z / color / panel pass columns + the cull kernel pair.
 *  Task 202 — the OPTIONAL `hist` column (the prev-visible depth pass):
 *  present = the sugar composes a historyPass brick and frame({ history })
 *  runs the two-pass HZB; absent = the recipe stays the Task-201 shape. */
export interface HizShaderDict {
  readonly z: HizPassSources
  readonly color: HizPassSources
  readonly panel: HizPassSources
  readonly hist?: HizPassSources
  readonly cull: {
    readonly wg: { readonly code: string; readonly entry?: string; readonly uniformBytes: number }
    readonly gl: string
    readonly lanes: readonly { readonly name: string }[]
  }
}

export interface HizSceneSpec {
  /** the scene (the instance stream) — device.scene()'s handle. */
  readonly scene: SceneHandle
  /** the shader dictionary — the per-language sources as data. */
  readonly shaders: HizShaderDict
  /** the instanced geometry (the boxes, the walls — whatever the records
   *  place). Its index count feeds the prepass/color draws. */
  readonly geometry: GeometryHandle
  /** an existing pyramid handle, or the tile size to build one. */
  readonly pyramid: PyramidSpec
  /** the validation/readback surface ({w, h} — the parity gates' channel). */
  readonly surface?: { readonly width: number; readonly height: number }
  /** the scenario's light direction (xyz; the color pass lane). */
  readonly light?: ArrayLike<number>
  /** Task 201 — the hysteresis K (consecutive occluded frames before the
   *  cull lands; default 3). Only meaningful when the scene declared a
   *  hist region — otherwise the sugar composes no hysteresisPass at all. */
  readonly hysteresisFrames?: number
}

export interface HizSceneFrame {
  /** 0 = the canvas; otherwise a target id (the brick's own surface, or
   *  any target the device knows). */
  readonly target: number
  /** the camera: the view-projection (column-major mat4) + the eye (xyz). */
  readonly camera: { readonly mvp: ArrayLike<number>; readonly eye: ArrayLike<number> }
  /** THE OCCLUDER POLICY: how many records write the z prepass (default:
   *  the scene's boot occluders). */
  readonly occluders?: number
  /** the culling gate (false = the Hi-Z OFF parity leg). Default true. */
  readonly culling?: boolean
  /** the pyramid debug strip. Default false. */
  readonly pyramidView?: boolean
  /** clear the color target (default true). */
  readonly clear?: boolean
  /** per-frame light override (xyz). */
  readonly light?: ArrayLike<number>
  /** Task 201 — the temporal policy's gate (the hysteresis needs a scene
   *  with a hist region; the identity gate keeps the frame byte-identical
   *  otherwise — this knob only decides WHEN the streak starts counting). */
  readonly hysteresis?: boolean
  /** Task 202 — the two-pass HZB's phase 1 (needs a dictionary that carries
   *  the `hist` column): the previous frame's visible set becomes this
   *  frame's occluder set, the K walls fill the holes. Default false. */
  readonly history?: boolean
}

export interface HizSceneHandle {
  /** THE WHOLE Hi-Z FRAME as one sentence (prepass → pyramid → cull →
   *  draw → the debug strip if asked). */
  frame(call: HizSceneFrame): void
  /** the per-record verdict counters (drawn / frustum / occluded / straddle). */
  readStats(): Promise<CullStats>
  /** Task 201 — the RAW per-record verdicts (1..4, pre-hysteresis — the
   *  soft-Hi-Z gate's channel: the CPU model vs the kernel's own words). */
  readVerdicts(): Promise<Uint8Array>
  readonly pyramid: PyramidHandle
  /** the validation surface (null when the spec carried none). */
  readonly surface: DeviceSurface | null
  readonly scene: SceneHandle
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
  /** Task 201 — THE PASS BRICKS: the composable frame. Each handle is
   *  built once from the scene + the shader columns, run per frame with
   *  semantic props; the lane packing lives INSIDE each brick. */
  depthPass(spec: { scene: SceneHandle; mesh: GeometryHandle; shaders: PassShaders; pyramid: PyramidHandle }): DepthPassHandle
  occlusionPass(spec: { scene: SceneHandle; pyramid: PyramidHandle; kernel: KernelShaders }): OcclusionPassHandle
  hysteresisPass(spec: { scene: SceneHandle; frames?: number }): HysteresisPassHandle
  /** Task 202 — THE HISTORY PASS: the previous frame's visible set,
   *  re-rendered depth-only at the current camera (the two-pass HZB's
   *  phase 1) + the occluder fill on top. `shaders` = the prev-set
   *  column (the dictionary's `hist`), `fill` = the plain z column. */
  historyPass(spec: { scene: SceneHandle; mesh: GeometryHandle; pyramid: PyramidHandle; shaders: PassShaders; fill: PassShaders }): HistoryPassHandle
  /** Task 207 — THE SAME-FRAME FEEDBACK PASS: the FIRST cull's fresh RAW
   *  visible set (not the smoothed hist), drawn depth-only into the
   *  pyramid's level-0 tile — the current-frame phase 2 (the second cull's
   *  seed; the colored city occludes itself within the frame). `shaders` =
   *  the dictionary's `fbfill` column. */
  feedbackPass(spec: { scene: SceneHandle; mesh: GeometryHandle; pyramid: PyramidHandle; shaders: PassShaders }): FeedbackPassHandle
  visiblePass(spec: { scene: SceneHandle; mesh: GeometryHandle; shaders: PassShaders; surface?: DeviceSurface }): VisiblePassHandle
  debugStrip(spec: { pyramid: PyramidHandle; shaders: PassShaders }): DebugStripHandle
  /** Task 201 — the RAW per-record verdicts (1..4, pre-hysteresis): the
   *  CPU-model gates' channel (the soft-Hi-Z soundness compare). */
  readVerdicts(scene: SceneHandle): Promise<Uint8Array>
  /** Task 209 — the compact's own source readback: the visible list (the
   *  compact's output — [0..drawn) valid) + the FULL verdict words it
   *  read (raw or hist per the scene's declaration; the depth bucket
   *  rides bits 16..23 on the WG leg) + the drawn count. WG only: the
   *  GL collapse draw keeps no list — null there. */
  readList(scene: SceneHandle): Promise<VisibleListReadout | null>
  /** Task 199 — the whole Hi-Z frame in ONE call (the recipe as a brick). */
  hizFrame(spec: HizFrameSpec): HizFrameHandle
  /** Task 200 — THE SCENARIO BRICK: the dictionary + the handles become a
   *  one-call frame — the programs, the culler, the packed uniform blocks,
   *  the dither mirror and the debug strip all live here. */
  hizScene(spec: HizSceneSpec): HizSceneHandle
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

/** THE COMPACT FAMILY (WG-only — the drawVisible brick's first half):
 *  TWO entries, one bind group, one 16-byte uniform.
 *  `compact` — Task 209 — THE PARALLEL COMPACT: the flags → the stable
 *  ascending visible list + the drawIndexedIndirect args + the stats
 *  block. ONE workgroup of 64 lanes walking the records in 64-wide
 *  tiles: a Hillis-Steele inclusive scan per tile + a running base
 *  carries the index-order rank across tiles — the output list is
 *  BYTE-IDENTICAL to the single-thread spelling it replaced (the
 *  running base + the in-tile stable scan IS the global ascending rank,
 *  by construction), at 64 lanes of width instead of one thread's N
 *  iterations (the last serial N-loop in the frame, gone — the
 *  graphics-research-208 A1 candidate, landed). The stats ride per-lane
 *  registers + one workgroup-atomic fold at the end — counts commute,
 *  the tally is deterministic.
 *  `order` — Task 209 — THE NEAR-FIRST ORDER (the early-Z harvest, the
 *  research A2 candidate): after the compact, bitonic-sort the visible
 *  list by (depth bucket, record index) in workgroup shared memory so
 *  the color pass's early-Z rejects the rear layers (Pettineo's «To
 *  Early-Z, or Not To Early-Z» position — the front-to-back submission
 *  the fixed-function depth test rewards). The bucket rides the verdict
 *  word's bits 16..23 (the cull packs it: NDC-z 0=near → bucket 0; a
 *  near-straddle record rides bucket 0 — a straddling box IS the near
 *  field). Keys pack (bucket << 24) | recordIndex — UNIQUE keys, so the
 *  fixed network needs no stability argument: the sorted order is a
 *  strict total order, deterministic on every backend. Padded to the
 *  next power of two ≤ 2048 (8 KB of keys + the scan/tally = 8.5 KB —
 *  HALF the 16 KB default workgroup-storage limit; the adapter's 32 K
 *  would need a requiredLimits ask the facade declines to make); a drawn
 *  count above the cap keeps the compact's index order (the honest
 *  ladder — every default-ON frame draws ≤ ~1.7k on this city; the
 *  >2048 crowd is the wide single-cull comparison legs, where the order
 *  is irrelevant anyway). `drawn` arrives from args[0] — the compact's own
 *  write, the previous dispatch in this same compute pass (WebGPU
 *  orders dispatches); workgroupUniformLoad makes it a UNIFORM value so
 *  the early return keeps the barriers below legal.
 *  The STABLE-ORDER LAW (the pixel-parity gates' demand) holds in both
 *  spellings: the compact's list is ascending by record index; the order
 *  entry's list is ascending by (bucket, index) — equally deterministic.
 *  The GL leg never runs this family (its collapse draw has no list —
 *  DrawOptions.order is a documented WG-leg no-op there).
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
 * the next rw slot), the args (rw) at binding 3 — the order entry READS
 * args[0] (the compact's drawn) and writes neither. */
const COMPACT_WGSL = `
struct CompactParams { words: vec4<u32> }
@group(0) @binding(0) var<uniform> params: CompactParams;
@group(0) @binding(1) var<storage, read_write> scene: array<u32>;
@group(0) @binding(3) var<storage, read_write> args: array<u32>;
var<workgroup> scan: array<u32, 64>;
var<workgroup> tally: array<atomic<u32>, 3>;
var<workgroup> keys: array<u32, 2048>;
var<workgroup> wgDrawn: u32;
@compute @workgroup_size(64)
fn compact(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  // ONE workgroup — the stability law: the tile loop runs in ascending
  // order, so the running base + the in-tile stable scan produce exactly
  // the serial loop's list (the dispatch has always been 1 workgroup)
  if (wid.x != 0u) { return; }
  let t = lid.x;
  let n = params.words.x;        // the record count
  let flagsOff = params.words.z; // the compact's source region (hist-aware)
  // words.y — the indexCount (thread 0 forwards it to the args);
  // words.w — the boot-time occluder count, carried for diagnostics only
  if (t < 3u) { atomicStore(&tally[t], 0u); }
  var base = 0u;                 // the running visible count (tiles done)
  var myF = 0u; var myO = 0u; var myS = 0u; // per-lane verdict tallies
  for (var b = 0u; b < n; b = b + 64u) {
    let i = b + t;
    var vis = 0u;
    if (i < n) {
      // Task 201 — THE HIST DECODE: the read region may carry the
      // hysteresis encoding (verdict | streak<<8 | bucket<<16); the raw
      // flags carry streak 0, so ONE mask answers both — byte-identical
      // for the raw vocabulary (1..4)
      let f = scene[flagsOff + i] & 0xFFu;
      if (f == 1u || f == 4u) {
        vis = 1u;
        if (f == 4u) { myS = myS + 1u; }
      } else if (f == 2u) {
        myF = myF + 1u;
      } else if (f == 3u) {
        myO = myO + 1u;
      }
    }
    scan[t] = vis;
    workgroupBarrier();
    // THE HILLIS-STEELE INCLUSIVE SCAN (6 doubling steps; read → barrier
    // → add keeps every step ordered — the classic in-place spelling)
    var d = 1u;
    loop {
      if (d >= 64u) { break; }
      var left = 0u;
      if (t >= d) { left = scan[t - d]; }
      workgroupBarrier();
      if (t >= d) { scan[t] = scan[t] + left; }
      workgroupBarrier();
      d = d << 1u;
    }
    // the scatter: EXCLUSIVE prefix = inclusive − predicate; the running
    // base + that IS the record's global index-order rank — the list is
    // byte-identical to the serial spelling, by construction
    if (vis == 1u) { scene[base + scan[t] - 1u] = i; }
    base = base + scan[63];
    workgroupBarrier(); // scan[63] read by all before the next tile's writes
  }
  atomicAdd(&tally[0], myF);
  atomicAdd(&tally[1], myO);
  atomicAdd(&tally[2], myS);
  workgroupBarrier();
  if (t == 0u) {
    // the stats block: drawn = ALL visible records — the accounting
    // invariant frustum + occluded + drawn === n (the GL CPU-sweep twin
    // counts from 0)
    args[0u] = base;
    args[1u] = atomicLoad(&tally[0]);
    args[2u] = atomicLoad(&tally[1]);
    args[3u] = atomicLoad(&tally[2]);
    // drawIndexedIndirect at byte 32: [indexCount, instanceCount,
    // firstIndex, baseVertex, firstInstance] — words 8..12
    args[8u] = params.words.y;
    args[9u] = base;
  }
}
@compute @workgroup_size(64)
fn order(@builtin(local_invocation_id) lid: vec3<u32>) {
  let t = lid.x;
  // the compact's drawn count — a storage read is MAY-be-non-uniform to
  // WGSL's analysis; workgroupUniformLoad (its own barrier) makes the
  // early return uniform, keeping every barrier below legal
  if (t == 0u) { wgDrawn = args[0u]; }
  let drawn = workgroupUniformLoad(&wgDrawn);
  if (drawn == 0u || drawn > 2048u) { return; } // the honest cap — index order stays (the default workgroup-storage limit is 16 KB: 2048 keys + the scan = 8.5 KB, half of it)
  var pad = 1u;
  loop { if (pad >= drawn) { break; } pad = pad << 1u; }
  // load: (bucket << 24) | recordIndex — the bucket from the verdict
  // word's bits 16..23 (the compact's own source region); the padding
  // key 0xFFFFFFFF sorts last and never writes back
  var i = t;
  loop {
    if (i >= pad) { break; }
    if (i < drawn) {
      let rec = scene[i];
      keys[i] = (((scene[params.words.z + rec] >> 16u) & 0xFFu) << 24u) | rec;
    } else {
      keys[i] = 0xFFFFFFFFu;
    }
    i = i + 64u;
  }
  workgroupBarrier();
  // THE BITONIC NETWORK: k grows the block, j halves the partner stride;
  // every element sits in EXACTLY ONE pair per stage and the pair's LOWER
  // slot's lane swaps both ends, so a stage carries no cross-lane hazard —
  // one barrier per stage. Unique keys ⇒ a strict total order ⇒ the
  // network needs no stability argument
  var k = 2u;
  loop {
    if (k > pad) { break; }
    var j = k >> 1u;
    loop {
      if (j == 0u) { break; }
      var i2 = t;
      loop {
        if (i2 >= pad) { break; }
        let p = i2 ^ j;
        if (p > i2) {
          let a = keys[i2];
          let b = keys[p];
          let asc = (i2 & k) == 0u;
          let swap = select(b > a, b < a, asc);
          if (swap) { keys[i2] = b; keys[p] = a; }
        }
        i2 = i2 + 64u;
      }
      workgroupBarrier();
      j = j >> 1u;
    }
    k = k << 1u;
  }
  // store: plain indices back — the draw's list indirection reads
  // scene[ii] as the record, zero shader changes downstream
  var i3 = t;
  loop {
    if (i3 >= drawn) { break; }
    scene[i3] = keys[i3] & 0xFFFFFFu;
    i3 = i3 + 64u;
  }
}`

// ─── Task 201 — THE HYSTERESIS KERNEL (the WG leg of the temporal policy) ──
// The Frostbite decay law, GPU-side: the cull kernel's RAW verdict lands in
// the flags region; this pass folds it into the HIST region — an occluded
// verdict must repeat `frames` times before it culls (the streak rides the
// word's high byte), a visible verdict shows immediately. The identity gate
// (words.w == 0) copies the raw verdict verbatim — byte-identical frames.
// The GL twin is a TRANSFORM-FEEDBACK pass (a_flag = the raw verdict,
// a_prev = the previous encoded word, v_flag = the new encoded word, the
// ping-pong pair keeping the TF-output/attribute-feedback law honest).
const HYST_WGSL = `
struct HystParams { words: vec4<u32> }
@group(0) @binding(0) var<uniform> params: HystParams;
@group(0) @binding(1) var<storage, read_write> scene: array<u32>;
@compute @workgroup_size(64)
fn hysteresis(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.words.x) { return; }
  let raw = scene[params.words.y + i];
  if (params.words.w == 0u) {
    // the identity gate: hist = raw (streak 0) — the no-hysteresis frame
    scene[params.words.z + i] = raw;
    return;
  }
  let prev = scene[params.words.z + i];
  let streak = min((prev >> 8u) & 0xFFu, 15u);
  // Task 209 — THE MASKED DECODE + THE BUCKET CARRY: the raw word's bits
  // 16..23 carry the depth bucket the cull packed (the order entry's
  // sort key); the fold must test the VERDICT BYTE, and its write must
  // CARRY the bucket through — the hist region is the compact's source,
  // and the near-first order must survive the temporal fold
  if ((raw & 0xFFu) == 3u) {
    let s = min(streak + 1u, 15u);
    let K = (params.words.w >> 8u) & 0xFFu;
    let verdict = select(1u, 3u, s >= K);
    scene[params.words.z + i] = verdict | (s << 8u) | (raw & 0xFFFF0000u);
  } else {
    // visible/frustum/straddle show immediately; the streak resets —
    // the verbatim copy carries the bucket's bits untouched
    scene[params.words.z + i] = raw;
  }
}
`

// ─── the GL twin (the TF pass over the same law) ───────────────────────────
const HYST_GLSL = `#version 300 es
layout(location=0) in float a_flag;  // the culler's RAW verdict (1..4)
layout(location=1) in float a_prev;  // the previous ENCODED history word
uniform vec4 u_misc;                 // x: the gate, y: K frames
out float v_flag;
void main() {
  float raw = a_flag;
  if (u_misc.x < 0.5) {
    v_flag = raw; // the identity gate — byte-identical to the raw verdict
  } else {
    // decode: verdict = floor(word); streak = fract(word) * 32 (the 1/32
    // steps are EXACT binary fractions — lossless in f32, the CPU kit's
    // own encoding contract)
    float verdict = floor(a_prev);
    float streak = (a_prev - verdict) * 32.0;
    if (raw == 3.0) {
      streak = min(streak + 1.0, 15.0);
      verdict = streak >= u_misc.y ? 3.0 : 1.0;
    } else {
      streak = 0.0;
      verdict = raw;
    }
    v_flag = verdict + streak / 32.0;
  }
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}`

// ─── the internal scene bookkeeping (per backend) ─────────────────────────

interface WgScene {
  handle: SceneHandle
  bufferId: number
  argsId: number
  compactId: number
  compactBlock: Float32Array
  compactU32: Uint32Array
  /** Task 201 — the raw-verdict region's word offset (readVerdicts' slice). */
  flagsWord: number
}

interface GlScene {
  handle: SceneHandle
  recBuf: number
  flagBuf: number
  flagScratch: Float32Array
  /** Task 201 — the hysteresis ping-pong pair (0 = the scene carries no
   *  hist region; the draw/stats then read the RAW flag buffer, exactly
   *  the pre-201 shape). */
  histA: number
  histB: number
  /** the buffer the LAST hysteresis pass wrote (starts at histA — zeros,
   *  the honest pre-boot verdict: floor(0) lands in no bucket). */
  histCur: number
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

// ─── the shared pass-brick attach bodies (backend-agnostic by
// construction — every call routes to the RenderDevice surface's own
// bricks; only hysteresisPass lives inside each backend closure, its
// compute/TF mechanics being the backend's own) ──────────────────────────

/** THE DEPTH PASS brick: the program from the z column (depth 'less' +
 * write + cull 'back' — the Hi-Z intrinsic states), the 16-word mvp block
 * packed here, the prepass draw into the pyramid's level-0 tile. */
function attachDepthPass(device: RenderDevice, spec: { scene: SceneHandle; mesh: GeometryHandle; shaders: PassShaders; pyramid: PyramidHandle }): DepthPassHandle {
  const program = device.program({ depth: { test: 'less', write: true }, cull: 'back', wg: spec.shaders.wg, gl: spec.shaders.gl })
  const block = new Float32Array(16)
  const indexCount = spec.mesh.indices !== undefined ? spec.mesh.indices.length : 36
  return {
    run(call: DepthPassCall): void {
      const occluders = call.occluders !== undefined
        ? Math.max(0, Math.min(spec.scene.total, call.occluders | 0))
        : spec.scene.occluders
      block.set(call.camera.mvp, 0)
      device.drawInstanced({
        target: spec.pyramid.zTarget,
        clear: true,
        program,
        geometry: spec.mesh,
        records: spec.scene,
        uniforms: block,
        instances: occluders,
        indexCount: call.indexCount ?? indexCount,
      })
    },
  }
}

/** THE OCCLUSION PASS brick: the culler from the kernel column (the scene
 * + the pyramid wired around it), the 20-word block (mvp + the gate lane)
 * packed here — the scenario passes semantics, never lane offsets. */
function attachOcclusionPass(device: RenderDevice, spec: { scene: SceneHandle; pyramid: PyramidHandle; kernel: KernelShaders }): OcclusionPassHandle {
  const culler = device.occlusionCuller(spec.scene, spec.pyramid, {
    wgsl: spec.kernel.wg.code,
    glsl: spec.kernel.gl,
    entry: spec.kernel.wg.entry,
    lanes: spec.kernel.lanes,
    uniformBytes: spec.kernel.wg.uniformBytes,
  })
  const block = new Float32Array(20)
  return {
    run(call: OcclusionPassCall): void {
      block.set(call.camera.mvp, 0)
      block[16] = call.gate === false ? 0 : 1
      culler.run(block)
    },
  }
}

/** THE VISIBLE PASS brick: the program from the color column, the 28-word
 * block (mvp + the dither's y-mirror height + the light + the eye) packed
 * here. THE MIRROR HEIGHT RESOLUTION: target 0 = the canvas's own backing
 * store; the spec's surface (or the surface fallback — the lane only
 * matters where parity is read). */
function attachVisiblePass(device: RenderDevice, spec: { scene: SceneHandle; mesh: GeometryHandle; shaders: PassShaders; surface?: DeviceSurface }): VisiblePassHandle {
  const program = device.program({ depth: { test: 'less', write: true }, cull: 'back', wg: spec.shaders.wg, gl: spec.shaders.gl })
  const block = new Float32Array(28)
  const indexCount = spec.mesh.indices !== undefined ? spec.mesh.indices.length : 36
  const surf = spec.surface ?? null
  function targetHeight(targetId: number): number {
    if (targetId === 0) return device.canvas.height
    if (surf !== null && targetId === surf.targetId) return surf.height
    return surf !== null ? surf.height : device.canvas.height
  }
  return {
    run(call: VisiblePassCall): void {
      const light = call.light !== undefined ? call.light : [0.5, 0.8, 0.35]
      block.set(call.camera.mvp, 0)
      block[16] = targetHeight(call.target)
      block[20] = light[0]; block[21] = light[1]; block[22] = light[2]; block[23] = 0
      block[24] = call.camera.eye[0]; block[25] = call.camera.eye[1]; block[26] = call.camera.eye[2]; block[27] = 1
      device.drawVisible({
        target: call.target,
        clear: call.clear ?? true,
        program,
        geometry: spec.mesh,
        records: spec.scene,
        uniforms: block,
        indexCount: call.indexCount ?? indexCount,
        // Task 209 — the near-first order (the early-Z harvest): the
        // scenario's per-draw policy, straight through to the WG draw
        order: call.order === true,
      })
    },
  }
}

/** THE DEBUG STRIP brick: the panels program (depth 'always', no write) +
 * one quad per pyramid level, the 8-word (rect + info) block packed here. */
function attachDebugStrip(device: RenderDevice, spec: { pyramid: PyramidHandle; shaders: PassShaders }): DebugStripHandle {
  const program = device.program({ depth: { test: 'always', write: false }, wg: spec.shaders.wg, gl: spec.shaders.gl })
  const block = new Float32Array(8)
  const pyr = spec.pyramid
  return {
    run(call: { target: number }): void {
      const w = 2.0 / pyr.levels
      const offsets = pyr.offsets ?? []
      for (let L = 0; L < pyr.levels; L++) {
        block[0] = -1 + L * w + 0.01
        block[1] = -0.97
        block[2] = -1 + (L + 1) * w - 0.01
        block[3] = -0.55
        block[4] = offsets[L] ?? 0
        block[5] = pyr.dims[L].w
        block[6] = pyr.dims[L].h
        block[7] = 0
        device.drawQuad({ target: call.target, clear: false, program, pyramid: pyr, level: L, uniforms: block })
      }
    },
  }
}

/** Task 202 — THE HISTORY PASS brick: the previous frame's visible set,
 *  re-rendered depth-only at the CURRENT camera (the two-pass HZB's phase
 *  1), with the occluder fill merging on top — the nearest surface per
 *  texel wins (the depth test does the merge; the pyramid's max-reduce
 *  stays conservative over the footprint). Backend-agnostic by
 *  construction: the set draw rides drawVisible (WG: the compact + the
 *  indirect draw over the list the last frame left behind; GL: the
 *  collapse draw over all records reading the verdict feed), the fill
 *  rides drawInstanced (the plain z prepass, no clear when it follows the
 *  set). The identity gate (gate off) runs the fill ALONE with the clear —
 *  byte-identical to depthPass's own frame. */
function attachHistoryPass(device: RenderDevice, spec: { scene: SceneHandle; mesh: GeometryHandle; pyramid: PyramidHandle; shaders: PassShaders; fill: PassShaders }): HistoryPassHandle {
  // the set column (the prev-visible pass) + the fill column (the plain z)
  // — the same intrinsic states as the depth passes (less + write + the
  // consistent-winding cull 'back')
  const setProg = device.program({ depth: { test: 'less', write: true }, cull: 'back', wg: spec.shaders.wg, gl: spec.shaders.gl })
  const fillProg = device.program({ depth: { test: 'less', write: true }, cull: 'back', wg: spec.fill.wg, gl: spec.fill.gl })
  const setBlock = new Float32Array(16)
  const fillBlock = new Float32Array(16)
  const indexCount = spec.mesh.indices !== undefined ? spec.mesh.indices.length : 36
  return {
    run(call: HistoryPassCall): void {
      const occluders = call.occluders !== undefined
        ? Math.max(0, Math.min(spec.scene.total, call.occluders | 0))
        : spec.scene.occluders
      const count = call.indexCount ?? indexCount
      fillBlock.set(call.camera.mvp, 0)
      if (call.gate === true) {
        // 1. THE PREV-VISIBLE SET — exactly what the last frame drew
        //    (WG: the compacted list + the GPU-written instanceCount, zero
        //    on a cold start; GL: the collapse draw, floor(a_flag) decode).
        //    The draw CLEARS the tile — the depth attachment starts fresh.
        setBlock.set(call.camera.mvp, 0)
        device.drawVisible({
          target: spec.pyramid.zTarget,
          clear: true,
          program: setProg,
          geometry: spec.mesh,
          records: spec.scene,
          uniforms: setBlock,
          indexCount: count,
        })
        // 2. THE FILL — the K walls on top, NO clear: the depth test merges
        //    (a nearer surface wins its texel — the fill is exact THIS
        //    frame, the history is the one-frame-old superset)
        device.drawInstanced({
          target: spec.pyramid.zTarget,
          clear: false,
          program: fillProg,
          geometry: spec.mesh,
          records: spec.scene,
          uniforms: fillBlock,
          instances: occluders,
          indexCount: count,
        })
      } else {
        // THE IDENTITY GATE — the plain prepass alone (byte-identical to
        // depthPass's own frame; the parity gates' OFF leg)
        device.drawInstanced({
          target: spec.pyramid.zTarget,
          clear: true,
          program: fillProg,
          geometry: spec.mesh,
          records: spec.scene,
          uniforms: fillBlock,
          instances: occluders,
          indexCount: count,
        })
      }
    },
  }
}

/** Task 207 — THE SAME-FRAME FEEDBACK PASS brick: the first cull's fresh
 *  RAW visible set (flags ∈ {1,4} — NOT the smoothed hist feed: the temporal
 *  fold must run exactly once per frame, on the FINAL verdicts), drawn
 *  depth-only into the pyramid tile. Backend-agnostic by construction: the
 *  WG column reads the storage flags in the vertex shader (one plain
 *  instanced draw, instance = record); the GL column collapses on the
 *  TF-written RAW verdict buffer (the rawFlags feed — the same shape the
 *  no-hist configuration has always run). */
function attachFeedbackPass(device: RenderDevice, spec: { scene: SceneHandle; mesh: GeometryHandle; pyramid: PyramidHandle; shaders: PassShaders }): FeedbackPassHandle {
  const program = device.program({ depth: { test: 'less', write: true }, cull: 'back', wg: spec.shaders.wg, gl: spec.shaders.gl })
  const block = new Float32Array(16)
  const indexCount = spec.mesh.indices !== undefined ? spec.mesh.indices.length : 36
  return {
    run(call: FeedbackPassCall): void {
      block.set(call.camera.mvp, 0)
      device.drawInstanced({
        target: spec.pyramid.zTarget,
        clear: true, // the fresh pyramid: the survivors replace the K walls entirely (V1 ⊇ every visible occluder — the cover-transfer law)
        program,
        geometry: spec.mesh,
        records: spec.scene,
        uniforms: block,
        instances: spec.scene.total,
        indexCount: call.indexCount ?? indexCount,
      })
    },
  }
}

/** Task 200 (Task 201 body) — the scenario brick's shared composition: the
 *  five pass bricks above, ONE frame() sentence. Backend-agnostic by
 *  construction (it drives ONLY the RenderDevice surface — every call
 *  routes to the backend's own mechanisms inside the bricks). */
function attachHizScene(device: RenderDevice, spec: HizSceneSpec): HizSceneHandle {
  const pyr = (spec.pyramid as PyramidHandle).build !== undefined
    ? spec.pyramid as PyramidHandle
    : device.pyramid((spec.pyramid as { width: number; height: number }).width, (spec.pyramid as { width: number; height: number }).height)
  const surf = spec.surface !== undefined
    ? device.surface(spec.surface.width, spec.surface.height, { depth: true })
    : null
  // THE BRICKS — the scenario's recipe is the composition's own:
  const depth = device.depthPass({ scene: spec.scene, mesh: spec.geometry, shaders: spec.shaders.z, pyramid: pyr })
  const occl = device.occlusionPass({ scene: spec.scene, pyramid: pyr, kernel: spec.shaders.cull })
  // Task 202 — THE FEEDBACK BRICK joins ONLY when the dictionary carries
  // the prev-set column (absent: the recipe stays the Task-201 shape —
  // frame({ history }) would be a silent no-op, so the brick is not
  // composed at all)
  const hist = spec.shaders.hist !== undefined
    ? device.historyPass({ scene: spec.scene, mesh: spec.geometry, pyramid: pyr, shaders: spec.shaders.hist, fill: spec.shaders.z })
    : null
  // the temporal policy joins the frame ONLY when the scene carries a hist
  // region (honest: a hist-less scene composes no smoothing at all — the
  // frame stays byte-identical to the pre-201 shape)
  const smooth = spec.scene.histWord !== null
    ? device.hysteresisPass({ scene: spec.scene, frames: spec.hysteresisFrames ?? 3 })
    : null
  const color = device.visiblePass({ scene: spec.scene, mesh: spec.geometry, shaders: spec.shaders.color, surface: surf ?? undefined })
  const strip = device.debugStrip({ pyramid: pyr, shaders: spec.shaders.panel })
  // the scenario's light (the per-frame call may override)
  const baseLight = spec.light !== undefined ? [spec.light[0] ?? 0.5, spec.light[1] ?? 0.8, spec.light[2] ?? 0.35] : [0.5, 0.8, 0.35]

  function frame(call: HizSceneFrame): void {
    const occluders = call.occluders !== undefined
      ? Math.max(0, Math.min(spec.scene.total, call.occluders | 0))
      : spec.scene.occluders
    const light = call.light !== undefined ? call.light : baseLight
    // 1..5 — THE COMPOSITION (the bricks, in the recipe's order): the
    // feedback brick replaces the bare prepass when the frame asks for
    // the two-pass HZB (gate on = the prev-visible set + the fill; gate
    // off = the fill alone — byte-identical to depthPass's frame)
    if (hist !== null && call.history === true) {
      hist.run({ camera: call.camera, occluders, gate: true })
    } else {
      depth.run({ camera: call.camera, occluders })
    }
    pyr.build()
    occl.run({ camera: call.camera, gate: call.culling !== false })
    if (smooth !== null) smooth.run({ gate: call.hysteresis === true })
    color.run({ target: call.target, camera: call.camera, light, clear: call.clear })
    if (call.pyramidView === true) strip.run({ target: call.target })
  }

  return {
    frame,
    readStats: () => device.readCullStats(spec.scene),
    readVerdicts: () => device.readVerdicts(spec.scene),
    pyramid: pyr,
    surface: surf,
    scene: spec.scene,
  }
}

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
    const histWord = layout.histWord ?? null
    if (histWord !== null && histWord + layout.total > layout.words.length) {
      throw new Error(`rune: the scene's hist region [${histWord}..${histWord + layout.total}) outruns the words array (${layout.words.length} words) — declare the [list | flags | hist | records] layout`)
    }
    const handle: SceneHandle = {
      total: layout.total,
      occluders: layout.occluders,
      stride: layout.stride ?? 12,
      fields: { center: layout.fields?.center ?? 0, half: layout.fields?.half ?? 3 },
      histWord,
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
    // Task 201 — the compact reads the SMOOTHED verdicts when the scene
    // carries a hist region (the hysteresis kernel keeps it coherent every
    // frame; the & 0xFF decode answers the raw vocabulary identically)
    compactU32[2] = histWord ?? layout.flagsWord
    compactU32[3] = layout.occluders // diagnostics only (the Task-199 policy note)
    const compactId = gpu.createCompute(COMPACT_WGSL, 16, [bufferId, placeholderId, argsId])
    scenes.set(handle, { handle, bufferId, argsId, compactId, compactBlock, compactU32, flagsWord: layout.flagsWord })
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
    // 1½. Task 209 — THE NEAR-FIRST ORDER: the family's second entry
    //     bitonic-sorts the list the compact just wrote (the same compute
    //     pass — WebGPU orders dispatches) by (depth bucket, index), so
    //     the draw's early-Z rejects the rear layers. The keys come from
    //     the verdict words' bits 16..23 — the compact's own source
    //     region rides the shared uniform's words.z
    if (optionsIn.order === true) {
      gpu.runCompute(s.compactId, 'order', s.compactBlock, 1)
    }
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
    // Task 201 — the temporal policy joins the raw recipe ONLY when the
    // scene carries a hist region (the identity gate keeps the
    // no-hysteresis frame byte-identical)
    const smooth = spec.scene.histWord !== null
      ? hysteresisPass({ scene: spec.scene, frames: spec.hysteresisFrames ?? 3 })
      : null
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
        // 3½. THE TEMPORAL POLICY — the streak fold (identity when the call
        //     carries no hysteresis; the compact reads the hist region)
        if (smooth !== null) smooth.run({ gate: call.hysteresis === true })
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

  /** Task 201 — THE HYSTERESIS PASS (the WG leg): ONE compute kernel over
   *  the scene storage — the raw verdicts (flags region) fold into the
   *  hist region, the streak riding the word's high byte. The identity
   *  gate copies verbatim (byte-identical frames). */
  function hysteresisPass(spec: { scene: SceneHandle; frames?: number }): HysteresisPassHandle {
    const s = scenes.get(spec.scene)
    if (s === undefined) throw new Error('rune: hysteresisPass — the scene handle is not this device\'s own')
    const histWord = spec.scene.histWord
    if (histWord === null) {
      throw new Error('rune: hysteresisPass — the scene carries no hist region (declare histWord in device.scene()\'s layout: [list | flags | hist | records])')
    }
    const computeId = gpu.createCompute(HYST_WGSL, 16, [s.bufferId])
    const workgroups = Math.max(1, Math.ceil(spec.scene.total / 64))
    const K = Math.max(1, Math.min(15, spec.frames ?? 3))
    const block = new Float32Array(4)
    const u32 = new Uint32Array(block.buffer)
    u32[0] = spec.scene.total
    u32[1] = s.flagsWord
    u32[2] = histWord
    return {
      run(call: HysteresisPassCall): void {
        // w = the identity gate: EXACTLY 0 when off (the kernel's
        // `w == 0u` test), else 1 | K << 8 (the gate byte + the K byte)
        u32[3] = call.gate === true ? (1 | (K << 8)) : 0
        gpu.runCompute(computeId, 'hysteresis', block, workgroups)
      },
    }
  }

  /** Task 201 — the RAW per-record verdicts (1..4, the flags region). */
  async function readVerdicts(sceneHandle: SceneHandle): Promise<Uint8Array> {
    const s = scenes.get(sceneHandle)
    if (s === undefined) throw new Error('rune: readVerdicts — the scene handle is not this device\'s own')
    // the readback hands back the FIRST bytes of the storage — the flags
    // region rides at the word offset s.flagsWord (the [list] region in
    // front of it): slice the view at its BYTE offset, not at word 0
    const f = await gpu.readExternalBuffer(s.bufferId, (s.flagsWord + sceneHandle.total) * 4)
    const u = new Uint32Array(f.buffer, s.flagsWord * 4, sceneHandle.total)
    const out = new Uint8Array(sceneHandle.total)
    for (let i = 0; i < sceneHandle.total; i++) out[i] = u[i] & 0xFF
    return out
  }

  async function readCullStats(sceneHandle: SceneHandle): Promise<CullStats> {
    const s = scenes.get(sceneHandle)
    if (s === undefined) throw new Error('rune: readCullStats — the scene handle is not this device\'s own')
    const f = await gpu.readExternalBuffer(s.argsId, 16)
    const u = new Uint32Array(f.buffer, 0, 4)
    return { drawn: u[0], frustum: u[1], occluded: u[2], straddle: u[3] }
  }

  /** Task 209 — the compact's debug readback (the WG leg): the list
   *  region + the verdict words the compact READ (compactU32[2] is the
   *  kernel's own source — hist-aware, exactly what the list was built
   *  from) in one storage readback; the drawn count rides the args. The
   *  identity/order gates consume this — the JS oracle recomputes the
   *  list from the verdict bytes and compares element-for-element. */
  async function readList(sceneHandle: SceneHandle): Promise<VisibleListReadout | null> {
    const s = scenes.get(sceneHandle)
    if (s === undefined) throw new Error('rune: readList — the scene handle is not this device\'s own')
    const verdictOff = s.compactU32[2]
    const listWords = Math.max(s.flagsWord, verdictOff)
    const span = listWords + sceneHandle.total
    const f = await gpu.readExternalBuffer(s.bufferId, span * 4)
    const u = new Uint32Array(f.buffer, 0, span)
    const stats = await readCullStats(sceneHandle)
    return {
      list: u.slice(0, listWords),
      verdicts: u.slice(verdictOff, verdictOff + sceneHandle.total),
      drawn: stats.drawn,
    }
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
    // Task 201 — THE PASS BRICKS: the shared attach bodies drive BOTH
    // device closures (they call only the interface's surface); the
    // hysteresis pass is THIS closure's own (compute is the WG mechanism)
    depthPass: (spec) => attachDepthPass(device, spec),
    occlusionPass: (spec) => attachOcclusionPass(device, spec),
    hysteresisPass,
    historyPass: (spec) => attachHistoryPass(device, spec),
    feedbackPass: (spec) => attachFeedbackPass(device, spec),
    visiblePass: (spec) => attachVisiblePass(device, spec),
    debugStrip: (spec) => attachDebugStrip(device, spec),
    readVerdicts,
    readList,
    hizFrame,
    // Task 200 — the scenario brick: the same attachHizScene body drives
    // BOTH device closures (it calls only the interface's own bricks)
    hizScene: (spec: HizSceneSpec) => attachHizScene(device, spec),
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
    const histWord = layout.histWord ?? null
    const handle: SceneHandle = {
      total: layout.total,
      occluders: layout.occluders,
      stride: layout.stride ?? 12,
      fields: { center: layout.fields?.center ?? 0, half: layout.fields?.half ?? 3 },
      histWord,
    }
    const recBuf = gl.createBuffer(layout.recordsF32, 'static')
    const flagBuf = gl.createBuffer(new Float32Array(layout.total), 'dynamic')
    // Task 201 — the hist pair (the GL leg's own home for the temporal
    // policy's state; the layout's histWord is the MARKER, the buffers are
    // ours — the WG twin keeps the region inside the scene storage)
    let histA = 0, histB = 0
    if (histWord !== null) {
      histA = gl.createBuffer(new Float32Array(layout.total), 'dynamic')
      histB = gl.createBuffer(new Float32Array(layout.total), 'dynamic')
    }
    scenes.set(handle, {
      handle,
      recBuf,
      flagBuf,
      flagScratch: new Float32Array(layout.total),
      histA,
      histB,
      histCur: histA,
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
      } else if (attr.from === 'rawFlags') {
        // Task 207 — THE SAME-FRAME FEEDBACK FEED: the RAW verdicts the first
        // cull TF-wrote THIS frame (never the smoothed hist — the temporal
        // fold runs once, on the final verdicts). The TF-output→attribute
        // readback is the no-hist configuration's own field-proven law.
        gl.bindVertexBuffer(s.flagBuf, attr.location, attr.size, attr.stride, attr.offset, attr.divisor)
      } else if (attr.from === 'flags' && withFlags) {
        // Task 201 — the collapse feed reads the SMOOTHED verdicts when the
        // scene carries a hist region (the VS decodes floor(a_flag) — the
        // raw vocabulary answers identically); the hysteresis pass keeps
        // histCur coherent every frame, identity included
        const feed = s.histA !== 0 ? s.histCur : s.flagBuf
        gl.bindVertexBuffer(feed, attr.location, attr.size, attr.stride, attr.offset, attr.divisor)
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
    // Task 209 — `order` is IGNORED on the GL leg (a documented no-op): the
    // collapse draw runs all N instances with the vertex-shader collapse —
    // there is no compacted list to sort; the near-first early-Z harvest is
    // the WG leg's own
    void optionsIn.order
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
      // Task 200 — the index-width honesty (the drawInstanced twin always
      // derived it; the hardcode silently misdraws any u32-indexed scene)
      gl.drawElements(elementBufferOf(optionsIn.geometry.indices), optionsIn.indexCount ?? 36, s.handle.total, optionsIn.geometry.indices instanceof Uint16Array)
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
    // Task 201 — the stats sweep reads the SMOOTHED verdicts when the scene
    // carries a hist region (the hysteresis pass keeps it coherent); the
    // floor decode answers the raw vocabulary (1..4) identically
    const feed = s.histA !== 0 ? s.histCur : s.flagBuf
    const ok = gl.readBuffer(feed, s.flagScratch)
    if (!ok) throw new Error('rune: the flag buffer readback was refused')
    let drawn = 0, frustum = 0, occluded = 0, straddle = 0
    // Task 199 — the sweep counts EVERY record (the kernel tests them all —
    // the WG compact twin): the invariant is frustum + occluded + drawn ===
    // total. A flag 0 (a record never culled this session) lands in NO
    // bucket — the honest form of the pre-boot stats.
    for (let i = 0; i < sceneHandle.total; i++) {
      const f = Math.floor(s.flagScratch[i])
      if (f === 1) drawn++
      else if (f === 2) frustum++
      else if (f === 3) occluded++
      else if (f === 4) { straddle++; drawn++ }
    }
    return { drawn, frustum, occluded, straddle }
  }

  /** Task 201 — THE HYSTERESIS PASS (the GL leg): a TRANSFORM-FEEDBACK pass
   *  — a_flag (the culler's raw verdict) + a_prev (the previous encoded
   *  word) fold into the NEXT hist buffer (the ping-pong keeps the
   *  TF-output/attribute feedback law honest: the output never overlaps a
   *  live vertex binding), then histCur flips. The identity gate copies
   *  the raw verdict verbatim — byte-identical frames. */
  function hysteresisPass(spec: { scene: SceneHandle; frames?: number }): HysteresisPassHandle {
    const s = scenes.get(spec.scene) as GlScene | undefined
    if (s === undefined) throw new Error('rune: hysteresisPass — the scene handle is not this device\'s own')
    if (s.histA === 0) {
      throw new Error('rune: hysteresisPass — the scene carries no hist region (declare histWord in device.scene()\'s layout: [list | flags | hist | records])')
    }
    const passId = gl.createTransformPass({
      vertex: HYST_GLSL,
      outputs: ['v_flag'],
      attributes: [
        { name: 'a_flag', size: 1, stride: 4, offset: 0 },
        { name: 'a_prev', size: 1, stride: 4, offset: 0 },
      ],
      uniforms: [{ name: 'u_misc', size: 4 }],
    })
    const K = Math.max(1, Math.min(15, spec.frames ?? 3))
    const block = new Float32Array(4)
    return {
      run(call: HysteresisPassCall): void {
        block[0] = call.gate === true ? 1 : 0
        block[1] = K
        block[2] = 0
        block[3] = 0
        const next = s.histCur === s.histA ? s.histB : s.histA
        gl.runTransformPass(passId, spec.scene.total, {
          bufferId: next,
          attribBuffers: [s.flagBuf, s.histCur],
          uniformData: block,
        })
        s.histCur = next
      },
    }
  }

  /** Task 201 — the RAW per-record verdicts (1..4, the culler's own flag
   *  buffer — pre-hysteresis; the CPU-model gates' channel). */
  async function readVerdicts(sceneHandle: SceneHandle): Promise<Uint8Array> {
    const s = scenes.get(sceneHandle) as GlScene | undefined
    if (s === undefined) throw new Error('rune: readVerdicts — the scene handle is not this device\'s own')
    const ok = gl.readBuffer(s.flagBuf, s.flagScratch)
    if (!ok) throw new Error('rune: the flag buffer readback was refused')
    const out = new Uint8Array(sceneHandle.total)
    for (let i = 0; i < sceneHandle.total; i++) {
      const f = Math.floor(s.flagScratch[i])
      out[i] = f >= 1 && f <= 4 ? f : 0
    }
    return out
  }

  function hizFrame(spec: HizFrameSpec): HizFrameHandle {
    // the honest refusals ride the underlying bricks (each verifies its own
    // handles); here only the scene must resolve — the culler's TF pass and
    // the draws all key off it
    const s = scenes.get(spec.scene) as GlScene | undefined
    if (s === undefined) throw new Error('rune: hizFrame — the scene handle is not this device\'s own')
    void s
    // Task 201 — the temporal policy joins the raw recipe ONLY when the
    // scene carries a hist region (the identity gate keeps the
    // no-hysteresis frame byte-identical)
    const smooth = spec.scene.histWord !== null
      ? hysteresisPass({ scene: spec.scene, frames: spec.hysteresisFrames ?? 3 })
      : null
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
        // 3½. THE TEMPORAL POLICY — the streak fold (identity when the call
        // carries no hysteresis; the collapse feed reads histCur)
        if (smooth !== null) smooth.run({ gate: call.hysteresis === true })
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

  const device: RenderDevice = {
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
    // Task 201 — THE PASS BRICKS: the shared attach bodies drive BOTH
    // device closures (they call only the interface's surface); the
    // hysteresis pass is THIS closure's own (transform feedback is the GL
    // mechanism)
    depthPass: (spec) => attachDepthPass(device, spec),
    occlusionPass: (spec) => attachOcclusionPass(device, spec),
    hysteresisPass,
    historyPass: (spec) => attachHistoryPass(device, spec),
    feedbackPass: (spec) => attachFeedbackPass(device, spec),
    visiblePass: (spec) => attachVisiblePass(device, spec),
    debugStrip: (spec) => attachDebugStrip(device, spec),
    readVerdicts,
    // Task 209 — the WG leg's list readback has NO GL twin: the collapse draw
    // keeps no list (order is a WG-leg harvest — null answers the contract)
    readList: () => Promise.resolve(null),
    hizFrame,
    // Task 200 — the scenario brick: the same attachHizScene body drives
    // BOTH device closures (it calls only the interface's own bricks)
    hizScene: (spec: HizSceneSpec) => attachHizScene(device, spec),
    readCullStats,
    surface,
    submit(): void {
      // Task 200 — THE GL SUBMIT ROOT FIX: the renderer's frame boundary is
      // the SERVICE pass, not step(). step() runs the renderer's own
      // recorded tape — an EMPTY BeginPass/EndPass for a raw-facade driver —
      // and the executor's BeginPass BINDS THE CANVAS AND CLEARS IT. Every
      // submitted frame ended with the demo's finished color pass being
      // wiped to the clear color: stats alive, gates alive (they read the
      // SURFACE), the visible canvas empty — the phone field report, and
      // the headless "stale composite" the probe180 dossier had misread as
      // a screenshot quirk. service() keeps the boundary's real jobs —
      // the canvas-state heal + the GL error drain — and touches no pixel.
      try { renderer.service(Date.now()) } catch { /* the error drain already went through onGlError */ }
    },
    dispose(): void {
      try { renderer.dispose() } catch { /* already dead */ }
    },
  }
  return device
}
