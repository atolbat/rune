/**
 * capsProbe for WebGL2 — probing the real capabilities of the gl context.
 *
 * Turns gl.getExtension('...') + gl.getParameter(gl.MAX_*) into a CapsQuery
 * (the structure consumed by createCaps()).
 *
 * Correspondences (FeatureId ↔ WebGL extension):
 *   astc               ↔ WEBGL_compressed_texture_astc
 *   etc2               ↔ WEBGL_compressed_texture_etc
 *   bc1, bc3           ↔ WEBGL_compressed_texture_s3tc (DXT1=BC1, DXT5=BC3)
 *   bc4, bc5           ↔ EXT_texture_compression_rgtc
 *   pvrtc              ↔ WEBGL_compressed_texture_pvrtc
 *   anisotropic        ↔ EXT_texture_filter_anisotropic
 *   float32-texture    ↔ OES_texture_float
 *   float16-texture    ↔ OES_texture_half_float
 *   float32-filterable ↔ OES_texture_float_linear
 *   float16-filterable ↔ OES_texture_half_float_linear
 *   float32-render     ↔ EXT_color_buffer_float
 *   float16-render     ↔ EXT_color_buffer_half_float
 *   float32-blend      ↔ EXT_float_blend (depends on EXT_color_buffer_float)
 *   timestamp-query    ↔ EXT_disjoint_timer_query_webgl2
 *
 * 'instancing' is native in WebGL2 (gl.drawArraysInstanced), not an extension.
 *
 * Limits (mapping getParameter → query.limits):
 *   MAX_TEXTURE_SIZE                  → maxTextureSize2D
 *   MAX_3D_TEXTURE_SIZE               → maxTextureSize3D
 *   MAX_ARRAY_TEXTURE_LAYERS          → maxTextureArrayLayers
 *   MAX_CUBE_MAP_TEXTURE_SIZE         → maxCubeMapSize
 *   MAX_RENDERBUFFER_SIZE             → maxRenderbufferSize
 *   MAX_VERTEX_TEXTURE_IMAGE_UNITS    → maxVertexTextureUnits
 *   MAX_TEXTURE_IMAGE_UNITS           → maxFragmentTextureUnits
 *   MAX_COMBINED_TEXTURE_IMAGE_UNITS  → maxCombinedTextureUnits
 *   MAX_VERTEX_ATTRIBS                → maxVertexAttributes
 *   MAX_VERTEX_UNIFORM_VECTORS        → maxVertexUniformVectors
 *   MAX_FRAGMENT_UNIFORM_VECTORS      → maxFragmentUniformVectors
 *   MAX_VARYING_VECTORS               → maxVaryingVectors
 *   MAX_DRAW_BUFFERS                  → maxDrawBuffers
 *   MAX_VIEWPORT_DIMS (2 floats)      → maxViewportWidth / maxViewportHeight
 *   MAX_ELEMENTS_VERTICES             → maxElementsVertices
 *   MAX_ELEMENTS_INDICES              → maxElementsIndices
 *
 * FormatMatrix (for 6 axes): for typical WebGL2 formats —
 *   'rgba8unorm'       → sampled=render=blend=filter=msaa=native, storage=none
 *   'rgba8unorm-srgb'  → sampled=render=blend=filter=msaa=native, storage=none
 *   'r8unorm'          → sampled=filter=render=msaa=native, blend=none, storage=none
 *   'rgba16float'      → sampled=filter=native (if float16-filterable),
 *                        render=blend=msaa = (float16-render / float16-blend)
 *   'rgba32float'      → sampled=native, filter=(float32-filterable),
 *                        render=blend=msaa = (float32-render / float32-blend)
 *   'depth24plus'      → sampled=render=native, filter=none, blend=none, msaa=native
 *   'bgra8unorm'       → sampled=render=blend=filter=msaa=none (not native in WebGL2)
 *
 * There are no storage textures in WebGL2 (no writeonly imageStore equivalent) — storage=none always.
 */

import type { CapsQuery, FeatureName, FormatAxis, FormatSupport } from '@rune/core'

interface GLProbe {
  /** gl.getExtension(name) — returns the extension object if available. */
  getExtension(name: string): unknown | null
  /** gl.getParameter(pname) — numeric limits. */
  getParameter(pname: number): unknown
  /** gl.VERSION / gl.SHADING_LANGUAGE_VERSION string. */
  getString(pname: number): string
  /** Presence of EXT_disjoint_timer_query_webgl2 — for gpuMs. */
  hasTimerQuery(): boolean
  /** Presence of OES_texture_float_linear — for float filtering. */
  hasFloatLinear(): boolean
  /** Task 67: FUNCTIONAL probe of RGBA32F storage: actually attempts
   *  texStorage2D(RGBA32F) on a scratch texture and reads the error.
   *  The OES_texture_float extension does NOT guarantee that RGBA32F
   *  works on the WebGL2 path — SwiftShader (headless) advertises it but
   *  rejects texStorage2D/texImage2D with RGBA32F (INVALID_ENUM/VALUE),
   *  and the texture silently samples as black. The probe distinguishes "the driver can"
   *  from "the driver promises". Optional — test mocks do not provide it. */
  supportsFloat32Storage?(): boolean
  // WebGL2 constants (for getParameter) — passed as numbers to avoid importing
  readonly MAX_TEXTURE_SIZE: number
  readonly MAX_3D_TEXTURE_SIZE: number
  readonly MAX_ARRAY_TEXTURE_LAYERS: number
  readonly MAX_CUBE_MAP_TEXTURE_SIZE: number
  readonly MAX_RENDERBUFFER_SIZE: number
  readonly MAX_VERTEX_TEXTURE_IMAGE_UNITS: number
  readonly MAX_TEXTURE_IMAGE_UNITS: number
  readonly MAX_COMBINED_TEXTURE_IMAGE_UNITS: number
  readonly MAX_VERTEX_ATTRIBS: number
  readonly MAX_VERTEX_UNIFORM_VECTORS: number
  readonly MAX_FRAGMENT_UNIFORM_VECTORS: number
  readonly MAX_VARYING_VECTORS: number
  readonly MAX_DRAW_BUFFERS: number
  readonly MAX_VIEWPORT_DIMS: number
  readonly MAX_ELEMENTS_VERTICES: number
  readonly MAX_ELEMENTS_INDICES: number
}

/**
 * Minimal GL interface for probing — a real WebGL2RenderingContext
 * satisfies it, plus a mock for tests.
 */
export type { GLProbe }

/**
 * Probes a CapsQuery from the gl context.
 *
 * @param probe — a wrapper over WebGL2RenderingContext (or a mock for tests).
 */
export function probeGLCaps(probe: GLProbe): CapsQuery {
  const features = new Set<FeatureName>()
  const formatMatrix = new Map<string, FormatSupport>()
  const paths = new Map<string, 'supported' | 'unsupported' | 'unknown'>()
  const extensions = new Map<string, unknown>()
  const limits: Record<string, number> = {}

  // ─── Extensions (extensions Map + features Set) ──────────────────────────
  const extList: Array<[FeatureName, string]> = [
    ['astc', 'WEBGL_compressed_texture_astc'],
    ['etc2', 'WEBGL_compressed_texture_etc'],
    ['bc1', 'WEBGL_compressed_texture_s3tc'],
    ['bc3', 'WEBGL_compressed_texture_s3tc'], // S3TC covers BC1+BC3
    ['bc4', 'EXT_texture_compression_rgtc'],
    ['bc5', 'EXT_texture_compression_rgtc'],
    ['pvrtc', 'WEBGL_compressed_texture_pvrtc'],
    ['anisotropic', 'EXT_texture_filter_anisotropic'],
    ['float32-texture', 'OES_texture_float'],
    ['float16-texture', 'OES_texture_half_float'],
    ['float32-filterable', 'OES_texture_float_linear'],
    ['linear-filter-float', 'OES_texture_float_linear'],
    ['float16-filterable', 'OES_texture_half_float_linear'],
    ['linear-filter-half-float', 'OES_texture_half_float_linear'],
    ['float32-render', 'EXT_color_buffer_float'],
    ['float16-render', 'EXT_color_buffer_half_float'],
    ['timestamp-query', 'EXT_disjoint_timer_query_webgl2'],
  ]
  for (const [feature, extName] of extList) {
    const ext = probe.getExtension(extName)
    if (ext) {
      features.add(feature)
      extensions.set(extName, ext)
    }
  }

  // float32-blend requires EXT_float_blend AND EXT_color_buffer_float
  const colorBufferFloat = probe.getExtension('EXT_color_buffer_float')
  const floatBlend = probe.getExtension('EXT_float_blend')
  if (floatBlend && colorBufferFloat) {
    features.add('float32-blend')
    features.add('float16-blend')
    extensions.set('EXT_float_blend', floatBlend)
  }

  // Task 67: functional probe of RGBA32F. Takes priority over the
  // OES_texture_float extension: if actually creating RGBA32F storage fails
  // (SwiftShader/headless), the feature is disabled HONESTLY — the app will see
  // caps.has('float32-texture')===false and pick rgba16f or the LDR path
  // instead of a silently black canvas (Probe→Gate→Degrade, §9.2 P1).
  // The flag is also used in the format matrix below (sampled/filter → none).
  let float32StorageOk = true
  if (probe.supportsFloat32Storage !== undefined && !probe.supportsFloat32Storage()) {
    float32StorageOk = false
    features.delete('float32-texture')
    features.delete('float32-filterable')
    features.delete('linear-filter-float')
  }

  // instancing — native in WebGL2 (gl.drawArraysInstanced)
  features.add('instancing')

  // offscreen-canvas — an environment feature, not GL
  if (typeof OffscreenCanvas !== 'undefined') features.add('offscreen-canvas')

  // video-frame — an environment feature (WebCodecs)
  if (typeof VideoFrame !== 'undefined') features.add('video-frame')

  // ─── Limits ──────────────────────────────────────────────────────────────
  const num = (pname: number, name: string) => {
    const v = probe.getParameter(pname)
    if (typeof v === 'number' && Number.isFinite(v)) limits[name] = v
  }
  num(probe.MAX_TEXTURE_SIZE, 'maxTextureSize2D')
  num(probe.MAX_3D_TEXTURE_SIZE, 'maxTextureSize3D')
  num(probe.MAX_ARRAY_TEXTURE_LAYERS, 'maxTextureArrayLayers')
  num(probe.MAX_CUBE_MAP_TEXTURE_SIZE, 'maxCubeMapSize')
  num(probe.MAX_RENDERBUFFER_SIZE, 'maxRenderbufferSize')
  num(probe.MAX_VERTEX_TEXTURE_IMAGE_UNITS, 'maxVertexTextureUnits')
  num(probe.MAX_TEXTURE_IMAGE_UNITS, 'maxFragmentTextureUnits')
  num(probe.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 'maxCombinedTextureUnits')
  num(probe.MAX_VERTEX_ATTRIBS, 'maxVertexAttributes')
  num(probe.MAX_VERTEX_UNIFORM_VECTORS, 'maxVertexUniformVectors')
  num(probe.MAX_FRAGMENT_UNIFORM_VECTORS, 'maxFragmentUniformVectors')
  num(probe.MAX_VARYING_VECTORS, 'maxVaryingVectors')
  num(probe.MAX_DRAW_BUFFERS, 'maxDrawBuffers')
  num(probe.MAX_ELEMENTS_VERTICES, 'maxElementsVertices')
  num(probe.MAX_ELEMENTS_INDICES, 'maxElementsIndices')

  // Viewport dims — 2 floats (Int32Array[2] in WebGL2)
  const vp = probe.getParameter(probe.MAX_VIEWPORT_DIMS)
  if (vp && typeof vp === 'object' && 'length' in vp && (vp as ArrayLike<number>).length >= 2) {
    const arr = vp as ArrayLike<number>
    limits['maxViewportWidth'] = arr[0]!
    limits['maxViewportHeight'] = arr[1]!
  }

  // ─── FormatMatrix — typical formats (MVP for caps.format) ──────────────────
  // The full matrix is dozens of lines; for M4 we add the MVP:
  //   rgba8unorm, rgba8unorm-srgb, r8unorm, rg8unorm, rgba16float, rgba32float,
  //   depth24plus, depth24plus-stencil8, bgra8unorm, r16float, r32float
  const hasFloat16Render = features.has('float16-render')
  const hasFloat32Render = features.has('float32-render')
  const hasFloat16Blend = features.has('float16-blend')
  const hasFloat32Blend = features.has('float32-blend')
  const hasFloat16Filter = features.has('float16-filterable')
  const hasFloat32Filter = features.has('float32-filterable')

  const setFmt = (format: string, axis: FormatAxis, support: FormatSupport) => {
    formatMatrix.set(`${format}|${axis}`, support)
  }

  // rgba8unorm — basic, always native on all 5 axes (storage — none, no imageStore in WebGL2)
  for (const axis of ['sampled', 'render', 'blend', 'filter', 'msaa'] as const) {
    setFmt('rgba8unorm', axis, 'native')
  }
  setFmt('rgba8unorm', 'storage', 'none')

  // rgba8unorm-srgb — same
  for (const axis of ['sampled', 'render', 'blend', 'filter', 'msaa'] as const) {
    setFmt('rgba8unorm-srgb', axis, 'native')
  }
  setFmt('rgba8unorm-srgb', 'storage', 'none')

  // r8unorm, rg8unorm — no blend (no color buffer in red-only)
  for (const axis of ['sampled', 'filter', 'render', 'msaa'] as const) {
    setFmt('r8unorm', axis, 'native')
    setFmt('rg8unorm', axis, 'native')
  }
  setFmt('r8unorm', 'blend', 'none')
  setFmt('r8unorm', 'storage', 'none')
  setFmt('rg8unorm', 'blend', 'none')
  setFmt('rg8unorm', 'storage', 'none')

  // rgba16float
  setFmt('rgba16float', 'sampled', 'native')
  setFmt('rgba16float', 'filter', hasFloat16Filter ? 'native' : 'none')
  setFmt('rgba16float', 'render', hasFloat16Render ? 'native' : 'none')
  setFmt('rgba16float', 'blend', hasFloat16Blend ? 'native' : 'none')
  setFmt('rgba16float', 'msaa', hasFloat16Render ? 'native' : 'none')
  setFmt('rgba16float', 'storage', 'none')

  // rgba32float
  // Task 67: without working RGBA32F storage (functional probe) —
  // the format does not sample at all: all axes 'none'.
  setFmt('rgba32float', 'sampled', float32StorageOk ? 'native' : 'none')
  setFmt('rgba32float', 'filter', float32StorageOk && hasFloat32Filter ? 'native' : 'none')
  setFmt('rgba32float', 'render', float32StorageOk && hasFloat32Render ? 'native' : 'none')
  setFmt('rgba32float', 'blend', float32StorageOk && hasFloat32Blend ? 'native' : 'none')
  setFmt('rgba32float', 'msaa', float32StorageOk && hasFloat32Render ? 'native' : 'none')
  setFmt('rgba32float', 'storage', 'none')

  // r16float, r32float — similar to the float formats
  setFmt('r16float', 'sampled', 'native')
  setFmt('r16float', 'filter', hasFloat16Filter ? 'native' : 'none')
  setFmt('r16float', 'render', hasFloat16Render ? 'native' : 'none')
  setFmt('r16float', 'blend', 'none')
  setFmt('r16float', 'msaa', 'none')
  setFmt('r16float', 'storage', 'none')
  setFmt('r32float', 'sampled', 'native')
  setFmt('r32float', 'filter', hasFloat32Filter ? 'native' : 'none')
  setFmt('r32float', 'render', hasFloat32Render ? 'native' : 'none')
  setFmt('r32float', 'blend', 'none')
  setFmt('r32float', 'msaa', 'none')
  setFmt('r32float', 'storage', 'none')

  // depth24plus — render/sampled, no blend, no storage, msaa=render-only
  setFmt('depth24plus', 'sampled', 'native')
  setFmt('depth24plus', 'render', 'native')
  setFmt('depth24plus', 'filter', 'none')
  setFmt('depth24plus', 'blend', 'none')
  setFmt('depth24plus', 'msaa', 'native')
  setFmt('depth24plus', 'storage', 'none')

  // depth24plus-stencil8 — same
  setFmt('depth24plus-stencil8', 'sampled', 'native')
  setFmt('depth24plus-stencil8', 'render', 'native')
  setFmt('depth24plus-stencil8', 'filter', 'none')
  setFmt('depth24plus-stencil8', 'blend', 'none')
  setFmt('depth24plus-stencil8', 'msaa', 'native')
  setFmt('depth24plus-stencil8', 'storage', 'none')

  // bgra8unorm — not native in WebGL2 (BGRA only via EXT_texture_format_BGRA8888)
  const bgra = probe.getExtension('EXT_texture_format_BGRA8888')
  if (bgra) {
    for (const axis of ['sampled', 'render', 'blend', 'filter', 'msaa'] as const) {
      setFmt('bgra8unorm', axis, 'native')
    }
  } else {
    for (const axis of ['sampled', 'render', 'blend', 'filter', 'msaa'] as const) {
      setFmt('bgra8unorm', axis, 'none')
    }
  }
  setFmt('bgra8unorm', 'storage', 'none')

  // ─── Present-paths (simplified for M4) ────────────────────────────────────
  // The full PathRegistry is M8 (#61, #62). In M4 we mark the baseline:
  //   'canvas-direct' — always supported (canvas2D draws straight to the backbuffer)
  //   'preserve'     — preserveDrawingBuffer available (always in WebGL2, but degradation)
  //   'blit'         — requires BlitFramebuffer (native in WebGL2)
  paths.set('canvas-direct', 'supported')
  paths.set('preserve', 'supported')
  paths.set('blit', 'supported')
  paths.set('asyncbmp', features.has('offscreen-canvas') ? 'supported' : 'unsupported')

  return {
    features,
    formatMatrix,
    paths,
    extensions,
    limits,
    backend: 'webgl2',
  }
}

/**
 * Creates a GLProbe wrapper over a real WebGL2RenderingContext.
 * Caches the needed pname constants at creation time (built-in classes are stable).
 */
export function makeGLProbe(gl: WebGL2RenderingContext): GLProbe {
  // Local constants — copies of gl.* to isolate from the prototype.
  const MAX_TEXTURE_SIZE = gl.MAX_TEXTURE_SIZE
  const MAX_3D_TEXTURE_SIZE = gl.MAX_3D_TEXTURE_SIZE
  const MAX_ARRAY_TEXTURE_LAYERS = gl.MAX_ARRAY_TEXTURE_LAYERS
  const MAX_CUBE_MAP_TEXTURE_SIZE = gl.MAX_CUBE_MAP_TEXTURE_SIZE
  const MAX_RENDERBUFFER_SIZE = gl.MAX_RENDERBUFFER_SIZE
  const MAX_VERTEX_TEXTURE_IMAGE_UNITS = gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS
  const MAX_TEXTURE_IMAGE_UNITS = gl.MAX_TEXTURE_IMAGE_UNITS
  const MAX_COMBINED_TEXTURE_IMAGE_UNITS = gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS
  const MAX_VERTEX_ATTRIBS = gl.MAX_VERTEX_ATTRIBS
  const MAX_VERTEX_UNIFORM_VECTORS = gl.MAX_VERTEX_UNIFORM_VECTORS
  const MAX_FRAGMENT_UNIFORM_VECTORS = gl.MAX_FRAGMENT_UNIFORM_VECTORS
  const MAX_VARYING_VECTORS = gl.MAX_VARYING_VECTORS
  const MAX_DRAW_BUFFERS = gl.MAX_DRAW_BUFFERS
  const MAX_VIEWPORT_DIMS = gl.MAX_VIEWPORT_DIMS
  const MAX_ELEMENTS_VERTICES = gl.MAX_ELEMENTS_VERTICES
  const MAX_ELEMENTS_INDICES = gl.MAX_ELEMENTS_INDICES

  return {
    getExtension: (name) => {
      try {
        return gl.getExtension(name)
      } catch {
        return null
      }
    },
    getParameter: (pname) => {
      try {
        return gl.getParameter(pname)
      } catch {
        return 0
      }
    },
    getString: (pname) => {
      try {
        return gl.getParameter(pname) as string
      } catch {
        return ''
      }
    },
    hasTimerQuery: () => gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
    hasFloatLinear: () => gl.getExtension('OES_texture_float_linear') !== null,
    // Task 67: an actual texStorage2D(RGBA32F, 4×4) attempt on a scratch texture.
    // Errors are consumed via getError (draining the whole queue), the texture is deleted —
    // the context stays clean.
    supportsFloat32Storage: () => {
      try {
        const tex = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 4, 4)
        let ok = true
        for (;;) {
          const err = gl.getError()
          if (err === gl.NO_ERROR) break
          ok = false
        }
        gl.deleteTexture(tex)
        gl.getError() // flush the error flag after deleteTexture
        return ok
      } catch {
        return false
      }
    },
    MAX_TEXTURE_SIZE,
    MAX_3D_TEXTURE_SIZE,
    MAX_ARRAY_TEXTURE_LAYERS,
    MAX_CUBE_MAP_TEXTURE_SIZE,
    MAX_RENDERBUFFER_SIZE,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS,
    MAX_TEXTURE_IMAGE_UNITS,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS,
    MAX_VERTEX_ATTRIBS,
    MAX_VERTEX_UNIFORM_VECTORS,
    MAX_FRAGMENT_UNIFORM_VECTORS,
    MAX_VARYING_VECTORS,
    MAX_DRAW_BUFFERS,
    MAX_VIEWPORT_DIMS,
    MAX_ELEMENTS_VERTICES,
    MAX_ELEMENTS_INDICES,
  }
}
