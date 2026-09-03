// The real WebGL2 facade: shader compilation, uniforms by name,
// attribute buffers, textures. One hidden class, lazy caches.

import type { GLFacade, GLImageSource, GLTextureFormat } from './facade.ts'

interface ProgramRecord {
  readonly program: WebGLProgram
  readonly uniforms: Map<string, WebGLUniformLocation | null>
}

/** The (format, type) pair for uploading pixels into a texture of a given
 *  storage format (WebGL2 spec Table 3.2: the combination must be compatible with
 *  the sized internal format, otherwise GL_INVALID_OPERATION — silently).
 *  RGBA16F accepts (RGBA, HALF_FLOAT) and (RGBA, FLOAT); RGBA32F — (RGBA, FLOAT). */
interface FormatInfo {
  readonly internalFormat: number
  readonly uploadFormat: number
  readonly uploadType: number
}

/** Spec-fixed GLenums (context-independent, available in mock-GL).
 *  RGBA8=0x8058, RGBA16F=0x881A, RGBA32F=0x8816, RGBA=0x1908,
 *  UNSIGNED_BYTE=0x1401, HALF_FLOAT=0x140B, FLOAT=0x1406,
 *  NEAREST=0x2600, LINEAR=0x2601, NEAREST_MIPMAP_NEAREST=0x2700,
 *  LINEAR_MIPMAP_LINEAR=0x2703. */
const ENUM = {
  RGBA8: 0x8058,
  RGBA16F: 0x881a,
  RGBA32F: 0x8816,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  HALF_FLOAT: 0x140b,
  FLOAT: 0x1406,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700,
  LINEAR_MIPMAP_LINEAR: 0x2703,
} as const

/** internalFormat + the upload (format, type) by GLTextureFormat (Task 67). */
function formatInfo(format: GLTextureFormat): FormatInfo {
  switch (format) {
    case 'rgba16f':
      return { internalFormat: ENUM.RGBA16F, uploadFormat: ENUM.RGBA, uploadType: ENUM.HALF_FLOAT }
    case 'rgba32f':
      return { internalFormat: ENUM.RGBA32F, uploadFormat: ENUM.RGBA, uploadType: ENUM.FLOAT }
    default:
      return { internalFormat: ENUM.RGBA8, uploadFormat: ENUM.RGBA, uploadType: ENUM.UNSIGNED_BYTE }
  }
}

interface TargetRecord {
  readonly fbo: WebGLFramebuffer
  readonly textureId: number
  readonly width: number
  readonly height: number
  readonly depth: boolean
  readonly depthRenderbuffer: WebGLRenderbuffer | null
  readonly color: readonly number[]
}

export function createRealGL(gl: WebGL2RenderingContext): GLFacade {
  const programs = new Map<number, ProgramRecord>()
  const buffers = new Map<number, WebGLBuffer>()
  const textures = new Map<number, WebGLTexture>()
  const targets = new Map<number, TargetRecord>()
  // Per-texture metadata: keyed by textureId. Contains:
  //   mipLevels: the number of levels in the chain (1 = no chain, N = texStorage2D with levels=N)
  //   maxLoadedLevel: the index of the highest uploaded level (for progressive
  //   streaming — we raise TEXTURE_MAX_LEVEL to this value so that
  //   LINEAR_MIPMAP_LINEAR does not try to sample unloaded mips → a black frame)
  //   maxAnisotropy: the value set via TEXTURE_MAX_ANISOTROPY_EXT
  //   (for the EXT_texture_filter_anisotropic extension).
  //   format: the storage format (Task 67 HDR) — the upload (format, type) pair
  //   is derived from it unless the caller passes explicit GLenums.
  const textureMeta = new Map<number, {
    mipLevels: number
    maxLoadedLevel: number
    maxAnisotropy: number
    format: GLTextureFormat
  }>()
  // Sub-mip views (Task 56): keyed by viewId (≥1M, a disjoint namespace with textureId).
  // The value is only mip-range metadata (baseMipLevel + maxMipLevel).
  // WebGL2 has no real GPUTextureView; we emulate it via TEXTURE_BASE_LEVEL
  // and TEXTURE_MAX_LEVEL on bindTexture. If a texture is deleted via
  // deleteTexture — all of its sub-views are torn down too (see the deleteTexture cleanup).
  const textureViews = new Map<number, {
    textureId: number
    baseMipLevel: number
    maxMipLevel: number
  }>()
  let nextTextureViewId = 1_000_000
  // EXT_texture_filter_anisotropic — probed at context creation. Kept
  // in a closure, used in createTexture for maxAnisotropy on textures with a
  // mip-chain (LINEAR_MIPMAP_LINEAR). Without the extension caps.has('anisotropic')=false,
  // the sampler stays without anisotropy.
  //
  // In mock-GL environments (headless tests without a GPU) gl.getExtension may be
  // undefined — wrapped in try/catch, in that case anisoExt=null, the extension
  // is unavailable, maxAnisotropy is not applied to textures.
  let anisoExt: {
    TEXTURE_MAX_ANISOTROPY_EXT: number
    MAX_TEXTURE_MAX_ANISOTROPY_EXT: number
  } | null = null
  try {
    anisoExt = (gl as unknown as {
      getExtension?: (name: string) => unknown
    }).getExtension?.('EXT_texture_filter_anisotropic') as {
      TEXTURE_MAX_ANISOTROPY_EXT: number
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: number
    } | null ?? null
  } catch {
    anisoExt = null
  }
  // The maximum anisotropy value supported by the driver. Used as the
  // default for textures with a mip-chain (if maxAnisotropy is not passed in options).
  // 1 = disabled (plain bilinear). 16 = the maximum for desktop GPUs.
  let anisoMax = 1
  if (anisoExt !== null) {
    try {
      anisoMax = (gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) || 1
    } catch {
      anisoMax = 1
    }
  }
  let nextProgram = 1
  let nextBuffer = 1
  let nextTexture = 1
  let nextTarget = 1
  let currentProgram: WebGLProgram | null = null
  /** Numeric twin of currentProgram (fast-path compare in useProgram). */
  let currentProgramId = -1
  let currentTarget = 0
  let canvasWidth = 1
  let canvasHeight = 1
  const unitTextures = new Map<number, number>() // unit → textureId (feedback-loop prevention)

  // Task 67: OES_texture_float_linear — linear filtering of RGBA32F.
  // RGBA32F storage/NEAREST sampling is core WebGL2; LINEAR is an extension
  // (desktops usually yes, mobile often no). Without it a LINEAR filter makes the
  // texture incomplete → the sampler returns black. Hence rgba32f without the
  // extension degrades to NEAREST (an honest pixel, not a black frame).
  // RGBA16F is linearly filtered by core — the extension is not needed.
  let floatLinearExt = false
  try {
    floatLinearExt = (gl as unknown as {
      getExtension?: (name: string) => unknown
    }).getExtension?.('OES_texture_float_linear') != null
  } catch {
    floatLinearExt = false
  }
  /** The MAG filter by format: LINEAR if the format is linearly filterable. */
  function magFilter(format: GLTextureFormat): number {
    return format === 'rgba32f' && !floatLinearExt ? ENUM.NEAREST : ENUM.LINEAR
  }
  /** The MIN filter by format and presence of a mip chain. */
  function minFilter(format: GLTextureFormat, mipLevels: number): number {
    const linear = !(format === 'rgba32f' && !floatLinearExt)
    if (mipLevels > 1) return linear ? ENUM.LINEAR_MIPMAP_LINEAR : ENUM.NEAREST_MIPMAP_NEAREST
    return linear ? ENUM.LINEAR : ENUM.NEAREST
  }
  /** The upload (format, type) pair from the storage format (or explicit GLenums). */
  function uploadPair(textureId: number, explicit?: { format?: number; type?: number }): { format: number; type: number } {
    const meta = textureMeta.get(textureId)
    const fi = meta !== undefined ? formatInfo(meta.format) : formatInfo('rgba8')
    return {
      format: explicit?.format ?? fi.uploadFormat,
      type: explicit?.type ?? fi.uploadType,
    }
  }

  function createProgram(vertex: string, fragment: string): number {
    const program = gl.createProgram()
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`rune: program linking: ${gl.getProgramInfoLog(program)}`)
    }
    const id = nextProgram++
    programs.set(id, { program, uniforms: new Map() })
    return id
  }

  function compile(type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)
    if (shader === null) throw new Error('rune: createShader returned null')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error(`rune: shader compilation: ${log}`)
    }
    return shader
  }

  function useProgram(programId: number): void {
    // Numeric early-out: the common case (the same program as the previous
    // uniform call) must not hash the programs Map per uniform.
    if (programId === currentProgramId) return
    const record = programs.get(programId)
    if (record === undefined || record.program === currentProgram) return
    currentProgram = record.program
    currentProgramId = programId
    gl.useProgram(record.program)
  }

  function location(programId: number, name: string): WebGLUniformLocation | null {
    const record = programs.get(programId)
    if (record === undefined) return null
    // Single Map probe: undefined — not queried yet, null — a cached
    // "optimized out" (both are valid cacheable states).
    const cached = record.uniforms.get(name)
    if (cached !== undefined) return cached
    let loc = gl.getUniformLocation(record.program, name)
    // Array uniforms: some drivers only accept the first element's name
    // ("u_bones[0]"); the GLES3 spec allows both — try the fallback once.
    if (loc === null && !name.includes('[')) {
      loc = gl.getUniformLocation(record.program, `${name}[0]`)
    }
    record.uniforms.set(name, loc)
    return loc
  }

  function createBuffer(data: Float32Array): number {
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    const id = nextBuffer++
    buffers.set(id, buffer)
    return id
  }

  function bindVertexBuffer(bufferId: number, location: number, size: number, stride?: number, byteOffset?: number, divisor?: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.get(bufferId) ?? null)
    gl.enableVertexAttribArray(location)
    // M5: feed interleaving — the record's stride/offset (default: tight 0/0).
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride ?? 0, byteOffset ?? 0)
    // Task 75: the instance step (star quads: one feed record = one instance).
    // Called UNCONDITIONALLY (and with 0) — resets the divisor after instanced
    // commands, otherwise the attribute would "stick" with divisor=1 for regular geometry.
    gl.vertexAttribDivisor(location, divisor ?? 0)
  }

  /** M5 (Task 73): dynamic update (feed dual-bind) — bufferSubData.
   *  The storage is already allocated by createBuffer (bufferData); here — only
   *  the content: the feed renderer pours the dirty range in a single call. */
  function updateBuffer(bufferId: number, data: Float32Array, byteOffset = 0): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.get(bufferId) ?? null)
    gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, data)
  }

  function setUniformMatrix4(programId: number, name: string, values: Float32Array): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniformMatrix4fv(loc, false, values)
  }

  function setUniform4fv(programId: number, name: string, values: Float32Array): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniform4fv(loc, values)
  }

  function setUniform3fv(programId: number, name: string, values: Float32Array): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniform3fv(loc, values)
  }

  function setUniform2fv(programId: number, name: string, values: Float32Array): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniform2fv(loc, values)
  }

  function setUniform1f(programId: number, name: string, value: number): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniform1f(loc, value)
  }

  function setUniform1i(programId: number, name: string, value: number): void {
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniform1i(loc, value)
  }

  function createTexture(
    width: number,
    height: number,
    options?: { mipLevels?: number; maxAnisotropy?: number; format?: GLTextureFormat },
  ): number {
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    const mipLevels = options?.mipLevels ?? 1
    // Task 67 HDR: the storage format — the allocation internalFormat and
    // the (format, type) of all subsequent uploads come from it (see formatInfo).
    const format = options?.format ?? 'rgba8'
    const fi = formatInfo(format)
    if (mipLevels > 1) {
      // Immutable storage: texStorage2D(target, levels, internalFormat, w, h).
      // Creates the mip chain in one call, fixing the size at all levels.
      // After texStorage2D you cannot call texImage2D with null for creation —
      // only the texImage2D overload with source to write pixels.
      // MIN_FILTER = LINEAR_MIPMAP_LINEAR: minification picks a mip by distance,
      // giving the classic mip-map sampling.
      //
      // Progressive streaming: TEXTURE_MAX_LEVEL=0 right after creation, so the
      // sampler uses only level 0 (while empty — WebGL2 returns 0 or
      // garbage, but does NOT crash). texImage2DLevel raises MAX_LEVEL as levels load.
      // The alternative (gl.generateMipmap) requires level 0 to be already uploaded.
      gl.texStorage2D(gl.TEXTURE_2D, mipLevels, fi.internalFormat, width, height)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter(format, mipLevels))
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter(format))
      // MAX_LEVEL=0: the sampler sees only level 0 (until streaming fills in
      // the rest). By default WebGL2 sets 1000 — then sampling of null
      // levels yields a black frame. With MAX_LEVEL=0 we use only what is loaded.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0)
    } else {
      // Mutable storage: texImage2D with null (as before). Minification without a
      // mip chain → LINEAR (GLFW picks the texel bilinearly at level=0).
      // internalFormat/type — from the storage format (Task 67): for RGBA16F
      // an allocation with UNSIGNED_BYTE is invalid — the pair from formatInfo.
      gl.texImage2D(gl.TEXTURE_2D, 0, fi.internalFormat, width, height, 0, fi.uploadFormat, fi.uploadType, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter(format, mipLevels))
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter(format))
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // Anisotropic filtering — only for textures with a mip chain (mipLevels>1).
    // On non-mip textures anisotropy is useless (MIN_FILTER=LINEAR, no
    // cross-mip interpolation). caps.has('anisotropic')=true iff the extension
    // is available. By default — the driver's maximum value (anisoMax,
    // usually 16 on desktop, 2-4 on mobile).
    //
    // maxAnisotropy: 1 = disabled (bilinear/trilinear), 2..maxAnisotropy = enabled.
    // The default in this renderer — anisoMax (if the extension exists), or 1
    // if there is no extension. The user can explicitly pass maxAnisotropy: 4
    // for soft anisotropy (2x SSAA-equivalent), or maxAnisotropy: 1 to
    // disable it on a specific texture.
    let appliedAniso = 1
    if (mipLevels > 1 && anisoExt !== null) {
      const requested = options?.maxAnisotropy ?? anisoMax
      // WebGPU/spec: maxAnisotropy must be a power of two (1, 2, 4, 8, 16).
      // WebGL2 does not require a power of two, but we restrict it for parity.
      // Clamped to [1, anisoMax].
      const clamped = Math.max(1, Math.min(requested, anisoMax))
      gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, clamped)
      appliedAniso = clamped
    }
    const id = nextTexture++
    textures.set(id, texture)
    textureMeta.set(id, { mipLevels, maxLoadedLevel: 0, maxAnisotropy: appliedAniso, format })
    return id
  }

  function texSubImage2D(textureId: number, x: number, y: number, width: number, height: number, bytes: Uint8Array): void {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null)
    // Task 75b (driver-proofing): the raw-byte upload contract is EXACT bytes
    // — no browser conversion. UNPACK_* are per-context global state: if
    // anything on this context left PREMULTIPLY_ALPHA_WEBGL=true (any
    // ImageBitmap/canvas upload path that flipped it, another library, an
    // extension), the driver would silently multiply our rgb by alpha at
    // upload — the straight-alpha sprite arrives premultiplied and every
    // blend built for straight alpha reads wrong. FLIP_Y and ALIGNMENT are
    // pinned for the same reason (an uploaded-flipped or row-skewed sprite
    // is equally invisible in the call log). Set → upload → done: the
    // source-upload paths (texImage2DFromSource) manage their own flipY.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    // The raw-byte path — the UploadScheduler's domain: Uint8Array implies
    // 8-bit pixels. For HDR textures (rgba16f/rgba32f) the bytes will be
    // interpreted per the texture format's (format, type) — the caller must
    // prepare the data (scheduler streaming in float is a separate task).
    const pair = uploadPair(textureId)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, pair.format, pair.type, bytes)
  }

  function texImage2DFromSource(textureId: number, source: GLImageSource, options?: { flipY?: boolean }): void {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null)
    // Permalink overload: texImage2D(target, level, internalformat, format, type, source)
    // — source overwrites the texture contents (mip 0). The size is taken from the source.
    // For an RGBA8 texture this is the internal format; the source path converts the pixels itself.
    //
    // flipY (default false): UNPACK_FLIP_Y_WEBGL before the call, reset after.
    // Parity with WebGPU: copyExternalImageToTexture takes flipY in
    // GPUCopyExternalImageSourceInfo — if passed true, WebGPU also
    // flips the source along Y. With flipY=false both backends write
    // source row 0 into texture row 0 — the mapping is identical.
    // The state does not leak: we always set it back to false after the call.
    //
    // ALPHA CONTRACT (Task 116): UNPACK_PREMULTIPLY_ALPHA_WEBGL stays false
    // (the default) — NO conversion happens here; the texels are the source
    // bytes as-is. WebGPU's copyExternalImageToTexture, in contrast,
    // un-premultiplies canvas sources (the tagged destination defaults to
    // premultipliedAlpha:false). For cross-backend parity the SOURCE must
    // therefore already carry straight alpha — for canvas-derived bitmaps:
    // createImageBitmap(canvas, { premultiplyAlpha: 'none' }).
    //
    // IMMUTABLE textures (Task 64 fix): if the storage was allocated via
    // texStorage2D (mip-chain, mipLevels>1), ANY texImage2D — including
    // the overload with source and level=0 — generates GL_INVALID_OPERATION and
    // is SILENTLY ignored (GLES3: immutable texture image → TexImage*
    // is invalid; confirmed by a Chromium probe: err=1282 on texImage2D,
    // err=0 on texSubImage2D). The only legal write path is
    // texSubImage2D(level, 0, 0, format, type, source). BEFORE the fix uploadImage
    // silently lost pixels on mip-chain textures: sub-mip view /
    // create view scenes rendered empty (a transparent quad), and recovery
    // after loss looked "broken" — with a healthy journal.
    const flipY = options?.flipY ?? false
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    const meta = textureMeta.get(textureId)
    // Task 67 HDR: (format, type) — from the texture's storage format. For
    // RGBA16F/RGBA32F the pair (RGBA, UNSIGNED_BYTE) is invalid — texSubImage2D
    // silently returns GL_INVALID_OPERATION and the pixels are lost.
    const pair = uploadPair(textureId)
    if (meta !== undefined && meta.mipLevels > 1) {
      // immutable (texStorage2D): write via texSubImage2D level=0
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pair.format, pair.type, source as TexImageSource)
    } else {
      const internalFormat = meta !== undefined ? formatInfo(meta.format).internalFormat : ENUM.RGBA8
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, pair.format, pair.type, source as TexImageSource)
    }
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  }

  function texSubImage2DFromSource(textureId: number, x: number, y: number, source: GLImageSource, options?: { flipY?: boolean }): void {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null)
    // The texSubImage2D overload with TexImageSource: updates only the region
    // [x, y, x+source.width, y+source.height]. Does not touch the rest of the texture.
    // The region size is taken from source (width/height on ImageBitmap/Canvas).
    //
    // flipY (default false) — parity with WebGPU copyExternalImageToTexture:
    // both backends take flipY in options and when true flip the source
    // along Y before copying. When false — they write source row 0 into texture row 0.
    // The quad in prims/quad.ts uses UV (0,0) on the top-left vertex —
    // with flipY=false the image displays vertically honestly on both backends.
    const flipY = options?.flipY ?? false
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    // Task 67 HDR: (format, type) — from the storage format (parity with
    // texImage2DFromSource: HALF_FLOAT/FLOAT for float textures).
    const pair = uploadPair(textureId)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, pair.format, pair.type, source as TexImageSource)
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  }

  function texImage2DLevel(
    textureId: number,
    level: number,
    source: GLImageSource,
    options?: {
      flipY?: boolean
      internalFormat?: number
      format?: number
      type?: number
    },
  ): void {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null)
    // Permalink overload: texImage2D(target, level, internalFormat, format, type, source).
    // Uploads a specific mip level (level=0 — base, 1 — 1/2 size, etc.).
    // The source size must be N/(2^level). WebGL2 checks it itself — if the source
    // does not match the expected mip size, there will be GL_INVALID_VALUE.
    //
    // For a mipmap texture (created via texStorage2D with levels>1 in createTexture)
    // progressive streaming works: after uploading level=L we raise
    // TEXTURE_MAX_LEVEL to L (if it was lower). This way LINEAR_MIPMAP_LINEAR sees
    // only the uploaded levels — the unloaded ones stay null, but the sampler does not
    // try to sample them → no black frame under partial loading.
    //
    // For a non-mip texture (mipLevels=1): MAX_LEVEL is ignored (MIN_FILTER=LINEAR
    // does not use mips), level>0 gives no visible effect without recreating
    // the texture with texStorage2D levels.
    //
    // flipY (default false) — WebGPU parity (see texImage2DFromSource).
    //
    // Strict format/type (Task 55): internalFormat/format/type — optional
    // GLenum numbers. Task 67: WITHOUT explicit values — auto-derivation from the
    // texture's STORAGE format (createTexture(...,{format})): rgba16f →
    // RGBA16F/RGBA/HALF_FLOAT, rgba32f → RGBA32F/RGBA/FLOAT, otherwise —
    // RGBA8/RGBA/UNSIGNED_BYTE (baseline). HDR format support: RGBA16F
    // (0x881A) with RGBA/HALF_FLOAT (0x140B); RGBA32F (0x8816) with RGBA/FLOAT.
    // Rendering TO a float target requires EXT_color_buffer_float; storing float
    // textures is core WebGL2 (see capsProbe: the float16/float32 features).
    const flipY = options?.flipY ?? false
    const meta = textureMeta.get(textureId)
    const fi = meta !== undefined ? formatInfo(meta.format) : formatInfo('rgba8')
    const internalFormat = options?.internalFormat ?? fi.internalFormat
    const pair = uploadPair(textureId, options)
    const format = pair.format
    const type = pair.type
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    // IMMUTABLE textures (Task 64 fix): texImage2D at any level of a
    // texStorage2D storage generates GL_INVALID_OPERATION and is SILENTLY ignored
    // (Chromium/SwiftShader probe: texImage2D(level=4) → err=1282, pixels
    // NOT written; texSubImage2D(level=4,0,0) → err=0, pixels correct).
    // For mip-chain textures (meta.mipLevels>1) we write via texSubImage2D —
    // the DOM-source overload derives width/height from the source itself.
    // The mutable path (mipLevels=1, texImage2D-null allocation) is untouched:
    // texImage2D with level>0 is legal there and allocates the level.
    if (meta !== undefined && meta.mipLevels > 1) {
      gl.texSubImage2D(gl.TEXTURE_2D, level, 0, 0, format, type, source as TexImageSource)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, level, internalFormat, format, type, source as TexImageSource)
    }
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    // Progressive mip streaming: raise TEXTURE_MAX_LEVEL to the current level
    // so LINEAR_MIPMAP_LINEAR uses only the uploaded mips. Without this
    // WebGL2 defaults to MAX_LEVEL=1000 → the sampler samples null levels → black.
    if (meta !== undefined && meta.mipLevels > 1 && level > meta.maxLoadedLevel) {
      meta.maxLoadedLevel = level
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level)
    }
  }

  function bindTexture(textureOrViewId: number, unit: number): void {
    // Disjoint id namespace (Task 56): id < 1M = textureId (default view),
    // id ≥ 1M = viewId (a sub-mip view created via createTextureView).
    // If it is a viewId — find the subView, take its textureId, set
    // TEXTURE_BASE_LEVEL / TEXTURE_MAX_LEVEL for the view's range. If it is a
    // textureId — reset base=0, max=meta.maxLoadedLevel (progressive
    // streaming). BASE_LEVEL/MAX_LEVEL state does not leak between
    // bindTexture calls: every call rewrites both parameters anew
    // on the texture it binds.
    gl.activeTexture(gl.TEXTURE0 + unit)
    const subView = textureViews.get(textureOrViewId)
    let underlyingTextureId: number
    let baseLevel: number
    let maxLevel: number
    if (subView !== undefined) {
      underlyingTextureId = subView.textureId
      baseLevel = subView.baseMipLevel
      maxLevel = subView.maxMipLevel
    } else {
      underlyingTextureId = textureOrViewId
      const meta = textureMeta.get(underlyingTextureId)
      baseLevel = 0
      // For a mip-chain texture: maxLevel = maxLoadedLevel (streaming state).
      // For a non-mip texture: maxLevel = 0 (only level 0, MAX_LEVEL
      // is ignored by MIN_FILTER=LINEAR without mipmap, but we set 0 for cleanliness).
      maxLevel = meta !== undefined ? meta.maxLoadedLevel : 0
    }
    gl.bindTexture(gl.TEXTURE_2D, textures.get(underlyingTextureId) ?? null)
    // The sampler's base/maximum mip level. WebGL2 spec: TEXTURE_BASE_LEVEL
    // and TEXTURE_MAX_LEVEL are per-texture-object state, NOT per-bind. That is why
    // we always reset them on bindTexture, so a previous bind (with
    // a different view on the same texture) does not leak BASE_LEVEL/MAX_LEVEL.
    // This matters especially for bindTexture(viewId, unit=0) right after
    // bindTexture(textureId, unit=1) — without this rewrite unit=0
    // would inherit the view's range, which it must not.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, baseLevel)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, maxLevel)
    // unitTextures stores the underlying textureId (NOT the viewId) — needed for
    // feedback-loop prevention in bindTarget: target and sampler on the same
    // texture = GL undefined behavior, ANGLE/SwiftShader kill the draw.
    unitTextures.set(unit, underlyingTextureId)
  }

  function createTextureView(
    textureId: number,
    options?: {
      baseMipLevel?: number
      mipLevelCount?: number
    },
  ): number {
    const meta = textureMeta.get(textureId)
    if (meta === undefined) {
      throw new Error(`rune: createTextureView — texture ${textureId} not found`)
    }
    const mipLevels = meta.mipLevels
    if (mipLevels < 2) {
      throw new Error(
        `rune: createTextureView — texture ${textureId} has mipLevels=${mipLevels} ` +
        '(no mip-chain). A sub-mip view only makes sense with mipLevels ≥ 2.',
      )
    }
    const baseMipLevel = options?.baseMipLevel ?? 0
    if (baseMipLevel < 0 || baseMipLevel >= mipLevels) {
      throw new Error(
        `rune: createTextureView — baseMipLevel=${baseMipLevel} out of range [0, ${mipLevels - 1}] ` +
        `(textureId=${textureId}, mipLevels=${mipLevels})`,
      )
    }
    // default mipLevelCount = all remaining mips to the end of the chain
    const mipLevelCount = options?.mipLevelCount ?? (mipLevels - baseMipLevel)
    if (mipLevelCount < 1 || baseMipLevel + mipLevelCount > mipLevels) {
      throw new Error(
        `rune: createTextureView — baseMipLevel=${baseMipLevel} + mipLevelCount=${mipLevelCount} ` +
        `exceeds mipLevels=${mipLevels} (textureId=${textureId})`,
      )
    }
    const viewId = nextTextureViewId++
    textureViews.set(viewId, {
      textureId,
      baseMipLevel,
      maxMipLevel: baseMipLevel + mipLevelCount - 1,
    })
    return viewId
  }

  function deleteTextureView(viewId: number): void {
    // Idempotence: no entry — a no-op.
    textureViews.delete(viewId)
  }

  function setViewport(width: number, height: number): void {
    canvasWidth = width
    canvasHeight = height
    gl.viewport(0, 0, width, height)
  }

  function createTarget(
    textureId: number,
    width: number,
    height: number,
    depth: boolean,
    color: readonly [number, number, number, number],
  ): number {
    const fbo = gl.createFramebuffer()
    if (fbo === null) throw new Error('rune: createFramebuffer returned null')
    let depthRenderbuffer: WebGLRenderbuffer | null = null
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textures.get(textureId) ?? null, 0)
    if (depth) {
      depthRenderbuffer = gl.createRenderbuffer()
      if (depthRenderbuffer === null) throw new Error('rune: createRenderbuffer returned null')
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRenderbuffer)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRenderbuffer)
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    // Restore the previous target before a possible throw: the state does not leak
    gl.bindFramebuffer(gl.FRAMEBUFFER, currentTarget === 0 ? null : targets.get(currentTarget)?.fbo ?? null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      // Cleanup: the created FBO and renderbuffer are garbage
      if (depthRenderbuffer !== null) gl.deleteRenderbuffer(depthRenderbuffer)
      gl.deleteFramebuffer(fbo)
      throw new Error(`rune: surface FBO incomplete (status ${status}) — size ${width}x${height}`)
    }
    const id = nextTarget++
    targets.set(id, {
      fbo,
      textureId,
      width,
      height,
      depth,
      depthRenderbuffer,
      color,
    })
    return id
  }

  function bindTarget(targetId: number, clear: boolean): void {
    if (targetId === currentTarget && !clear) return
    currentTarget = targetId
    if (targetId === 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, canvasWidth, canvasHeight)
      return
    }
    const target = targets.get(targetId)
    if (target === undefined) return
    // Feedback-loop prevention: the TARGET texture must not stay bound to
    // sampler units while it is the FBO's color attachment (GL: undefined;
    // ANGLE/SwiftShader kill such draws). Exactly this was killing frame 2+.
    for (const [unit, boundId] of unitTextures) {
      if (boundId === target.textureId) {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, null)
        unitTextures.delete(unit)
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.viewport(0, 0, target.width, target.height)
    if (clear) {
      gl.clearColor(target.color[0], target.color[1], target.color[2], target.color[3])
      if (target.depth) {
        gl.depthMask(true) // clear is masked by depthMask (see clear())
        gl.clearDepth(1)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      } else {
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
    }
  }

  function setDepthMode(test: string, write: boolean): void {
    if (test === 'always') gl.disable(gl.DEPTH_TEST)
    else {
      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(test === 'lequal' ? gl.LEQUAL : gl.LESS)
    }
    gl.depthMask(write)
  }

  // ─── Task 80: readback (readPixels + row flip) ───────────────────
  // Parity contract with the GPU facade: RGBA8, tight, rows TOP-DOWN.
  // GL readPixels: origin — the bottom-LEFT corner, row 0 — the bottom; WebGPU
  // copyTextureToBuffer returns rows top-down. The flip here gives the
  // same index = the same pixel on both backends.
  function readTargetPixels(targetId: number): Uint8Array {
    if (targetId === 0) {
      throw new Error('rune: readTargetPixels(0) — the canvas cannot be read (parity with WebGPU: the presented texture lives for one frame). Read the SURFACE instead: renderer.surface(...) → capture/passes → surface.read()')
    }
    const target = targets.get(targetId)
    if (target === undefined) {
      throw new Error(`rune: readTargetPixels — target ${targetId} not found (deleted or never created)`)
    }
    const w = target.width
    const h = target.height
    // The FBO binding does not leak: we read in our own binding, restore the previous one after.
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    const rowBytes = w * 4
    const bottomUp = new Uint8Array(rowBytes * h)
    try {
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp)
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, currentTarget === 0 ? null : targets.get(currentTarget)?.fbo ?? null)
    }
    // Flip: GL row 0 = bottom → in the output row 0 = top (like texture row 0).
    const out = new Uint8Array(rowBytes * h)
    for (let y = 0; y < h; y++) {
      out.set(bottomUp.subarray((h - 1 - y) * rowBytes, (h - y) * rowBytes), y * rowBytes)
    }
    return out
  }

  function setCull(mode: string): void {
    if (mode === 'none') gl.disable(gl.CULL_FACE)
    else {
      gl.enable(gl.CULL_FACE)
      gl.cullFace(mode === 'front' ? gl.FRONT : gl.BACK)
    }
  }

  /** Task 75: facade BlendFactor string → GLenum. Task 122: the
   *  dst-alpha family + src-alpha-saturated (three.quarks' custom
   *  blending demos use them). */
  const BLEND_FACTORS: Record<string, number> = {
    'zero': 0, 'one': 1, 'src-color': 0x0300, 'one-minus-src-color': 0x0301,
    'src-alpha': 0x0302, 'one-minus-src-alpha': 0x0303,
    'dst-alpha': 0x0304, 'one-minus-dst-alpha': 0x0305,
    'dst-color': 0x0306, 'one-minus-dst-color': 0x0307,
    'src-alpha-saturated': 0x0308,
  }
  /** Task 122: the blend equation string → GLenum (FUNC_ADD is the spec
   *  default; MIN/MAX are core WebGL2). */
  const BLEND_EQUATIONS: Record<string, number> = {
    'add': 0x8006, 'subtract': 0x800A, 'reverse-subtract': 0x800B,
    'min': 0x8007, 'max': 0x8008,
  }

  function setBlend(src: string | null, dst: string | null, equation?: string): void {
    if (src === null || dst === null) {
      gl.disable(gl.BLEND)
      return
    }
    gl.enable(gl.BLEND)
    // Task 75b (driver-proofing): the equation is re-asserted explicitly —
    // per-context global state like the factors: anything that left
    // FUNC_SUBTRACT on this context would turn every blended draw into a
    // subtraction while the factors stay "correct" (an invisible-to-trace
    // class). Task 122: the equation now follows the pipeline desc
    // (absent = 'add', the previous pinned constant).
    gl.blendEquation(BLEND_EQUATIONS[equation ?? 'add'] ?? gl.FUNC_ADD)
    // Premultiplied shader output: blendFunc(src, dst) without
    // separate RGB/A — the canvas alpha channel is opaque (alpha:false).
    gl.blendFunc(BLEND_FACTORS[src] ?? gl.ONE, BLEND_FACTORS[dst] ?? gl.ZERO)
  }

  function clear(color: readonly number[], depth: number | null): void {
    gl.clearColor(color[0], color[1], color[2], color[3])
    // glClear is masked by depthMask: the previous frame may have left it false
    // (a fullscreen pass) — the depth would silently not be cleared (the demo-10 lesson:
    // frame 2+ empty, the scene z-fights with the previous frame)
    if (depth !== null) {
      gl.depthMask(true)
      gl.clearDepth(depth)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    } else {
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
  }

  function drawArrays(mode: string, first: number, count: number, instances: number): void {
    if (instances > 1) gl.drawArraysInstanced(mode === 'triangles' ? gl.TRIANGLES : gl.TRIANGLES, first, count, instances)
    else gl.drawArrays(gl.TRIANGLES, first, count)
  }

  // ─── Disposal: explicit release of the GPU resource ───
  // Idempotence: a repeated delete of the same id — a no-op (the entry is already gone from the Map).
  // If the id is not found — also a no-op (nothing can be done, but we do not throw either).

  function deleteTexture(textureId: number): void {
    const texture = textures.get(textureId)
    if (texture === undefined) return
    // Unbind from sampler units (otherwise deleteTexture is silently ignored on some drivers)
    for (const [unit, boundId] of unitTextures) {
      if (boundId === textureId) {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, null)
        unitTextures.delete(unit)
      }
    }
    gl.deleteTexture(texture)
    textures.delete(textureId)
    textureMeta.delete(textureId)
    // Delete all sub-mip views of this texture (Task 56): they are useless without
    // the parent texture — bindTexture(viewId) will be a no-op (textureId not
    // found in the textures Map). We remove them from textureViews to guarantee
    // that textureViews does not accumulate "orphaned" entries until the end of the session.
    for (const [viewId, sv] of textureViews) {
      if (sv.textureId === textureId) {
        textureViews.delete(viewId)
      }
    }
  }

  function deleteTarget(targetId: number): void {
    const target = targets.get(targetId)
    if (target === undefined) return
    // If the target is currently active — detach it from the context BEFORE deletion
    if (currentTarget === targetId) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      currentTarget = 0
    }
    if (target.depthRenderbuffer !== null) gl.deleteRenderbuffer(target.depthRenderbuffer)
    gl.deleteFramebuffer(target.fbo)
    targets.delete(targetId)
  }

  function deleteProgram(programId: number): void {
    const record = programs.get(programId)
    if (record === undefined) return
    if (currentProgram === record.program) {
      gl.useProgram(null)
      currentProgram = null
      currentProgramId = -1
    }
    gl.deleteProgram(record.program)
    programs.delete(programId)
  }

  function deleteBuffer(bufferId: number): void {
    const buffer = buffers.get(bufferId)
    if (buffer === undefined) return
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.deleteBuffer(buffer)
    buffers.delete(bufferId)
  }

  return {
    createProgram,
    useProgram,
    createBuffer,
    bindVertexBuffer,
    updateBuffer,
    setUniformMatrix4,
    setUniform4fv,
    setUniform3fv,
    setUniform2fv,
    setUniform1f,
    setUniform1i,
    createTexture,
    texSubImage2D,
    texImage2DFromSource,
    texSubImage2DFromSource,
    texImage2DLevel,
    bindTexture,
    createTextureView,
    deleteTextureView,
    setViewport,
    setDepthMode,
    setCull,
    setBlend,
    clear,
    drawArrays,
    createTarget,
    bindTarget,
    readTargetPixels,
    deleteTexture,
    deleteTarget,
    deleteProgram,
    deleteBuffer,
  }
}
