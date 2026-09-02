/**
 * Task 81: a functional probe of WebGL2 float texture formats.
 *
 * Lessons baked into the design (all — from real reports):
 *
 *  1. EXTENSION ≠ CAPABILITY. OES_texture_float is a WebGL1 artifact:
 *     in a WebGL2 context it is NOT exposed (float storage is core), so
 *     checking "a feature by its extension" is not possible at all. And vice versa: SwiftShader
 *     (headless) SILENTLY accepts texStorage2D/texImage2D with RGBA32F (err=0!),
 *     but sampling returns black — the only honest check is to
 *     DRAW and READ pixels.
 *
 *  2. ONE PATH ≠ THE OTHER. A driver may support mutable allocation
 *     (texImage2D-null) and not immutable (texStorage2D) — and vice versa.
 *     The engine uses BOTH (mipLevels>1 → texStorage2D; mipLevels=1 →
 *     texImage2D), so the probe walks both paths SEPARATELY, and the facade
 *     picks the working one (degrade within a single format, §9.2 P1).
 *
 *  3. CALIBRATION. The probe itself may break (shader failed to compile,
 *     incomplete FBO, readPixels forbidden). RGBA8 control: if the "basic"
 *     format cannot be read through our own machinery — the verdicts cannot be trusted
 *     → fail-open (no degradation, the behavior as before the probe).
 *
 *  4. STATE PURITY. The probe runs on a live context BEFORE the first
 *     frame: saves/restores viewport/program/VAO/FBO/textures,
 *     drains the error queue BEFORE and AFTER, deletes all scratch objects.
 *     Synchronous (OffscreenCanvas — a worker-safe source), no
 *     requestAdapter/canvases/GPU initialization.
 */

/** Verdict for a single float format: which allocation paths are alive. */
export interface FloatFormatPaths {
  /** immutable path: texStorage2D + source upload + NON-black sampling. */
  readonly immutable: boolean
  /** mutable path: texImage2D(null) + source upload + NON-black sampling. */
  readonly mutable: boolean
}

/** The full verdict of the context's float-format probe. */
export interface FloatFormatsProbe {
  readonly rgba16f: FloatFormatPaths
  readonly rgba32f: FloatFormatPaths
  /**
   * Calibration: the RGBA8 control read NON-black through the same machinery.
   * false → the probe cannot be trusted (the environment is broken) — the facade does NOT degrade
   * paths, and caps does NOT disable features (fail-open, as before Task 81).
   */
  readonly calibrated: boolean
}

/** Fail-open verdict: "everything works" (the probe could not run). */
export function floatFormatsAllSupported(): FloatFormatsProbe {
  return {
    rgba16f: { immutable: true, mutable: true },
    rgba32f: { immutable: true, mutable: true },
    calibrated: false,
  }
}

/** Is the format alive on at least one path? (for caps features). */
export function floatFormatUsable(paths: FloatFormatPaths): boolean {
  return paths.immutable || paths.mutable
}

// ─── Spec-fixed GLenums (also available in cut-down mock GLs) ──────────────
const GL = {
  TEXTURE_2D: 0x0de1,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  HALF_FLOAT: 0x140b,
  FLOAT: 0x1406,
  RGBA8: 0x8058,
  RGBA16F: 0x881a,
  RGBA32F: 0x8816,
  NEAREST: 0x2600,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  CLAMP_TO_EDGE: 0x812f,
  NO_ERROR: 0,
  FRAGMENT_SHADER: 0x8b30,
  VERTEX_SHADER: 0x8b31,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88e4,
  TRIANGLE_STRIP: 0x0005,
  COLOR_BUFFER_BIT: 0x4000,
  FRAMEBUFFER: 0x8d40,
  COLOR_ATTACHMENT0: 0x8ce0,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
} as const

const PROBE_VS = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main(){ v_uv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.0,1.0); }`
const PROBE_FS = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex;
void main(){ o = texture(u_tex, v_uv); }`

/** Scratch source 8×8: the left half red, the right half green.
 *  OffscreenCanvas — synchronous and worker-safe; in environments without it
 *  (neither OffscreenCanvas nor document) the probe honestly calibrates to false. */
function makeProbeSource(): unknown | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(8, 8)
      const ctx = c.getContext('2d')
      if (ctx === null) return null
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 4, 8)
      ctx.fillStyle = '#00ff00'; ctx.fillRect(4, 0, 4, 8)
      return c
    }
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const c = document.createElement('canvas')
      c.width = 8; c.height = 8
      const ctx = c.getContext('2d')
      if (ctx === null) return null
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 4, 8)
      ctx.fillStyle = '#00ff00'; ctx.fillRect(4, 0, 4, 8)
      return c
    }
  } catch {
    return null
  }
  return null
}

/** Drain the error queue (with protection against an infinite loop). */
function drainErrors(gl: WebGL2RenderingContext): void {
  for (let i = 0; i < 32; i++) {
    if (gl.getError() === GL.NO_ERROR) return
  }
}

interface ProbeMachinery {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  vbo: WebGLBuffer
  vs: WebGLShader
  fs: WebGLShader
}

/** Sampling check: draw a quad with the texture into an 8×8 RGBA8-FBO, read the center
 *  of each half. Returns true if AT LEAST one pixel is not black
 *  (channel > 32). It is precisely "draw and read" that catches the class of SwiftShader bugs
 *  "allocation OK, sampling black". */
function sampleIsColored(
  gl: WebGL2RenderingContext,
  m: ProbeMachinery,
  texture: WebGLTexture,
): boolean {
  const rgba8 = gl.createTexture()
  gl.bindTexture(GL.TEXTURE_2D, rgba8)
  gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 8, 8, 0, GL.RGBA, GL.UNSIGNED_BYTE, null)
  gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST)
  gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(GL.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, rgba8, 0)
  if (gl.checkFramebufferStatus(GL.FRAMEBUFFER) !== GL.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(GL.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fbo)
    gl.deleteTexture(rgba8)
    return false
  }
  gl.bindTexture(GL.TEXTURE_2D, texture)
  gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST)
  gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST)
  gl.viewport(0, 0, 8, 8)
  gl.useProgram(m.program)
  const loc = gl.getUniformLocation(m.program, 'u_tex')
  if (loc !== null) gl.uniform1i(loc, 0)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(GL.COLOR_BUFFER_BIT)
  gl.bindVertexArray(m.vao)
  gl.drawArrays(GL.TRIANGLE_STRIP, 0, 4)
  const px = new Uint8Array(8)
  gl.readPixels(1, 3, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, px, 0)
  gl.readPixels(6, 3, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, px, 4)
  gl.bindVertexArray(null)
  gl.bindFramebuffer(GL.FRAMEBUFFER, null)
  gl.deleteFramebuffer(fbo)
  gl.deleteTexture(rgba8)
  drainErrors(gl)
  const colored = (i: number): boolean => px[i]! > 32 || px[i + 1]! > 32 || px[i + 2]! > 32
  return colored(0) || colored(4)
}

/** One path × one format: allocation → source upload → sampling.
 *  Every step — with THE SAME GL call realGL makes:
 *   immutable → texStorage2D + texSubImage2D(0,0,0,fmt,type,src)
 *   mutable   → texImage2D(null) + texImage2D(0,ifmt,fmt,type,src) */
function probePath(
  gl: WebGL2RenderingContext,
  m: ProbeMachinery,
  source: unknown,
  internalFormat: number,
  uploadType: number,
  immutable: boolean,
): boolean {
  const tex = gl.createTexture()
  if (tex === null) return false
  gl.bindTexture(GL.TEXTURE_2D, tex)
  gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE)
  gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE)
  if (immutable) {
    gl.texStorage2D(GL.TEXTURE_2D, 1, internalFormat, 8, 8)
  } else {
    gl.texImage2D(GL.TEXTURE_2D, 0, internalFormat, 8, 8, 0, GL.RGBA, uploadType, null)
  }
  const allocErr = gl.getError()
  if (immutable) {
    gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, GL.RGBA, uploadType, source as TexImageSource)
  } else {
    gl.texImage2D(GL.TEXTURE_2D, 0, internalFormat, GL.RGBA, uploadType, source as TexImageSource)
  }
  const uploadErr = gl.getError()
  const ok = allocErr === GL.NO_ERROR && uploadErr === GL.NO_ERROR
    && sampleIsColored(gl, m, tex)
  gl.deleteTexture(tex)
  drainErrors(gl)
  return ok
}

/** Cache of verdicts per context: the probe runs ONCE per context
 *  (createRealGL and makeGLProbe share one result). */
const probeCache = new WeakMap<WebGL2RenderingContext, FloatFormatsProbe>()

/**
 * Functional probe of float formats. Synchronous, safe at the very startup
 * (before the first frame). Any failure of the probe itself → a fail-open verdict
 * (everything "works", calibrated=false) — environments without a real GL
 * (mock tests, headless injections) are not denied float formats.
 */
export function probeFloatFormats(gl: WebGL2RenderingContext): FloatFormatsProbe {
  const cached = probeCache.get(gl)
  if (cached !== undefined) return cached
  const verdict = probeFloatFormatsUncached(gl)
  probeCache.set(gl, verdict)
  return verdict
}

/** The list of GL methods without which the probe is impossible → fail-open. */
const REQUIRED_GL_METHODS = [
  'getError', 'getParameter', 'createTexture', 'deleteTexture', 'bindTexture',
  'texStorage2D', 'texImage2D', 'texSubImage2D', 'texParameteri', 'createShader',
  'shaderSource', 'compileShader', 'getShaderParameter', 'deleteShader', 'createProgram',
  'attachShader', 'linkProgram', 'getProgramParameter', 'deleteProgram',
  'createFramebuffer', 'bindFramebuffer', 'framebufferTexture2D',
  'checkFramebufferStatus', 'deleteFramebuffer', 'createVertexArray', 'bindVertexArray',
  'deleteVertexArray', 'createBuffer', 'bindBuffer', 'bufferData', 'deleteBuffer',
  'getAttribLocation', 'enableVertexAttribArray', 'vertexAttribPointer', 'useProgram',
  'getUniformLocation', 'uniform1i', 'clearColor', 'clear', 'drawArrays', 'readPixels',
  'viewport', 'activeTexture',
] as const

function probeFloatFormatsUncached(gl: WebGL2RenderingContext): FloatFormatsProbe {
  const api = gl as unknown as Record<string, unknown>
  for (const fn of REQUIRED_GL_METHODS) {
    if (typeof api[fn] !== 'function') return floatFormatsAllSupported()
  }
  const lost = (gl as unknown as { isContextLost?: () => boolean }).isContextLost
  if (typeof lost === 'function' && lost.call(gl)) return floatFormatsAllSupported()

  try {
    const source = makeProbeSource()
    if (source === null) return floatFormatsAllSupported()

    // ── Save the context state (the probe runs before the first frame) ──
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array | null
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null
    const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
    const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE) as number
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null

    const restore = (): void => {
      drainErrors(gl)
      gl.bindFramebuffer(GL.FRAMEBUFFER, prevFbo)
      gl.useProgram(prevProgram)
      gl.bindVertexArray(prevVao)
      gl.activeTexture(prevActive)
      gl.bindTexture(GL.TEXTURE_2D, prevTex)
      if (prevViewport !== null && prevViewport.length >= 4) {
        gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!)
      }
      drainErrors(gl)
    }

    // Drain errors BEFORE: someone else's hanging errors must not be attributed to the probe.
    drainErrors(gl)

    // ── Probe machinery: shader + quad ──
    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type)
      if (sh === null) return null
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, GL.COMPILE_STATUS)) { gl.deleteShader(sh); return null }
      return sh
    }
    const vs = compile(GL.VERTEX_SHADER, PROBE_VS)
    const fs = compile(GL.FRAGMENT_SHADER, PROBE_FS)
    if (vs === null || fs === null) { restore(); return floatFormatsAllSupported() }
    const program = gl.createProgram()
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, GL.LINK_STATUS)) {
      gl.deleteProgram(program)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      restore()
      return floatFormatsAllSupported()
    }

    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const vbo = gl.createBuffer()
    gl.bindBuffer(GL.ARRAY_BUFFER, vbo)
    gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), GL.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, GL.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    drainErrors(gl)

    const m: ProbeMachinery = { program, vao, vbo, vs, fs }

    // ── Calibration: RGBA8 via both paths must sample as color ──
    const controlOk = probePath(gl, m, source, GL.RGBA8, GL.UNSIGNED_BYTE, true)
      && probePath(gl, m, source, GL.RGBA8, GL.UNSIGNED_BYTE, false)

    const result: FloatFormatsProbe = controlOk
      ? {
          rgba16f: {
            immutable: probePath(gl, m, source, GL.RGBA16F, GL.HALF_FLOAT, true),
            mutable: probePath(gl, m, source, GL.RGBA16F, GL.HALF_FLOAT, false),
          },
          rgba32f: {
            immutable: probePath(gl, m, source, GL.RGBA32F, GL.FLOAT, true),
            mutable: probePath(gl, m, source, GL.RGBA32F, GL.FLOAT, false),
          },
          calibrated: true,
        }
      : floatFormatsAllSupported()

    // ── Clean up the machinery and restore the state ──
    gl.deleteBuffer(vbo)
    gl.deleteVertexArray(vao)
    gl.deleteProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    restore()
    return result
  } catch {
    // A failure of the probe itself — the environment cannot be trusted, but denying
    // the formats is also wrong: fail-open (the behavior as before Task 81).
    return floatFormatsAllSupported()
  }
}
