// The real WebGL2 facade: shader compilation, uniforms by name,
// attribute buffers, textures. One hidden class, lazy caches.

import type { GLFacade, GLImageSource, GLTextureFormat } from './facade.ts'

interface ProgramRecord {
  readonly program: WebGLProgram
  readonly uniforms: Map<string, WebGLUniformLocation | null>
  /** Task 163 — the label for the link-failure message ('program' /
   *  'transform pass' — the two historical error texts stay distinct). */
  readonly label: string
  /** Task 163 — KHR_parallel_shader_compile: the link is IN FLIGHT on a
   *  driver thread (submitted, not yet resolved). false = resolved (or the
   *  sync path — the extension is absent, the link was checked at submit). */
  linkPending: boolean
  /** Task 163 — the CACHED link failure: a failed deferred link throws on
   *  EVERY use (the record remembers; the driver's info log is queried
   *  once). null = ok / not yet resolved. */
  linkError: string | null
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
  // Task 132 — THE ENUM FIX: GL_RGBA32F is 0x8814 (the GL registry), NOT
  // 0x8816 (a dormant typo since the Task 67 HDR work — the mock-based
  // tests never validate internal formats, and no demo allocated a
  // rgba32f texture until the TF tier's state texture. The wrong enum
  // made every rgba32f texImage2D fail with "invalid internalformat" on
  // real browsers, leaving the texture level-less and every texSubImage2D
  // "Level of detail outside of range").
  RGBA32F: 0x8814,
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

/** Task 161 — THE PROGRAM-BINARY CACHE POISON: on ARM Mali drivers the
 *  glProgramBinary blob omits the transform-feedback varyings, and
 *  ANGLE's program cache (backed by Chrome's GPU disk cache — it survives
 *  reloads and browser restarts) restores such a binary on any REPEAT
 *  link of the same source set: the link reports ok, the varyings query
 *  reports the full set, and the TF pass then silently captures NOTHING
 *  (the SENTINEL-INTACT signature; the v1–v4 field probes on the Mali-G57:
 *  15/15 links — every FIRST link of a source set alive, every repeat
 *  link dead — reload, context recovery, second tab, all identical; and
 *  the repeat links are FASTER: 6–9ms vs 14–16ms, the cache-hit
 *  fingerprint). Chrome's gpu_driver_bug_list workaround for exactly
 *  this (entry 306, crbug.com/961950) is dead code under the ANGLE
 *  passthrough decoder — issuetracker.google.com/issues/530857248,
 *  fixed ANGLE-side 2026-07-06 (CL 8040203: disable program caching on
 *  Mali), but Chrome ≤150 and every other GL stack stay exposed.
 *
 *  THE ARMOR (the app-level mirror of the ANGLE fix): a trailing comment
 *  unique to EVERY link changes the program-binary cache key, so a TF
 *  link is a cache MISS forever — a fresh compile is the one link shape
 *  the field matrix proved TF-alive. The nonce rides the VERTEX source
 *  alone (the captured varyings are the vertex stage's outputs; the v4
 *  probe salted the vertex only and defeated the poison) and is unique
 *  across reloads (time+random seed) AND within a page (monotonic
 *  counter) — a context recovery's re-link must miss the cache too, not
 *  just the first boot. Render programs (createProgram) stay
 *  cache-eligible: the poison only strikes binaries that carry TF
 *  varyings. Cost: one fresh compile per TF pass creation (~10–16ms in
 *  the field). */
const TF_NONCE_SEED = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`
let tfNonceCounter = 0

/** Appends the per-link nonce comment (Task 161) to a TF pass's vertex
 *  source. A trailing `//` comment is position-safe GLSL (the #version
 *  directive must stay the first statement, so the nonce never precedes
 *  it); a missing final newline is supplied first. */
function tfNoncedVertexSource(vertex: string): string {
  const source = vertex.endsWith('\n') ? vertex : `${vertex}\n`
  return `${source}// rune tf-link ${TF_NONCE_SEED}#${++tfNonceCounter}\n`
}

export function createRealGL(
  gl: WebGL2RenderingContext,
  /** Task 129: the viewport-heal sink — fires ONCE per divergence between
   *  the real drawing buffer and the renderer's notion of it (the live
   *  "everything drawn in the bottom-left corner" report). Routed to the
   *  GL error sink so the demo log carries the diagnosis. */
  onViewportHeal?: (message: string) => void,
): GLFacade {
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
  // Task 163 — KHR_parallel_shader_compile: non-blocking compile+link.
  // With the extension the driver defers shader compilation to background
  // threads and the LINK may be queued before the compiles finish; every
  // status query (COMPLETION_STATUS_KHR) is then non-blocking. WITHOUT the
  // extension each getProgramParameter(LINK_STATUS) blocks until the driver
  // finishes — the historical behavior, kept byte-for-byte (the sync path
  // checks the link right at submit; only the ext path defers).
  // In mock-GL environments getExtension may be undefined — try/catch guard.
  let parallelCompileExt: { readonly COMPLETION_STATUS_KHR: number } | null = null
  try {
    parallelCompileExt = (gl as unknown as {
      getExtension?: (name: string) => unknown
    }).getExtension?.('KHR_parallel_shader_compile') as { readonly COMPLETION_STATUS_KHR: number } | null ?? null
  } catch {
    parallelCompileExt = null
  }
  // Task 169 — WEBGL_multi_draw (the ANGLE batch-draw extension): the
  // executor's batch tier rides it — a run of consecutive draws of the
  // SAME command collapses into ONE driver call instead of N
  // drawArraysInstanced round-trips (the per-call driver/ANGLE overhead —
  // the desktop-GL twin of why WebGPU draw() is cheap: fewer crossings).
  // ANGLE implements it on all its backends; plain GL exposes it from the
  // extension string; a context without it keeps the per-draw path (the
  // facade method simply stays absent — the executor detects by presence).
  // In mock-GL environments getExtension may be undefined — try/catch guard
  // (the same contract as anisoExt/parallelCompileExt above).
  let multiDrawExt: {
    multiDrawArraysInstancedWEBGL(
      mode: number,
      firstsList: Int32Array, firstsOffset: number,
      countsList: Int32Array, countsOffset: number,
      instanceCountsList: Int32Array, instanceCountsOffset: number,
      drawcount: number,
    ): void
  } | null = null
  try {
    multiDrawExt = (gl as unknown as {
      getExtension?: (name: string) => unknown
    }).getExtension?.('WEBGL_multi_draw') as {
      multiDrawArraysInstancedWEBGL(
        mode: number,
        firstsList: Int32Array, firstsOffset: number,
        countsList: Int32Array, countsOffset: number,
        instanceCountsList: Int32Array, instanceCountsOffset: number,
        drawcount: number,
      ): void
    } | null ?? null
  } catch {
    multiDrawExt = null
  }
  let nextProgram = 1
  // Task 137 — the DEFAULT VAO's attrib LEDGER: location → the facade
  // bufferId bindVertexBuffer last pointed there (the DEFAULT VAO only —
  // a pass VAO is current during the transform-feedback family and its
  // locations die with the pass). Kept at BIND time because the GL query
  // is ambiguous AFTER a delete: getVertexAttrib(BUFFER_BINDING) returns
  // null for a deleted buffer's location on real contexts (the forensics
  // probe pinned it — "2:DELETED"), so a post-delete walk could never
  // match the object; the bind-time map matches by FACADE ID instead.
  const defaultAttribBindings = new Map<number, number>()
  let passVaoActive = false
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
  // Task 163 — THE UNIT-BIND CACHE: the render executor re-asserts every
  // command's samplers per draw (the same Task-75b discipline as the
  // pipeline state), and the TF pass family rebinds its state/pair textures
  // on every pass of every frame — within a pass those rebinds are 100%
  // redundant: the same texture, the same LOD range, the same unit. A
  // skipped bind saves 4 GL calls (activeTexture + bindTexture + the
  // 2× texParameteri of the LOD re-assert). The cache lives EXACTLY one
  // pass: bindTarget drops it at every pass start / target switch (the
  // re-assert discipline survives — external state changes between our
  // frames still die at the pass boundary), and every facade path that
  // binds a texture OUTSIDE bindTexture (the upload family, createTexture)
  // or resets a unit (deleteTexture, the feedback-loop unbind) clears it —
  // the cache must never outlive the GL state it mirrors. NOTE: gl.bindTexture
  // inside texSubImage2D & co binds to the CURRENT active unit — those paths
  // change unit state bindTexture does not know about, hence the clears.
  const unitBindCache = new Map<number, { readonly textureId: number; readonly baseLevel: number; readonly maxLevel: number }>()
  /** Drop every mirrored unit binding (see unitBindCache). */
  function invalidateUnitBinds(): void {
    unitBindCache.clear()
  }

  // Task 164 — THE SCRATCH UPLOAD UNIT: the PBO upload path
  // (texSubImage2DBuffer — the TF tier's per-pass GPU→GPU state round-trip,
  // ~178 calls per frame in the sort loop) used to bind TEXTURE_2D on the
  // CURRENT active unit and kill the WHOLE unit-bind cache — every TF
  // pass's follow-up bindTexture re-bound for real (4 GL calls each), so
  // Task 163's cache never survived a frame of sorting. The upload now
  // binds on the LAST texture unit instead: no sampler ever lives there
  // (bindTexture is called with units 0..texCount-1, and the mirror entry
  // for the scratch unit is dropped on every upload), so units 0..N-2
  // stay mirror-valid across the PBO round-trips. The feedback-loop ledger
  // (unitTextures) DOES see the scratch binding — more honest than before
  // (the old path changed the current unit's real binding invisibly).
  let uploadUnit = 7 // the GLES3 guarantee floor is MAX_TEXTURE_IMAGE_UNITS ≥ 8
  try {
    const probed = (gl as unknown as { getParameter?: (pname: number) => unknown }).getParameter?.(
      (gl as unknown as { MAX_TEXTURE_IMAGE_UNITS?: number }).MAX_TEXTURE_IMAGE_UNITS ?? 0x8872,
    )
    if (typeof probed === 'number' && Number.isFinite(probed) && probed >= 1) {
      uploadUnit = Math.min(31, Math.max(0, Math.floor(probed) - 1))
    }
  } catch { /* a mock without getParameter — the floor stands */ }
  // Task 164 — THE UNPACK_ALIGNMENT MIRROR: the two pixel-upload paths
  // disagree on row alignment (the raw-byte path pins 1, the PBO path pins
  // 4) and re-assert it unconditionally per call — the sort loop paid ~178
  // redundant pixelStorei per frame. The mirror skips re-asserts; both
  // writers keep it current, so a flip in one path re-arms the other.
  let unpackAlignmentMirror = 0
  // Task 165 — THE VERTEX-BIND MEMO (the render-path twin of Task 164's
  // WebGPU vertex-bind memo): the tape executor re-asserts EVERY command's
  // attributes on EVERY draw — bindBuffer + enableVertexAttribArray +
  // vertexAttribPointer + vertexAttribDivisor, 4 GL calls per attribute —
  // while the pointer tuple (buffer, size, stride, offset, divisor) is a
  // COMPILE-TIME CONSTANT of the command: within a pass the re-asserts are
  // 100% redundant (a 20-mesh scene × 5 attributes × 60fps = 24 000 skipped
  // calls/second). The mirror holds the DEFAULT VAO's last-known pointer
  // tuple per location; a skipped bind saves all 4 calls. The memo lives
  // EXACTLY one pass — bindTarget drops it at every pass start / target
  // switch (the 75b re-assert discipline survives: external default-VAO
  // changes between our frames die at the pass boundary, exactly like the
  // unit-bind cache) — and deleteBuffer disarms the mirrored locations of
  // the deleted buffer (the Task-137 ledger walk already disables them).
  // NOT invalidated by updateBuffer: a contents-only upload (the feed path —
  // the per-frame record buffer) leaves the pointer tuple valid, so the
  // feed rebinds die too — the deepest steady-state win of the family.
  // A pass-VAO bind (passVaoActive) never touches this mirror: the TF
  // family's VAO state is its own, and the default VAO is restored after.
  const vertexBindMemo = new Map<number, { readonly bufferId: number; readonly size: number; readonly stride: number; readonly offset: number; readonly divisor: number }>()
  /** Drop the whole vertex-bind mirror (see vertexBindMemo — the pass-boundary + structural invalidations). */
  function invalidateVertexBinds(): void {
    vertexBindMemo.clear()
  }
  // Task 165 — THE SAMPLER-UNIT MEMO (the draw-path twin of the TF family's
  // record.texUnits): the executor asserts every command's sampler UNIFORMS
  // per draw (setUniform1i — the Task-136 unit contract), but the value is a
  // compile-time constant of the command and program uniform state PERSISTS —
  // the re-assert writes the same byte to the same location every frame. The
  // memo mirrors the last written value per (programId, name) and skips the
  // whole call chain (useProgram resolve + location probe + uniform1i) when
  // the value matches. programIds are monotonic — a deleted program's entry
  // can never alias a new one; deleteProgram drops it for hygiene.
  const samplerUnits = new Map<number, Map<string, number>>()

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

  /** Task 163 — THE PENDING-LINK SET (KHR_parallel_shader_compile): every
   *  record whose link is in flight on a driver thread. resolveProgramLink
   *  round-robins over it (one COMPLETION_STATUS query can finalize several
   *  programs at once), deleteProgram/deleteTransformPass unhook their
   *  records. */
  const pendingLinks = new Set<ProgramRecord>()

  function createProgram(vertex: string, fragment: string): number {
    const program = gl.createProgram()
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment))
    gl.linkProgram(program)
    const record: ProgramRecord = {
      program, uniforms: new Map(), label: 'program',
      linkPending: false, linkError: null,
    }
    finishLinkSubmission(program, record)
    const id = nextProgram++
    programs.set(id, record)
    return id
  }

  /** Task 163 — the link submission's tail: WITH the extension the link is
   *  deferred (the record joins pendingLinks; the first use resolves);
   * WITHOUT it — today's exact blocking check, right at submit. */
  function finishLinkSubmission(program: WebGLProgram, record: ProgramRecord): void {
    if (parallelCompileExt !== null) {
      record.linkPending = true
      pendingLinks.add(record)
      return
    }
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`rune: ${record.label} linking: ${gl.getProgramInfoLog(program)}`)
    }
  }

  function compile(type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)
    if (shader === null) throw new Error('rune: createShader returned null')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (parallelCompileExt === null) {
      // The sync path: getShaderParameter(COMPILE_STATUS) blocks until the
      // driver finishes — today's behavior exactly.
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader)
        gl.deleteShader(shader)
        throw new Error(`rune: shader compilation: ${log}`)
      }
      return shader
    }
    // The deferred path: the compile runs on a driver background thread;
    // attach+linkProgram on a still-compiling shader is LEGAL (the extension
    // queues the link behind the compiles). A FAILED compile surfaces at
    // the link: COMPLETION_STATUS flips true, LINK_STATUS reads false, and
    // the program's info log carries the shader's compile errors (ANGLE
    // concatenates them) — the error path stays diagnosable, one hop later.
    return shader
  }

  /** Task 163 — resolve a program's deferred link at FIRST USE (the use
   *  uniform-family, a TF run — anything that must not observe a
   *  half-linked program: getUniformLocation/getAttribLocation on an
   *  unlinked program return null/-1, and the facade's location CACHES
   * would freeze that null forever — the trap this resolve kills).
   *
   *  The spin: COMPLETION_STATUS_KHR is non-blocking, so we poll — the only
   *  primitive a synchronous facade has. The poll is ROUND-ROBIN over the
   *  whole pending set: one IPC round-trip can finalize several programs
   *  (they are all compiling in parallel — that is the point), so resolving
   *  program A usually finds B..N done too, and their resolves return
   *  instantly. Guards: isContextLost (a lost context makes every query
   *  return garbage forever — the spin must not hang the page) and a hard
   *  30s deadline (a wedged driver must not hang the page either). */
  function resolveProgramLink(programId: number): void {
    const record = programs.get(programId)
    if (record === undefined) return
    if (!record.linkPending) {
      if (record.linkError !== null) throw new Error(record.linkError)
      return
    }
    const completionStatus = parallelCompileExt !== null ? parallelCompileExt.COMPLETION_STATUS_KHR : 0x91b1
    const deadline = Date.now() + 30_000
    for (;;) {
      for (const pending of pendingLinks) {
        let complete: unknown
        try {
          complete = gl.getProgramParameter(pending.program, completionStatus)
        } catch {
          complete = true // the query itself failed — fall through to the LINK check
        }
        if (complete === true || complete === 1) {
          pendingLinks.delete(pending)
          pending.linkPending = false
          if (!gl.getProgramParameter(pending.program, gl.LINK_STATUS)) {
            pending.linkError = `rune: ${pending.label} linking: ${gl.getProgramInfoLog(pending.program)}`
          }
        }
      }
      if (!record.linkPending) break
      if (Date.now() > deadline) {
        for (const pending of pendingLinks) {
          pending.linkPending = false
          pending.linkError = 'rune: program link did not complete within 30s (KHR_parallel_shader_compile) — the driver appears wedged'
        }
        pendingLinks.clear()
        break
      }
      const lost = (gl as unknown as { isContextLost?: () => boolean }).isContextLost?.() ?? false
      if (lost) {
        for (const pending of pendingLinks) {
          pending.linkPending = false
          pending.linkError = 'rune: WebGL context lost while a program link was in flight'
        }
        pendingLinks.clear()
        break
      }
    }
    if (record.linkError !== null) throw new Error(record.linkError)
  }

  function useProgram(programId: number): void {
    // Numeric early-out: the common case (the same program as the previous
    // uniform call) must not hash the programs Map per uniform.
    if (programId === currentProgramId) return
    const record = programs.get(programId)
    if (record === undefined || record.program === currentProgram) return
    // Task 163: a deferred link resolves HERE — the program must be fully
    // linked before the GL sees it as current.
    resolveProgramLink(programId)
    currentProgram = record.program
    currentProgramId = programId
    gl.useProgram(record.program)
  }

  function location(programId: number, name: string): WebGLUniformLocation | null {
    const record = programs.get(programId)
    if (record === undefined) return null
    // Task 163 — the link resolves BEFORE any location query:
    // getUniformLocation on an unlinked program legally returns null, and
    // the cache below would freeze that null FOREVER (every uniform call
    // silently skipped — the deferred-link trap).
    resolveProgramLink(programId)
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

  /** The buffer usage hint. Task 140 — the GPGPU TF tier's buffers are
   *  REWRITTEN EVERY FRAME (a TF pass's stream output, then read back as a
   *  vertex/PBO source on the same frame) — 'dynamic' maps to DYNAMIC_DRAW,
   *  the semantically correct hint for that cycle. 'static' (the default,
   *  the historical behavior) keeps STATIC_DRAW for the one-shot upload
   *  buffers (geometry, feeds). ANGLE's buffer-backends read the hint when
   *  they pick the D3D11/Vulkan resource type; a frame-rewritten 'static'
   *  buffer takes the immutable-leaning path on some backends — the
   *  dual-use (write+read per frame) works on both, but the dynamic hint
   *  is what the usage was invented for. */
  function createBuffer(data: Float32Array, usage: 'static' | 'dynamic' = 'static'): number {
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, usage === 'dynamic' ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW)
    // Task 139 — the TF-capture overlap discipline: WebGL2 forbids a buffer
    // sitting on the generic ARRAY_BUFFER binding at the moment it is
    // captured by bindBufferBase(TRANSFORM_FEEDBACK_BUFFER) — the capture
    // raises INVALID_OPERATION and silently drops the TF write on strict
    // drivers (the task135 harness's own pinned lesson: ITS createBuffer
    // unbinds; the facade's did not). Every consumer rebinds what it needs
    // (bindVertexBuffer / updateBuffer bind first) — leaving the generic
    // binding EMPTY is the clean state.
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    const id = nextBuffer++
    buffers.set(id, buffer)
    return id
  }

  function bindVertexBuffer(bufferId: number, location: number, size: number, stride?: number, byteOffset?: number, divisor?: number): void {
    const strideVal = stride ?? 0
    const offsetVal = byteOffset ?? 0
    const divisorVal = divisor ?? 0
    const buffer = buffers.get(bufferId)
    // Task 165 — the vertex-bind memo (see its declaration): an identical
    // pointer tuple re-asserted within the same pass is skipped entirely
    // (4 GL calls → 0); the pass boundary / deleteBuffer re-arms it. Only
    // REAL buffers are mirrored — an unknown id keeps the historical
    // bind-null-and-enable path (a caller bug, but not a memo-able one).
    if (!passVaoActive && buffer !== undefined) {
      const memo = vertexBindMemo.get(location)
      if (memo !== undefined && memo.bufferId === bufferId && memo.size === size
        && memo.stride === strideVal && memo.offset === offsetVal && memo.divisor === divisorVal) {
        return
      }
      vertexBindMemo.set(location, { bufferId, size, stride: strideVal, offset: offsetVal, divisor: divisorVal })
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer ?? null)
    gl.enableVertexAttribArray(location)
    // Task 137 — the enabled-location LEDGER of the DEFAULT VAO (the
    // deleteBuffer disarm's bookkeeping; see the ledger's declaration
    // comment). A pass VAO is bound during the transform-feedback family —
    // its locations live and die with the pass, never with the default VAO.
    if (!passVaoActive) defaultAttribBindings.set(location, bufferId)
    // M5: feed interleaving — the record's stride/offset (default: tight 0/0).
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, strideVal, offsetVal)
    // Task 75: the instance step (star quads: one feed record = one instance).
    // Called UNCONDITIONALLY (and with 0) — resets the divisor after instanced
    // commands, otherwise the attribute would "stick" with divisor=1 for regular geometry.
    gl.vertexAttribDivisor(location, divisorVal)
    // Task 165 — THE TF-CAPTURE DISCIPLINE, STRENGTHENED: the generic
    // ARRAY_BUFFER binding ends EMPTY after every real bind (the pointer
    // was captured by vertexAttribPointer at call time — the binding has no
    // further readers). This closes a latent hazard the memo would otherwise
    // OPEN: a skipped bind leaves the PREVIOUS buffer on ARRAY_BUFFER — if
    // that buffer later became a TF pass's OUTPUT (the pack pass writing the
    // very records buffer the draw path binds as instance attributes), the
    // bindBufferBase(TRANSFORM_FEEDBACK_BUFFER) capture would overlap it and
    // silently drop the write (the exact Task-139 class). With the trailing
    // unbind, ARRAY_BUFFER is null outside of the bind itself — by
    // construction, on every path (createBuffer/updateBuffer already unbind).
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  /** M5 (Task 73): dynamic update (feed dual-bind) — bufferSubData.
   *  The storage is already allocated by createBuffer (bufferData); here — only
   *  the content: the feed renderer pours the dirty range in a single call.
   *  Task 139 — the same ARRAY_BUFFER discipline as createBuffer: unbind
   *  after the sub-data (a later TF capture must never see this binding). */
  function updateBuffer(bufferId: number, data: Float32Array, byteOffset = 0): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.get(bufferId) ?? null)
    gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, data)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  /** Task 140 — THE GPU-SIDE READBACK (the diagnostics surface): reads
   *  `dst.length` floats from a buffer into `dst` through COPY_READ_BUFFER
   *  (a target neither the vertex path nor the PBO path ever leaves bound).
   *  One producer's truth, for the GPGPU tiers' self-diagnostics and the
   *  parity probes — a SYNCHRONOUS stall, so the callers keep it one-shot
   *  (a diagnostic frame), never per-frame. Returns false (and leaves dst
   *  untouched) when the read is refused — a deleted buffer, a driver
   *  error — the caller treats "unreadable" as "unknown", not "degenerate". */
  function readBuffer(bufferId: number, dst: Float32Array): boolean {
    const buffer = buffers.get(bufferId)
    if (buffer === undefined) return false
    gl.bindBuffer(gl.COPY_READ_BUFFER, buffer)
    try {
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, dst)
    } catch {
      gl.bindBuffer(gl.COPY_READ_BUFFER, null)
      return false
    }
    gl.bindBuffer(gl.COPY_READ_BUFFER, null)
    return true
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
    // Task 165 — the sampler-unit memo (see its declaration): an identical
    // re-write is skipped BEFORE the program switch, the location probe and
    // the uniform call — program uniform state persists, the value would
    // write the same byte to the same location. Any caller that writes a
    // DIFFERENT value misses the memo and re-arms it (last-write-wins kept
    // exact, whoever the writer was).
    let perProgram = samplerUnits.get(programId)
    if (perProgram !== undefined && perProgram.get(name) === value) return
    useProgram(programId)
    const loc = location(programId, name)
    if (loc !== null) gl.uniform1i(loc, value)
    if (perProgram === undefined) {
      perProgram = new Map<string, number>()
      samplerUnits.set(programId, perProgram)
    }
    perProgram.set(name, value)
  }

  function createTexture(
    width: number,
    height: number,
    options?: { mipLevels?: number; maxAnisotropy?: number; format?: GLTextureFormat },
  ): number {
    const texture = gl.createTexture()
    invalidateUnitBinds()
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

  function texSubImage2D(textureId: number, x: number, y: number, width: number, height: number, bytes: Uint8Array | Float32Array): void {
    invalidateUnitBinds()
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
    unpackAlignmentMirror = 1 // Task 164 — the alignment mirror (see its declaration)
    // The raw-byte path — the UploadScheduler's domain: Uint8Array implies
    // 8-bit pixels. For HDR textures (rgba16f/rgba32f) the bytes will be
    // interpreted per the texture format's (format, type) — the caller must
    // prepare the data (scheduler streaming in float is a separate task).
    const pair = uploadPair(textureId)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, pair.format, pair.type, bytes)
  }

  function texImage2DFromSource(textureId: number, source: GLImageSource, options?: { flipY?: boolean }): void {
    invalidateUnitBinds()
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
    invalidateUnitBinds()
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
    invalidateUnitBinds()
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
    // Task 163 — THE UNIT-BIND CACHE: if this unit already holds EXACTLY this
    // texture with this LOD range, the full bind would write the state the GL
    // already has — skip all 4 calls (see unitBindCache's declaration for the
    // invalidation contract that keeps this honest).
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
    const cachedBind = unitBindCache.get(unit)
    if (
      cachedBind !== undefined &&
      cachedBind.textureId === underlyingTextureId &&
      cachedBind.baseLevel === baseLevel &&
      cachedBind.maxLevel === maxLevel
    ) {
      // The feedback-loop ledger still mirrors the unit (a texture can be
      // re-asserted exactly BECAUSE it is bound — the entry must exist).
      unitTextures.set(unit, underlyingTextureId)
      return
    }
    gl.activeTexture(gl.TEXTURE0 + unit)
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
    unitBindCache.set(unit, { textureId: underlyingTextureId, baseLevel, maxLevel })
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
    if (targetId === 0) {
      // Task 129 — THE SELF-HEALING CANVAS BIND. The GL viewport is global
      // mutable state: anything that touched this context between our
      // passes (an offscreen probe on some driver, a browser-driven canvas
      // relayout, an extension, a context loss+restore) can leave it stale
      // — and a stale viewport confines the whole frame to the BOTTOM-LEFT
      // corner, "as if the canvas shrank" (the live report). The old early
      // return (`targetId === currentTarget && !clear`) skipped exactly
      // this re-assert when we were "already" on the canvas, so one
      // external viewport change lived on forever. Re-asserting on every
      // canvas bind is one bindFramebuffer + one viewport per pass start —
      // free. The drawing buffer is re-read too: if it moved without our
      // resize() seeing it (canvas.width written behind our back), we
      // adopt the real size and report the heal once.
      //
      // Task 163: the pass boundary is also where the unit-bind cache dies
      // (the 75b discipline — external texture-state changes between our
      // frames are re-asserted by the first bind of the pass; redundant
      // rebinds WITHIN the pass stay skipped).
      // Task 165: the vertex-bind memo dies with the same boundary — the
      // default VAO is re-asserted by each pass's first draws.
      currentTarget = 0
      invalidateUnitBinds()
      invalidateVertexBinds()
      const bufferW = gl.drawingBufferWidth
      const bufferH = gl.drawingBufferHeight
      if (bufferW > 0 && bufferH > 0 && (bufferW !== canvasWidth || bufferH !== canvasHeight)) {
        onViewportHeal?.(
          `viewport heal: the drawing buffer is ${bufferW}x${bufferH} but the renderer tracked ${canvasWidth}x${canvasHeight} — adopted the real size (an external canvas resize?)`,
        )
        canvasWidth = bufferW
        canvasHeight = bufferH
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, canvasWidth, canvasHeight)
      return
    }
    if (targetId === currentTarget && !clear) return
    currentTarget = targetId
    const target = targets.get(targetId)
    if (target === undefined) return
    // Task 163: a target switch runs through the feedback-loop unbind below
    // (unit bindings change) — the unit-bind cache dies with the switch.
    // Task 165: the vertex-bind memo dies with the same switch (the next
    // pass on the new target re-asserts its first binds).
    invalidateUnitBinds()
    invalidateVertexBinds()
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
   *  dst-alpha family + src-alpha-saturated (the custom
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
    // Task 167 — the mode mapping: 'lines' / 'points' / 'triangle-strip'
    // were silently drawn as TRIANGLES — the PrimitiveKind type promised
    // them, the switch delivered triangles for all four (the ternary's both
    // branches were gl.TRIANGLES — a copy-paste fossil). The executor today
    // only emits 'triangles', so nobody's pixels change; the facade becomes
    // honest for the day a line/point soup is recorded.
    // Task 169: the mapping moved to primitiveTarget() — the multi-draw
    // tier shares it (the batch call is honest for the same four modes).
    const target = primitiveTarget(mode)
    if (instances > 1) gl.drawArraysInstanced(target, first, count, instances)
    else gl.drawArrays(target, first, count)
  }

  /** Task 180 — THE INDEX TIER: the element buffer's one-shot upload. The
   *  buffer joins the shared `buffers` namespace (deleteBuffer frees it);
   *  the ELEMENT_ARRAY_BUFFER bind is removed after the upload — the
   *  binding is VAO state and the default VAO must stay clean (only
   *  drawElements ever reads it, and it rebinds at call time). */
  function createElementBuffer(data: Uint16Array | Uint32Array): number {
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
    const id = nextBuffer++
    buffers.set(id, buffer)
    return id
  }

  /** Task 180 — the indexed draw: bind → drawElements → unbind. The bind
   *  happens per call (no memo — one call per soup layer per frame; and the
   *  discipline stays honest against the TF pass VAOs, which carry their own
   *  element binding state). drawElementsInstanced only when instances > 1,
   *  mirroring drawArrays's own branch. An unknown buffer id binds null and
   *  the draw becomes a GL error — the same "caller bug, loud" contract as
   *  bindVertexBuffer's unknown-id path. */
  function drawElements(elementBufferId: number, indexCount: number, instances: number, twoByte: boolean): void {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.get(elementBufferId) ?? null)
    const type = twoByte ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT
    if (instances > 1) gl.drawElementsInstanced(gl.TRIANGLES, indexCount, type, 0, instances)
    else gl.drawElements(gl.TRIANGLES, indexCount, type, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
  }

  /** Task 169 — the mode string → GL enum (shared by drawArrays and the
   *  multi-draw tier; the Task-167 mapping, extracted verbatim). */
  function primitiveTarget(mode: string): number {
    return mode === 'lines'
      ? gl.LINES
      : mode === 'points'
        ? gl.POINTS
        : mode === 'triangle-strip'
          ? gl.TRIANGLE_STRIP
          : gl.TRIANGLES
  }

  // Task 169 — THE MULTI-DRAW TIER: drawcount instanced draws, one driver
  // call. The offsets are the (list, offset) pairs of the extension
  // signature — this facade always hands over the full lists with offset 0
  // and a drawcount the caller kept within bounds (the executor's
  // preallocated lists, [0, MAX_BATCH) — see executor.ts).
  function multiDrawArraysInstanced(mode: string, firsts: Int32Array, counts: Int32Array, instanceCounts: Int32Array, drawcount: number): void {
    if (multiDrawExt === null || drawcount <= 0) return
    multiDrawExt.multiDrawArraysInstancedWEBGL(primitiveTarget(mode), firsts, 0, counts, 0, instanceCounts, 0, drawcount)
  }

  // ─── Disposal: explicit release of the GPU resource ───
  // Idempotence: a repeated delete of the same id — a no-op (the entry is already gone from the Map).
  // If the id is not found — also a no-op (nothing can be done, but we do not throw either).

  function deleteTexture(textureId: number): void {
    const texture = textures.get(textureId)
    if (texture === undefined) return
    // Task 163 — the unbind loop below resets unit state behind the cache's
    // back; the whole mirror dies here.
    invalidateUnitBinds()
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
    // Task 163 — a deleted program's pending link is dead: unhook the record
    // (GL deleteProgram on an in-flight link is legal — the driver defers the
    // object's destruction until the link completes).
    pendingLinks.delete(record)
    if (currentProgram === record.program) {
      gl.useProgram(null)
      currentProgram = null
      currentProgramId = -1
    }
    gl.deleteProgram(record.program)
    programs.delete(programId)
    // Task 165 — the sampler-unit memo entry dies with the program (hygiene:
    // ids are monotonic and never alias, but the entry is pure garbage now).
    samplerUnits.delete(programId)
  }

  function deleteBuffer(bufferId: number): void {
    const buffer = buffers.get(bufferId)
    if (buffer === undefined) return
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.deleteBuffer(buffer)
    buffers.delete(bufferId)
    // Task 137 — THE DANGLING ENABLED ATTRIB (the live "the 2nd WebGL run
    // shows nothing while the counter counts" class): a vertex attrib
    // location enabled by bindVertexBuffer KEEPS its vertexAttribPointer
    // association in the DEFAULT VAO after the buffer is deleted — per the
    // GLES3/WebGL2 spec the association is not severed by deleteBuffer, and
    // the next drawArrays with that location still enabled fails with
    // INVALID_OPERATION ("no buffer is bound to enabled attribute") — the
    // draw is DROPPED, silently, on strict drivers (ANGLE/D3D, Vulkan GL);
    // SwiftShader validates only a subset, which is why the software-GL
    // container mostly rendered through it (the forensics: the GPU particle
    // tier's records buffer at the 5 instance-attribute locations — the
    // demo-switch dispose deletes it — the neighbor demos' soup commands
    // cover 3 locations → 2-4 dangle → every draw dropped). THE FIX: every
    // LEDGERED location whose last binding IS this buffer gets disabled —
    // the next command's own binds re-enable what it uses (bindVertexBuffer
    // enables unconditionally). The ledger is maintained at BIND time (the
    // post-delete GL query is ambiguous — see the declaration comment).
    for (const [location, boundId] of defaultAttribBindings) {
      if (boundId === bufferId) {
        gl.disableVertexAttribArray(location)
        defaultAttribBindings.delete(location)
        // Task 165 — the memo entry for a disarmed location is stale by
        // definition (its buffer is gone): drop it or the next bind with
        // the same tuple would skip arming a DISABLED location.
        vertexBindMemo.delete(location)
      }
    }
  }

  // ─── Task 132 — the TRANSFORM-FEEDBACK family ────────────────────────────
  // The GLSL twin of the WebGPU compute contract: a vertex-only program +
  // TF varyings (INTERLEAVED into ONE buffer) + the per-run inputs. The
  // state contract: RASTERIZER_DISCARD only between begin/endTransformFeedback,
  // the TF object + its buffer binding UNBOUND after the pass — the render
  // executor's per-draw state never sees the TF family.

  interface TransformPassRecord {
    readonly program: WebGLProgram
    readonly tf: WebGLTransformFeedback
    /** Task 132 — a DEDICATED VAO: the TF draws never touch the default
     *  vertex array's attrib bindings (the renderer's instance-attribute
     *  captures of the records buffer live there — WebGL2 forbids a TF
     *  output buffer overlapping ANY live vertex binding, and the strict
     *  drivers check the whole vertex array state, not just the enabled
     *  arrays). The pass binds ONLY its own attribute inputs here; the
     *  renderer re-binds its own per draw as always. */
    readonly vao: WebGLVertexArrayObject
    readonly uniforms: Map<string, WebGLUniformLocation | null>
    /** Attribute locations by declaration index (getAttribLocation) —
     *  Task 163: resolved LAZILY on the first run. getAttribLocation must
     *  come AFTER the link resolves (on an unlinked program it legally
     *  returns -1), and under KHR_parallel_shader_compile the link may
     *  still be in flight at creation time. */
    attribLocations: number[] | null
    /** The declared uniform layout (name + size), walked over the packed array. */
    readonly uniformDecl: readonly { readonly name: string; readonly size: 1 | 2 | 3 | 4 }[]
    /** The declared attribute layout (for runTransformPass's binds). */
    readonly attribDecl: readonly { readonly name: string; readonly size: number; readonly stride?: number; readonly offset?: number; readonly divisor?: number }[]
    /** The declared texture sampler names (units 0..N-1). */
    readonly textureDecl: readonly string[]
    /** Task 164 — THE PER-FIELD UNIFORM MEMO: the last uniform block's
     *  values (a COPY — the caller's scratch is reused and mutated between
     *  runs). The bitonic loop re-asserts the same frame-static block every
     *  pass with only (k, j) moving: the per-field compare emits exactly the
     *  changed uniforms (2 of ~6-8 per pass), the unchanged ones are skipped
     *  — program state persists, a re-assert writes the same bytes. The
     *  program is exclusively owned by this pass (no other path writes its
     *  uniforms), so the memo cannot go stale. */
    lastUniformData: Float32Array | null
    /** Task 164 — THE SAMPLER-UNIT MEMO: declaration slot i ALWAYS samples
     *  unit i (the run contract) — the uniform1i writes the UNIT INDEX, not
     *  the texture, so after the first run the value never changes and the
     *  call is pure redundancy (~178 per sort frame with textures bound).
     *  Reset only by a relink — which TF programs never do (they link once). */
    texUnits: (number | undefined)[]
  }
  const transformPasses = new Map<number, TransformPassRecord>()
  let nextTransformPass = 1
  /** The transform passes' program registry ALSO lives in `programs` (the
   *  useProgram cache + deleteProgram interplay stay coherent); this set
   *  marks which of them are TF passes (deleteTransformPass disposes the TF
   *  object too). */
  const transformProgramIds = new Set<number>()

  /** Task 168 — THE RESTORE WIRE: fresh facade state over a RESTORED context.
   *  After webglcontextlost + webglcontextrestored the raw context object is
   *  the SAME JS object, but every GL object it ever handed out (programs,
   *  buffers, textures, FBOs, TF objects) is DEAD — the Maps below would
   *  keep pointing at corpses while the ids stay "known", which is the exact
   *  silent-zombie shape (bindTexture finds the dead WebGLTexture, the GL
   *  ignores it, the canvas stays black while the loop counts frames). The
   *  reset returns the facade to its post-constructor state: Maps cleared,
   *  counters at zero, every memo/mirror disarmed. The CAP PROBES
   *  (anisoExt / parallelCompileExt / floatLinearExt) stay — they are
   *  properties of the CONTEXT (same renderer, same driver), not of the
   *  lost object population; the drawing-buffer notion (canvasWidth/Height)
   *  stays too — the bindTarget self-heal re-reads the real size on the
   *  next pass. Callers re-create resources afterwards (the session's
   *  journal replay; the executor's lazy program/buffer re-creation). */
  function resetAfterContextRestore(): void {
    programs.clear()
    pendingLinks.clear()
    buffers.clear()
    textures.clear()
    targets.clear()
    textureMeta.clear()
    textureViews.clear()
    nextTextureViewId = 1_000_000
    nextProgram = 1
    nextBuffer = 1
    nextTexture = 1
    nextTarget = 1
    defaultAttribBindings.clear()
    passVaoActive = false
    currentProgram = null
    currentProgramId = -1
    currentTarget = 0
    // Task 163/164/165 caches — every one of them mirrors state that died
    // with the context; leaving any armed would SKIP re-asserts against a
    // fresh context (the Task-75b regression class, now on the loss path).
    unitTextures.clear()
    unitBindCache.clear()
    invalidateVertexBinds()
    samplerUnits.clear()
    unpackAlignmentMirror = 0
    // Task 132 — the TF family: the passes' programs died with everything
    // else. The Map clear makes the stale pass ids UNKNOWN (the historical
    // unknown-id no-op), so a TF tier that survives a loss degrades
    // honestly (its rebuild is the tier owner's job — the renderer's
    // restore report names the boundary).
    transformPasses.clear()
    nextTransformPass = 1
    transformProgramIds.clear()
    transformPassIds.clear()
  }

  function createTransformPass(desc: {
    readonly vertex: string
    readonly outputs: readonly string[]
    readonly attributes?: readonly { readonly name: string; readonly size: number; readonly stride?: number; readonly offset?: number; readonly divisor?: number }[]
    readonly textures?: readonly string[]
    readonly uniforms?: readonly { readonly name: string; readonly size: 1 | 2 | 3 | 4 }[]
  }): number {
    // A vertex-only program with the TF varyings set BEFORE the link (the
    // WebGL2 contract: transformFeedbackVaryings must precede linkProgram).
    // The fragment stage is a trivial no-op — rasterization is discarded
    // during the pass, but a program still needs a fragment shader to link
    // on strict drivers. The vertex source carries the Task 161 nonce —
    // every TF link must be a program-binary cache MISS (the poison the
    // nonce defeats: TF_NONCE_SEED's comment above). Task 163: the link is
    // SUBMITTED here and resolved at the first run (or the first uniform)
    // — with KHR_parallel_shader_compile the whole tier's passes (the
    // gpuSim boot creates six back-to-back) link in PARALLEL on the
    // driver's background threads; the first run pays max(link), not the
    // sum. The attribute locations move to the first run with it.
    const program = gl.createProgram()
    gl.attachShader(program, compile(gl.VERTEX_SHADER, tfNoncedVertexSource(desc.vertex)))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision lowp float;\nvoid main() {}\n'))
    gl.transformFeedbackVaryings(program, desc.outputs as unknown as string[], gl.INTERLEAVED_ATTRIBS)
    gl.linkProgram(program)
    // Task 163 — register in the shared program registry (uniform-location
    // cache + useProgram coherence) and submit the link: WITHOUT the
    // extension this throws exactly at today's point (the TF object and VAO
    // below stay uncreated, the historical error path); WITH it the record
    // joins pendingLinks and the first run/uniform resolves.
    const programId = nextProgram++
    const programRecord: ProgramRecord = {
      program, uniforms: new Map(), label: 'transform pass',
      linkPending: false, linkError: null,
    }
    finishLinkSubmission(program, programRecord)
    const tf = gl.createTransformFeedback()
    const vao = gl.createVertexArray()
    const attribDecl = desc.attributes ?? []
    const record: TransformPassRecord = {
      program,
      tf,
      vao,
      uniforms: programRecord.uniforms,
      attribLocations: null,
      attribDecl,
      uniformDecl: desc.uniforms ?? [],
      textureDecl: desc.textures ?? [],
      lastUniformData: null,
      texUnits: [],
    }
    programs.set(programId, programRecord)
    transformProgramIds.add(programId)
    const id = nextTransformPass++
    transformPassIds.set(id, programId)
    transformPasses.set(id, record)
    return id
  }
  /** passId → the shared program registry id (useProgram cache coherence). */
  const transformPassIds = new Map<number, number>()

  /** One cached uniform location (the same probe/cache shape as `location`). */
  function tfLocation(record: TransformPassRecord, name: string): WebGLUniformLocation | null {
    const cached = record.uniforms.get(name)
    if (cached !== undefined) return cached
    const loc = gl.getUniformLocation(record.program, name)
    record.uniforms.set(name, loc)
    return loc
  }

  function runTransformPass(passId: number, vertexCount: number, output: {
    readonly bufferId: number
    readonly attribBuffers?: readonly (number | undefined)[]
    readonly textures?: readonly (number | undefined)[]
    readonly uniformData?: Float32Array
  }): void {
    const record = transformPasses.get(passId)
    if (record === undefined) {
      throw new Error(`rune: runTransformPass(${passId}) — no such transform pass`)
    }
    if (vertexCount <= 0) return
    const outBuffer = buffers.get(output.bufferId)
    if (outBuffer === undefined) {
      throw new Error(`rune: runTransformPass(${passId}, out ${output.bufferId}) — no such output buffer`)
    }
    // The program switch goes through the shared cache (the numeric
    // early-out + the current-program coherence with the render executor).
    // Task 163: useProgram resolves the deferred link FIRST — the pass's
    // attribute locations (below) and uniform locations may only be queried
    // on a fully linked program.
    const programId = transformPassIds.get(passId)
    if (programId !== undefined) useProgram(programId)
    else gl.useProgram(record.program) // defensive dead branch (programId is always set today)
    // THE DEDICATED VAO: the pass's draws see an EMPTY vertex array (plus
    // this pass's own attribute inputs, bound below) — the default VAO's
    // captured bindings (the renderer's instance attributes — possibly
    // THIS pass's output buffer!) are invisible and untouched. The WebGL2
    // rule (a TF output buffer must not overlap any vertex binding) is
    // satisfied by construction; the renderer re-binds its own per draw.
    gl.bindVertexArray(record.vao)
    // Task 137 — the pass VAO is current: bindVertexBuffer's location
    // bookkeeping stays OUT of the default VAO's ledger (the pass's
    // locations die with the pass; see deleteBuffer's disarm comment).
    passVaoActive = true
    // Task 163 — the attribute locations resolve LAZILY here (the link is
    // settled above; getAttribLocation before it would return -1 and
    // silently break the pass's inputs). Cached on the record after the
    // first run.
    let attribLocations = record.attribLocations
    if (attribLocations === null) {
      attribLocations = record.attribDecl.map(a => gl.getAttribLocation(record.program, a.name))
      record.attribLocations = attribLocations
    }
    // The attribute inputs: per-declaration-entry bufferId → the location
    // resolved at first run. bindVertexBuffer re-establishes enable + the
    // pointer + the divisor (the same path the render executor uses per
    // draw — the state after this pass is exactly what the executor fixes
    // up anyway, so no restore dance is needed for the ARRAY attributes).
    const ab = output.attribBuffers
    if (ab !== undefined) {
      for (let i = 0; i < attribLocations.length && i < ab.length; i++) {
        const bufferId = ab[i]
        if (bufferId === undefined) continue
        const a = record.attribDecl[i]
        bindVertexBuffer(bufferId, attribLocations[i]!, a.size, a.stride, a.offset, a.divisor)
      }
    }
    // The texture inputs: units 0..N-1 (bindTexture resets the LOD clamps
    // per call — the no-leak contract). THE SAMPLER UNIFORMS (Task 136 —
    // the WebGL2 black-screen root cause): GLSL sampler uniforms DEFAULT
    // TO UNIT 0, so a multi-texture pass (the pack pass's u_state/u_ramp)
    // silently sampled the WRONG texture — the ramp LUT lookups read the
    // STATE texture, the binary search over unsorted garbage extrapolated
    // halfExtent to full-screen quads with rgb up to ±23 (the white
    // flashes), and the records' colors came out wrong/negative (the
    // additive black screen). The DRAW path has always set its units
    // (the executor's setUniform1i); the TF family never did — single-
    // texture passes (u_state/u_pairs) worked only by the luck of the
    // default. Every declared sampler now gets its unit explicitly —
    // ON THE FIRST RUN (Task 164: the unit index for declaration slot i is
    // always i, the value never changes across runs, and program state
    // persists — the sampler-unit memo skips the redundant re-asserts).
    const tex = output.textures
    if (tex !== undefined) {
      for (let i = 0; i < record.textureDecl.length && i < tex.length; i++) {
        const textureId = tex[i]
        if (textureId === undefined) continue
        bindTexture(textureId, i)
        if (record.texUnits[i] !== i) {
          const loc = tfLocation(record, record.textureDecl[i])
          if (loc !== null) gl.uniform1i(loc, i)
          record.texUnits[i] = i
        }
      }
    }
    // The packed uniforms: uniform1f/2f/3f/4fv per the declared sequence.
    // Task 139 — THE PACKED-SLOT CONTRACT: an optimized-out uniform (the
    // compiler drops a declared-but-never-read one — the emit pass's
    // u_emitBase/u_emitCount, dead since gl_VertexID drives the rows)
    // still OCCUPIES its slots in the packed array: the offset advances
    // for EVERY declaration, set or skipped. The old `continue` skipped
    // the advance too — every uniform AFTER the dead pair read floats TWO
    // SLOTS EARLY (the whole block shifted: the newborn rows came out as
    // (seed−1.5, 0, 0) positions with the speed row's range for life and
    // the life row's range for size — giant garbage quads, the real-GPU
    // default-path freeze). A null location is a legal no-op target: the
    // uniform CALL is skipped, the slot WALK never is.
    // Task 164 — THE PER-FIELD MEMO: a field whose values are IDENTICAL to
    // the last run's is skipped (program state persists — the re-assert
    // would write the same bytes); the bitonic loop moves only (k, j), so
    // ~171 passes per frame emit exactly the two changed uniforms instead
    // of the whole block. A length change (a different packed layout)
    // falls back to the full emit; NaN fields compare unequal and emit
    // (conservative, never wrong).
    const data = output.uniformData
    if (data !== undefined) {
      let at = 0
      const last = record.lastUniformData
      const comparable = last !== null && last.length === data.length
      let changed = false
      for (const u of record.uniformDecl) {
        const loc = tfLocation(record, u.name)
        if (comparable) {
          let same = true
          for (let k = 0; k < u.size; k++) {
            if (last![at + k] !== data[at + k]) { same = false; break }
          }
          if (same) {
            at += u.size
            continue
          }
        }
        changed = true
        if (loc !== null) {
          if (u.size === 1) gl.uniform1f(loc, data[at] ?? 0)
          else if (u.size === 2) gl.uniform2f(loc, data[at] ?? 0, data[at + 1] ?? 0)
          else if (u.size === 3) gl.uniform3f(loc, data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0)
          else gl.uniform4f(loc, data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0, data[at + 3] ?? 0)
        }
        at += u.size
      }
      if (changed) record.lastUniformData = data.slice()
    }
    // THE PASS: rasterizer off, the TF object + the output buffer bound,
    // POINTS drawn, everything restored — the render executor's own state
    // assertions never observe the TF family (pinned by tests).
    gl.enable(gl.RASTERIZER_DISCARD)
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, record.tf)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, outBuffer)
    gl.beginTransformFeedback(gl.POINTS)
    gl.drawArrays(gl.POINTS, 0, vertexCount)
    gl.endTransformFeedback()
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null)
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
    gl.disable(gl.RASTERIZER_DISCARD)
    gl.bindVertexArray(null)
    passVaoActive = false
  }

  function deleteTransformPass(passId: number): void {
    const record = transformPasses.get(passId)
    if (record === undefined) return
    const programId = transformPassIds.get(passId)
    if (programId !== undefined) {
      // Task 163 — unhook the pending link before the registry drop.
      const programRecord = programs.get(programId)
      if (programRecord !== undefined) pendingLinks.delete(programRecord)
      if (currentProgramId === programId) {
        gl.useProgram(null)
        currentProgram = null
        currentProgramId = -1
      }
      programs.delete(programId)
      transformProgramIds.delete(programId)
    }
    gl.deleteTransformFeedback(record.tf)
    gl.deleteVertexArray(record.vao)
    gl.deleteProgram(record.program)
    transformPassIds.delete(passId)
    transformPasses.delete(passId)
  }

  function texSubImage2DBuffer(textureId: number, x: number, y: number, width: number, height: number, bufferId: number, byteOffset = 0): void {
    const texture = textures.get(textureId)
    if (texture === undefined) {
      throw new Error(`rune: texSubImage2DBuffer — no such texture ${textureId}`)
    }
    const buffer = buffers.get(bufferId)
    if (buffer === undefined) {
      throw new Error(`rune: texSubImage2DBuffer — no such buffer ${bufferId}`)
    }
    const pair = uploadPair(textureId)
    // Task 163 — the PBO path binds TEXTURE_2D to the CURRENT active unit:
    // the unit-bind mirror dies (the next bindTexture re-asserts honestly).
    // Task 164 — THE SCRATCH UPLOAD UNIT replaces that suicide: the bind
    // lands on the LAST unit (see uploadUnit's declaration), the mirror
    // entry for THAT unit alone is dropped, and units 0..N-2 stay valid —
    // the sort loop's per-pass bindTexture(pairsTex) becomes a cache HIT
    // instead of 4 real GL calls after every round-trip. The feedback-loop
    // ledger sees the real scratch binding (bindTarget/deleteTexture sweep
    // it like any other unit — more honest than the old invisible bind).
    gl.activeTexture(gl.TEXTURE0 + uploadUnit)
    unitBindCache.delete(uploadUnit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    unitTextures.set(uploadUnit, textureId)
    // The PBO contract: PIXEL_UNPACK_BUFFER bound, the offset into it as
    // the data pointer, UNPACK_ALIGNMENT pinned to 4 (rgba32f rows are
    // 16-byte aligned by construction — the row-alignment trap the WebGPU
    // tier already fixed once stays closed), the binding restored after.
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buffer)
    if (unpackAlignmentMirror !== 4) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      unpackAlignmentMirror = 4
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, pair.format, pair.type, byteOffset)
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null)
  }

  return {
    createProgram,
    useProgram,
    createBuffer,
    bindVertexBuffer,
    updateBuffer,
    readBuffer,
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
    createElementBuffer,
    drawElements,
    // Task 169 — the multi-draw tier: present IFF the context actually has
    // WEBGL_multi_draw (the executor arms the tier by this method's
    // PRESENCE — an always-present no-op would silently swallow every
    // batched draw on a context without the extension; this is exactly the
    // bug the first task165 run caught: 4 draws expected, 0 landed).
    ...(multiDrawExt !== null ? { multiDrawArraysInstanced } : {}),
    createTarget,
    bindTarget,
    readTargetPixels,
    deleteTexture,
    deleteTarget,
    deleteProgram,
    deleteBuffer,
    // Task 132 — the transform-feedback family (the GLSL compute twin)
    createTransformPass,
    runTransformPass,
    deleteTransformPass,
    texSubImage2DBuffer,
    // Task 168 — THE RESTORE WIRE
    resetAfterContextRestore,
  }
}
