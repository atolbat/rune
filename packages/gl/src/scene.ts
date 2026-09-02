import { createWebGL2Renderer } from './webgl2Renderer.ts'
import type { WebGL2Renderer, WebGL2RendererOptions } from './webgl2Renderer.ts'
import type { AnyCanvas } from './canvasHelpers.ts'
import type { RecordingGL } from '@rune/webgl2'
import type { GPUFacade } from '@rune/webgpu'
import { mat4Multiply, mat4Perspective, mat4RotationX, mat4RotationY, mat4Translation } from '@rune/math'
import { cube } from '@rune/prims'

/**
 * show(): display a cube in one line — sugar from the design dossier.
 * Intent, not mechanism: "show this". Texture (optional) —
 * streamed with preview and progress.
 */

/** Scene options; everything has defaults. */
export interface ShowOptions {
  /** Rotation speed (radians/sec around Y; default 0.7). */
  readonly spin?: number
  /** Background color (default dark blue). */
  readonly background?: readonly [number, number, number, number]
  /** Cube color when no texture (default blue). */
  readonly albedo?: readonly [number, number, number]
  /** RGBA texture: 1024² streaming with preview and progress. */
  readonly texture?: Uint8Array
  readonly textureSize?: number
  /** Caption under the canvas. */
  readonly label?: string
  /** Texture progress callback 0..1. */
  readonly onProgress?: (fraction: number) => void
  /** Selector of the backend badge element (default '#backend') —
   * for pages with several renderers (tabs, comparison). */
  readonly badge?: string
  /** Injections for headless tests. */
  readonly createGL?: () => RecordingGL['gl']
  /** GPU facade injection: recorder pattern for headless tests of the webgpu path. */
  readonly createGPU?: (canvas: AnyCanvas, onError?: (message: string) => void) => Promise<GPUFacade>
  readonly requestFrame?: (callback: (timestamp: number) => void) => () => void
  readonly now?: () => number
  readonly observeResize?: boolean
}

/** A showing: live render with controls. Pause — for tabs/switching. */
export interface Show {
  readonly renderer: WebGL2Renderer
  /** Stop the frame loop (canvas and context stay alive). */
  stop(): void
  /** Pause: the loop goes quiet, resources are not released. */
  pause(): void
  /** Continue after a pause. */
  resume(): void
}

/** Show a cube in one line: show('#canvas', { texture }). */
export function show(target: string | HTMLCanvasElement, options: ShowOptions = {}): Show {
  const spin = options.spin ?? 0.7
  const background = options.background ?? [0.07, 0.08, 0.11, 1]
  const albedo = options.albedo ?? [0.35, 0.6, 0.95]

  const renderer = createWebGL2Renderer({
    canvas: target,
    clear: { color: background, depth: 1 },
    createGL: options.createGL as WebGL2RendererOptions['createGL'],
    requestFrame: options.requestFrame,
    now: options.now,
    observeResize: options.observeResize,
  })

  const geometry = cube(1)
  const hasTexture = options.texture !== undefined

  const VERT = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
${hasTexture ? 'layout(location = 2) in vec2 uv;\nout vec2 v_uv;' : ''}
uniform mat4 u_mvp;
uniform mat4 u_model;
out vec3 v_normal;
void main() {
  v_normal = mat3(u_model) * normal;
  ${hasTexture ? 'v_uv = uv;' : ''}
  gl_Position = u_mvp * vec4(position, 1.0);
}`

  const FRAG = `#version 300 es
precision mediump float;
in vec3 v_normal;
${hasTexture ? 'in vec2 v_uv;\nuniform sampler2D u_tex;' : ''}
uniform vec3 u_lightDir;
uniform vec3 u_albedo;
out vec4 o_color;
void main() {
  float lambert = max(dot(normalize(v_normal), normalize(u_lightDir)), 0.0);
  ${hasTexture
    ? 'vec3 tex = texture(u_tex, v_uv).rgb;\n  o_color = vec4(tex * (0.3 + lambert * 0.7), 1.0);'
    : 'o_color = vec4(u_albedo * (0.3 + lambert * 0.7), 1.0);'}
}`

  // Attributes: uv — only for the textured variant (shader expects @location(2))
  const attributes: Record<string, { data: Float32Array; size: number }> = {
    position: { data: geometry.positions, size: 3 },
    normal: { data: geometry.normals, size: 3 },
  }
  if (hasTexture) attributes.uv = { data: geometry.uvs, size: 2 }
  const uniforms: Record<string, unknown> = {
    u_mvp: (p: { mvp: Float32Array }) => p.mvp,
    u_model: (p: { model: Float32Array }) => p.model,
    u_lightDir: [0.5, 0.8, 0.6],
    u_albedo: albedo,
  }
  let texture: ReturnType<WebGL2Renderer['texture']> | undefined
  // Texture is created before the command: the spec references the handle
  if (hasTexture && options.texture !== undefined) {
    const size = options.textureSize ?? 1024
    texture = renderer.texture(size, size)
  }
  const textures: Record<string, unknown> | undefined =
    hasTexture && texture !== undefined ? { u_tex: texture } : undefined

  const drawCube = renderer.command({
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    pipeline: { depth: { test: 'less', write: true }, raster: { cull: 'back' } },
    attributes,
    uniforms: uniforms as never,
    textures: textures as never,
    count: geometry.vertexCount,
  })

  if (texture !== undefined && options.texture !== undefined) {
    void texture.upload(options.texture, {
      priority: 3,
      onProgress: options.onProgress,
    }).done.catch(() => {})
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

  setBackendLabel('WebGL2', options.badge)
  if (options.label !== undefined) setSceneLabel(options.label)
  renderer.start()

  return {
    renderer,
    stop: () => renderer.stop(),
    pause: () => renderer.stop(),
    resume: () => renderer.start(),
  }
}

function setBackendLabel(text: string, selector = '#backend'): void {
  if (typeof document === 'undefined') return // headless tests without DOM
  const label = document.querySelector(selector)
  if (label !== null) label.textContent = text
}

/** Scene caption: only if the page reserved a slot (#scene-label). */
function setSceneLabel(text: string): void {
  if (typeof document === 'undefined') return // headless tests without DOM
  const label = document.querySelector('#scene-label')
  if (label !== null) label.textContent = text
}
