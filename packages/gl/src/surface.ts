/**
 * Surface + pass — a unified structure for fullscreen passes.
 *
 * Instead of two separate sugars (frag() to generate an image and image()
 * to display it) — ONE construct: a pass of "N inputs → fragment shader →
 * target". Degenerate cases:
 *   - generation:  a pass with no inputs, target = surface (former frag)
 *   - display:     a pass with an input, target = canvas (former image)
 *   - post-processing: capture() renders the scene INTO a surface, then a
 *     chain of passes surface → surface → canvas, each an ordinary render
 *     pass command (written to the same tape via record()).
 *
 * The user writes ONLY the fragment stage; the runtime generates the
 * vertex stage (a clip-space quad from @rune/prims). The shader
 * contract: position/uv attributes are already taken, varying/in — v_uv (GLSL)
 * or @location(0) uv (WGSL, entry point fsMain).
 */

import { quad } from '@rune/prims'
import { OpCode } from '@rune/core'
import type { TapeWriter } from '@rune/core'

/** Reference to an input texture: Texture (renderer) or SurfaceTexture — either works. */
export interface TextureRef {
  readonly textureId: number
}

/** Options of a fullscreen pass. */
export interface PassOptions {
  /** Uniforms: value | (props, ctx) => value (as in command()). */
  readonly uniforms?: Record<string, unknown>
  /** Inputs: sampler name in the shader → texture/surface.
   *  v1 WebGPU: one input per pass (texture bind group limitation). */
  readonly inputs?: Record<string, TextureRef>
  /** Target: a surface (undefined → canvas). */
  readonly target?: { readonly targetId: number }
  /** Clear the target before the pass (default false: the quad covers everything). */
  readonly clear?: boolean
}

/** Options of a target surface. */
export interface SurfaceOptions {
  readonly width?: number
  readonly height?: number
  /** Own depth — for capture() of 3D scenes (default false). */
  readonly depth?: boolean
  /** Clear color (default — the renderer background). */
  readonly color?: readonly [number, number, number, number]
}

/** Result of reading a surface (Task 80: readback — the first slice of
 *  buffer/MRT/readback from the residual backlog of the Task 72 audit).
 *
 *  The contract is IDENTICAL on both backends — "one scene — one image"
 *  extends to CPU reads as well: the same index = the same
 *  pixel regardless of backend:
 *   - data: RGBA8, tight layout (rowBytes = width*4);
 *   - rows TOP-DOWN (texture row 0 = top): the GL facade flips
 *     readPixels, the WebGPU facade compacts the 256-byte alignment and
 *     swizzles BGRA→RGBA — the same format is exposed to the outside. */
export interface SurfaceRead {
  readonly width: number
  readonly height: number
  /** RGBA8 (4 bytes/pixel), row-major, first row is the top one. */
  readonly data: Uint8Array
}

/** Surface: a target texture + fullscreen passes into it. */
export interface Surface<C> {
  /** Target id for BindTarget (diagnostics/substitution into passOptions.target). */
  readonly targetId: number
  /** Surface texture — an input for subsequent passes. */
  readonly texture: { readonly textureId: number; readonly width: number; readonly height: number }
  readonly width: number
  readonly height: number
  /** Fullscreen pass writing INTO this surface. */
  pass(fragment: string, options?: PassOptions): C
  /** Re-target any command to this surface (scene → texture).
   *  clear default true: a 3D scene needs clean color and depth. */
  capture(command: C, options?: { readonly clear?: boolean }): C
  /** Task 80: read surface pixels to the CPU.
   *
   *  Reads the contents AFTER the last executed frame (call outside
   *  the frame callback; the WebGPU path is asynchronous — mapAsync). After dispose —
   *  reject with an honest error. The result is a SurfaceRead (RGBA8, top-down,
   *  backend parity — see SurfaceRead). Not journaled: a read is not a
   *  declaration and needs no replay restoration. */
  read(): Promise<SurfaceRead>
  /** Release the surface's GPU resources (target + texture).
   *  Idempotent: a repeated call is a no-op. After dispose, pass()/capture()
   *  on this surface must NOT throw — but you shouldn't call them either.
   *  The journal (if wrapped) — destroyTarget + destroyTexture ops are written. */
  dispose(): void
}

/** The quad of fullscreen passes (shared by both backends). */
export const FULLSCREEN_QUAD = quad()

/** Generated GLSL vertex stage: feeds the quad's UV to the fragment. */
export const PASS_VERT_GLSL = `#version 300 es
layout(location = 0) in vec2 position;
layout(location = 1) in vec2 uv;
out vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}`

/** Generated WGSL vertex stage (prepended to the user's fragment). */
export const PASS_VERT_WGSL = `struct RunePassVsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}
@vertex
fn vsMain(
  @location(0) position : vec2<f32>,
  @location(1) uv : vec2<f32>,
) -> RunePassVsOut {
  var out : RunePassVsOut;
  out.pos = vec4<f32>(position, 0.0, 1.0);
  out.uv = uv;
  return out;
}
`

/** Command wrapper: emits BindTarget before recording the original.
 *  id is preserved — the executor finds the original in the command registry. */
export function withTarget<C extends { readonly id: number }>(
  command: C & { record(props: unknown, frameCtx: unknown, writer: TapeWriter): void },
  targetId: number,
  clear: boolean,
): C {
  const clearFlag = clear ? 1 : 0
  return {
    id: command.id,
    record(props: unknown, frameCtx: unknown, writer: TapeWriter): void {
      writer.emit(OpCode.BindTarget, targetId, clearFlag, 0, 0)
      command.record(props, frameCtx, writer)
    },
  } as unknown as C
}

/** Names of builtin uniforms that a pass substitutes automatically. */
const BUILTIN_NAMES = ['u_time', 'u_resolution', 'u_texel'] as const

/** Which builtins are declared in the shader (by name occurrence). */
export function scanBuiltins(fragment: string): ReadonlySet<string> {
  const found = new Set<string>()
  for (const name of BUILTIN_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(fragment)) found.add(name)
  }
  return found
}

/** Mutable builtin values: updated on every record, no GC. */
export interface PassBuiltins {
  readonly time: Float32Array
  readonly resolution: Float32Array
  readonly texel: Float32Array
}

export function createPassBuiltins(): PassBuiltins {
  return {
    time: new Float32Array(1),
    resolution: new Float32Array(2),
    texel: new Float32Array(2),
  }
}

/** Write builtin resolvers into the uniforms of a pass spec.
 *  resolutionSource: the actual size of the TARGET in buffer pixels (per-frame). */
export function applyBuiltins(
  uniforms: Record<string, unknown>,
  builtins: ReadonlySet<string>,
  values: PassBuiltins,
  resolutionSource: () => readonly [number, number],
): void {
  if (builtins.has('u_time')) {
    uniforms.u_time = (_props: unknown, ctx: { time: number }) => {
      values.time[0] = ctx.time
      return values.time
    }
  }
  if (builtins.has('u_resolution')) {
    uniforms.u_resolution = () => {
      const [w, h] = resolutionSource()
      values.resolution[0] = w
      values.resolution[1] = h
      return values.resolution
    }
  }
  if (builtins.has('u_texel')) {
    uniforms.u_texel = () => {
      const [w, h] = resolutionSource()
      values.texel[0] = w > 0 ? 1 / w : 0
      values.texel[1] = h > 0 ? 1 / h : 0
      return values.texel
    }
  }
}
