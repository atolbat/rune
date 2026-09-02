import { createWebGpuRenderer } from './webgpuRenderer.ts'
import type { WebGpuRenderer } from './webgpuRenderer.ts'
import type { ShowOptions } from './scene.ts'
import { mat4Multiply, mat4Perspective, mat4RotationX, mat4RotationY, mat4Translation } from '@rune/math'
import { cube } from '@rune/prims'

/**
 * showOnWebGpu(): show the cube on WebGPU — a mirror of the WebGL2 version.
 * Same texture streaming, same options; tapes + executor. Both shader branches
 * (with and without texture) carry the same Lambert lighting — parity of
 * face shading with the GLSL version from scene.ts (the "flat cube" incident).
 */

const WGSL_TEX = `
struct Params {
  u_mvp     : mat4x4<f32>,
  u_model   : mat4x4<f32>,
  u_lightDir : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) worldNormal : vec3<f32>,
  @location(1) uv : vec2<f32>,
}

@vertex
fn vsMain(
  @location(0) inPos : vec3<f32>,
  @location(1) inNormal : vec3<f32>,
  @location(2) inUv : vec2<f32>,
) -> VSOut {
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(inPos, 1.0);
  out.worldNormal = (params.u_model * vec4<f32>(inNormal, 0.0)).xyz;
  out.uv = inUv;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let lambert = max(dot(normalize(frag.worldNormal), normalize(params.u_lightDir.xyz)), 0.0);
  let tex = textureSample(texTexture, texSampler, frag.uv);
  return vec4<f32>(tex.rgb * (0.3 + lambert * 0.7), 1.0);
}`

const WGSL_FLAT = `
struct Params {
  u_mvp     : mat4x4<f32>,
  u_model   : mat4x4<f32>,
  u_lightDir : vec4<f32>,
  u_albedo   : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) worldNormal : vec3<f32>,
}

@vertex
fn vsMain(
  @location(0) inPos : vec3<f32>,
  @location(1) inNormal : vec3<f32>,
) -> VSOut {
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(inPos, 1.0);
  out.worldNormal = (params.u_model * vec4<f32>(inNormal, 0.0)).xyz;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let lambert = max(dot(normalize(frag.worldNormal), normalize(params.u_lightDir.xyz)), 0.0);
  return vec4<f32>(params.u_albedo.rgb * (0.3 + lambert * 0.7), 1.0);
}`

/** A showing on WebGPU. Pause — for tabs/switching (like the WebGL2 version). */
export interface WebGpuShow {
  readonly renderer: WebGpuRenderer
  stop(): void
  pause(): void
  resume(): void
}

/** Starts showing the cube on WebGPU (texture streaming — as in the WebGL2 version). */
export async function showOnWebGpu(canvas: HTMLCanvasElement, options: ShowOptions): Promise<WebGpuShow> {
  const spin = options.spin ?? 0.7
  const albedo = options.albedo ?? [0.35, 0.6, 0.95]
  // Injections are passed through: the recorder facade runs the webgpu path without a browser
  const renderer = await createWebGpuRenderer({
    canvas,
    onGpuError: () => {},
    createGPU: options.createGPU,
    requestFrame: options.requestFrame,
    now: options.now,
    observeResize: options.observeResize,
  })
  const geometry = cube(1)
  const hasTexture = options.texture !== undefined

  // Texture before the command: the spec references the handle
  let textureId: number | undefined
  if (hasTexture && options.texture !== undefined) {
    const size = options.textureSize ?? 1024
    textureId = renderer.gpu.createTexture(size, size)
  }

  const attributes: Record<string, { data: Float32Array; size: number }> = {
    inPos: { data: geometry.positions, size: 3 },
    inNormal: { data: geometry.normals, size: 3 },
  }
  if (hasTexture) attributes.inUv = { data: geometry.uvs, size: 2 }

  const uniforms: Record<string, unknown> = {
    u_mvp: (p: { mvp: Float32Array }) => p.mvp,
    u_model: (p: { model: Float32Array }) => p.model,
    u_lightDir: [0.5, 0.8, 0.6, 0],
  }
  if (!hasTexture) uniforms.u_albedo = [albedo[0], albedo[1], albedo[2], 1]

  const spec: Record<string, unknown> = {
    shader: { wgsl: hasTexture ? WGSL_TEX : WGSL_FLAT },
    // Rasterization parity with the WebGL2 scene (scene.ts): same depth/cull
    pipeline: { depth: { test: 'less', write: true }, raster: { cull: 'back' } },
    uniforms,
    attributes,
    count: geometry.vertexCount,
  }
  if (hasTexture && textureId !== undefined) {
    spec.textures = { texTexture: { textureId } }
  }

  const drawCube = renderer.command(spec as never)

  // Texture streaming — by the same scheduler as the WebGL2 version
  if (hasTexture && options.texture !== undefined && textureId !== undefined) {
    const { streamTexture } = await import('@rune/core')
    void streamTexture(
      renderer.uploads,
      options.texture,
      options.textureSize ?? 1024,
      options.textureSize ?? 1024,
      (tile, bytes) => {
        renderer.gpu.texSubImage2D(textureId!, tile.x, tile.y, tile.width, tile.height, bytes)
      },
      { priority: 3, onProgress: options.onProgress },
    ).done.catch(() => {})
  }

  const view = new Float32Array(16)
  const projection = new Float32Array(16)
  const viewProj = new Float32Array(16)
  const model = new Float32Array(16)
  const rotX = new Float32Array(16)
  const rotated = new Float32Array(16)
  const mvp = new Float32Array(16)
  let cachedAspect = 0

  mat4Translation(view, 0, 0, -6)

  renderer.frame((ctx, record) => {
    if (ctx.aspect !== cachedAspect) {
      cachedAspect = ctx.aspect
      mat4Perspective(projection, Math.PI / 4, ctx.aspect, 0.1, 100)
      mat4Multiply(viewProj, projection, view)
    }
    mat4RotationY(model, ctx.time * spin)
    mat4RotationX(rotX, ctx.time * spin * 0.55)
    mat4Multiply(rotated, model, rotX)
    mat4Multiply(mvp, viewProj, rotated)
    record(drawCube, { mvp, model: rotated })
  })
  renderer.start()

  return {
    renderer,
    stop: () => renderer.stop(),
    pause: () => renderer.stop(),
    resume: () => renderer.start(),
  }
}
