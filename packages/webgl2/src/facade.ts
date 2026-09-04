// WebGL2 facade contract: fat operations, thin executor.

/** Source for atomic texture upload (no streaming/chunks).
 *  TexImageSource from lib.dom.d.ts (with OffscreenCanvas and VideoFrame when available). */
export type GLImageSource =
  | ImageBitmap
  | HTMLCanvasElement
  | HTMLImageElement
  | HTMLVideoElement
  | OffscreenCanvas
  // VideoFrame is only available with WebCodecs, but the TS type knows about it
  | (typeof globalThis extends { VideoFrame: infer V } ? V : never)

/** WebGL2 texture storage format (Task 67: HDR).
 *  'rgba8' (default) — internalFormat RGBA8, upload (RGBA, UNSIGNED_BYTE).
 *  'rgba16f' — RGBA16F, upload (RGBA, HALF_FLOAT): 8 bytes/pixel.
 *  'rgba32f' — RGBA32F, upload (RGBA, FLOAT): 16 bytes/pixel.
 *  Storing float textures is core WebGL2; linear filtering of rgba16f is core,
 *  rgba32f — OES_texture_float_linear (without it MIN_FILTER degrades to
 *  NEAREST); rendering TO a float target — EXT_color_buffer_float. */
export type GLTextureFormat = 'rgba8' | 'rgba16f' | 'rgba32f'

export interface GLFacade {
  createProgram(vertex: string, fragment: string): number
  useProgram(programId: number): void
  createBuffer(data: Float32Array): number
  /** M5 (Task 73): dynamic buffer update (feed dual-bind) —
   *  bufferSubData on top of the existing storage. The feed renderer
   *  calls it once per frame with a dirty range of records. */
  updateBuffer(bufferId: number, data: Float32Array, byteOffset?: number): void
  /** Bind a vertex attribute. stride/byteOffset (M5): interleaving of
   *  feed records — bindVertexBuffer(buf, loc, size, stride, offset)
   *  → vertexAttribPointer(loc, size, FLOAT, false, stride, offset).
   *  Default (undefined) — tight layout (stride 0, offset 0),
   *  backward compatibility.
   *  divisor (Task 75): 1 → vertexAttribDivisor(loc, 1) — the attribute
   *  is read once per INSTANCE (star quads from the feed); 0/undefined —
   *  regular per-vertex (backward compatibility). */
  bindVertexBuffer(bufferId: number, location: number, size: number, stride?: number, byteOffset?: number, divisor?: number): void
  setUniformMatrix4(programId: number, name: string, values: Float32Array): void
  setUniform4fv(programId: number, name: string, values: Float32Array): void
  setUniform3fv(programId: number, name: string, values: Float32Array): void
  setUniform2fv(programId: number, name: string, values: Float32Array): void
  setUniform1f(programId: number, name: string, value: number): void
  setUniform1i(programId: number, name: string, value: number): void
  /** Create a GPU texture.
   *
   *  options.mipLevels (default 1): the number of mip levels in the chain. If >1 —
   *  gl.texStorage2D(target, levels, internalFormat, w, h) is used
   *  (immutable storage; internalFormat matches options.format) and
   *  TEXTURE_MIN_FILTER = LINEAR_MIPMAP_LINEAR (minification picks a mip
   *  by distance). If 1 — a plain texImage2D level=0 with null (mutable
   *  storage), MIN_FILTER = LINEAR.
   *
   *  mipLevels is computed as 1 + floor(log2(min(w,h))). You can pass
   *  'auto' (via string — but the TS contract requires a number, so the user
   *  computes it themselves or uses the helper computeMipLevels(w, h)).
   *
   *  options.format (default 'rgba8', Task 67): storage format — 'rgba8' |
   *  'rgba16f' | 'rgba32f'. Affects the internalFormat of the allocation (texStorage2D
   *  / texImage2D-null) AND subsequent uploads: texImage2DFromSource /
   *  texSubImage2DFromSource / texImage2DLevel automatically derive the
   *  (format, type) pair from the texture's format (HALF_FLOAT / FLOAT) — WebGL2
   *  silently rejects mismatched combinations with GL_INVALID_OPERATION
   *  (the same trap as Task 64, now for HDR).
   *
   *  options.maxAnisotropy (default 1 for non-mip, anisoMax for mip): enable
   *  anisotropic filtering — the sampler takes several samples at different
   *  angles for better quality at oblique angles. Requires the
   *  EXT_texture_filter_anisotropic extension (caps.has('anisotropic')). Without the extension
   *  the option is ignored. Power of two: 1 (off), 2, 4, 8, 16 (max desktop).
   *  Only applied when mipLevels>1 (useless on non-mip).
   *
   *  Contract with texImage2DLevel: a texture with mipLevels=N expects
   *  levels 0..N-1 to be uploaded via texImage2DLevel(texId, level, src).
   *  texStorage2D guarantees that level L has size w/(2^L) × h/(2^L)
   *  — WebGL2 itself will check on texImage2D; if the source does not match —
   *  GL_INVALID_VALUE. */
  createTexture(
    width: number,
    height: number,
    options?: { mipLevels?: number; maxAnisotropy?: number; format?: GLTextureFormat },
  ): number
  /** Task 67/132: `bytes` — a Uint8Array for rgba8 textures, or a
   *  Float32Array VIEW when the texture's storage format is rgba32f (the
   *  WebGL2 rule: the view's element type must match the upload `type` —
   *  FLOAT demands Float32Array; a Uint8Array view over float bits is
   *  INVALID_OPERATION on strict drivers/ANGLE). */
  texSubImage2D(textureId: number, x: number, y: number, width: number, height: number, bytes: Uint8Array | Float32Array): void
  /** Atomic upload from bitmap/canvas/video — no streaming, a single call.
   *  Uses the texImage2D overload with TexImageSource (overwrites the texture).
   *
   *  flipY (default true): flip the source along Y on upload — gives
   *  parity with WebGPU (textureSample there uses a top-left origin).
   *  For WebGL2 without flip: canvas row 0 (top) → texture row 0 (V=0 = bottom
   *  in GL conventions) — i.e. the texture appears "upside down" on a cube.
   *  flipY=true via gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, true) before
   *  texImage2D, reset to false after — the state does not leak. */
  texImage2DFromSource(textureId: number, source: GLImageSource, options?: { flipY?: boolean }): void
  /** Upload a part of a texture (sub-region) from bitmap/canvas/video.
   *  Uses the texSubImage2D overload with TexImageSource. Does NOT overwrite
   *  the remaining pixels — only the region [x, y, x+w, y+h].
   *
   *  Used for:
   *   - runtime atlas packing (several bitmaps into one texture),
   *   - tile replacement (updating part of a map),
   *   - progressive loading (loading tiles as needed).
   *
   *  flipY (default true) — same as texImage2DFromSource. */
  texSubImage2DFromSource(textureId: number, x: number, y: number, source: GLImageSource, options?: { flipY?: boolean }): void
  /** Upload a specific mip level of a texture (level 0 = base, 1 = 1/2 size, etc.).
   *
   *  Uses the texImage2D overload with the level parameter: gl.texImage2D(target, level,
   *  internalFormat, format, type, source). Overwrites the specified mip entirely.
   *
   *  Mip-chain contract: for an N×N texture with mip chain levels=1+log2(N),
   *  each level L has size N/(2^L). WebGL2 requires all mips to be
   *  uploaded for a texture without FILTERING_MIPMAP, otherwise texture() in the shader returns
   *  black on minification.
   *
   *  Used by the MipStreamer for progressive mip upload (from small to large).
   *
   *  Strict format/type (Task 55): the optional internalFormat/format/type
   *  allow uploading HDR data (RGBA16F, RGBA32F) and non-standard types
   *  (HALF_FLOAT, FLOAT, UNSIGNED_INT_2_10_10_10_REV). Without the options —
   *  auto-derivation FROM THE TEXTURE FORMAT (Task 67): createTexture(...,{format:'rgba16f'})
   *  → (RGBA, HALF_FLOAT), {format:'rgba32f'} → (RGBA, FLOAT), otherwise —
   *  RGBA8/RGBA/UNSIGNED_BYTE. WebGL2 silently rejects mismatched pairs
   *  with GL_INVALID_OPERATION — auto-derivation closes this trap.
   *
   *  The texImage2D(source) overload contract requires format/type to be
   *  compatible with the texture's internalFormat (created via createTexture with
   *  gl.texStorage2D target internalFormat). For RGBA8 (default),
   *  RGBA/UNSIGNED_BYTE works; for RGBA16F — RGBA/HALF_FLOAT. A mismatch →
   *  GL_INVALID_ENUM / GL_INVALID_OPERATION (WebGL2 spec).
   *
   *  GLenum values are numbers (e.g. gl.RGBA8=0x8058, gl.RGBA=0x1908,
   *  gl.UNSIGNED_BYTE=0x1401, gl.HALF_FLOAT=0x140B, gl.FLOAT=0x1406).
   *  The user can pass either the numeric value or gl.RGBA8 if they
   *  have access to the context (via createGL injection). */
  texImage2DLevel(
    textureId: number,
    level: number,
    source: GLImageSource,
    options?: {
      flipY?: boolean
      /** internalFormat GLenum (default — from the texture's format). For example: gl.RGBA16F. */
      internalFormat?: number
      /** format GLenum (default — from the texture's format). For example: gl.RGBA. */
      format?: number
      /** type GLenum (default — from the texture's format). For example: gl.HALF_FLOAT. */
      type?: number
    },
  ): void
  /** Bind a texture (or a sub-mip view — Task 56) to a sampler unit.
   *
   *  id ∈ [1, 1M) — textureId (default view): the sampler sees the whole mip-chain
   *  with base=0 and max=meta.maxLoadedLevel (progressive streaming, see createTexture
   *  and texImage2DLevel).
   *
   *  id ∈ [1M, ∞) — viewId (sub-mip view, created via createTextureView):
   *  the sampler sees only the range [view.baseMipLevel,
   *  view.baseMipLevel + view.mipLevelCount - 1]. Implemented via
   *  gl.texParameteri(TEXTURE_BASE_LEVEL / TEXTURE_MAX_LEVEL).
   *
   *  No state-leak contract: on every bindTexture call BASE_LEVEL and
   *  MAX_LEVEL are reset/set anew. If a bind with viewId follows a
   *  bind with textureId (or vice versa) — the parameters do not leak between calls.
   *
   *  Disjoint id namespace (as in the WebGPU GPUFacade, see realGPU.ts:335):
   *  textureId and viewId never intersect. */
  bindTexture(textureOrViewId: number, unit: number): void
  /** Create a sub-mip-range view of a texture (Task 56: WebGL2 LOD-clamp API).
   *
   *  WebGL2 has no real GPUTextureView (like WebGPU). Emulated via the
   *  TEXTURE_BASE_LEVEL / TEXTURE_MAX_LEVEL texture parameters — applied
   *  in bindTexture on every id change (see the bindTexture contract).
   *
   *  Parity with WebGPU createTextureView:
   *   - baseMipLevel (default 0): the starting mip level of the view
   *   - mipLevelCount (default = texture.mipLevels - baseMipLevel): the number of
   *     mips in the view. The view sees the range [baseMipLevel, baseMipLevel +
   *     mipLevelCount - 1].
   *
   *  Constraints:
   *   - textureId must exist and have mipLevels ≥ 2 (otherwise the view
   *     makes no sense — the sampler only uses level 0 anyway).
   *   - baseMipLevel + mipLevelCount ≤ texture.mipLevels.
   *   - On violation throws an Error (actionable).
   *
   *  @returns viewId ≥ 1_000_000. Used in bindTexture(viewId, unit).
   *  @see bindTexture for the LOD-clamp semantics on bind. */
  createTextureView(
    textureId: number,
    options?: {
      baseMipLevel?: number
      mipLevelCount?: number
    },
  ): number
  setViewport(width: number, height: number): void
  setDepthMode(test: string, write: boolean): void
  setCull(mode: string): void
  /** Task 75: pipeline blending. src/dst — facade BlendFactor strings
   *  ('one', 'one-minus-src-alpha', ...); null/null — turn it off.
   *  Premultiplied shader output: additive = ('one','one'),
   *  classic transparency = ('one','one-minus-src-alpha'). */
  setBlend(src: string | null, dst: string | null, equation?: string): void
  clear(color: readonly [number, number, number, number] | readonly number[], depth: number | null): void
  drawArrays(mode: string, first: number, count: number, instances: number): void
  /** Render target: an FBO with a color texture (and optional depth).
   *  targetId 0 — the canvas (a built-in target, not created). */
  createTarget(
    textureId: number,
    width: number,
    height: number,
    depth: boolean,
    color: readonly [number, number, number, number],
  ): number
  /** Switch the target: 0 = the canvas. clear — clear the target with its color
   *  (ignored for the canvas: BeginPass clears the canvas). */
  bindTarget(targetId: number, clear: boolean): void
  /** Task 80 (readback): read the pixels of a TARGET (surface) — synchronously.
   *
   *  Parity contract with the GPU facade (Promise<Uint8Array>):
   *   - RGBA8, tight layout (rowBytes = width*4);
   *   - rows TOP-DOWN: data[0..3] = the top-left pixel — GL
   *     readPixels returns bottom-up (origin — the bottom-left corner), the facade
   *     flips the rows; WebGPU textures are already stored top-down —
   *     the same index = the same pixel on both backends;
   *   - the current FBO binding is saved and restored (state does not leak).
   *
   *  targetId 0 (the canvas) is not read — an honest Error (the WebGPU path cannot
   *  deterministically read the presented canvas — parity matters more than completeness);
   *  read the surface instead: renderer.surface(...) → capture/passes →
   *  surface.read(). Reads the contents AFTER the last executed frame
   *  (inside the frame callback — an intermediate state). */
  readTargetPixels(targetId: number): Uint8Array

  // ─── Task 132 — the TRANSFORM-FEEDBACK family ────────────────────────────
  // The GLSL twin of the WebGPU compute contract (@rune/webgpu's
  // createCompute): the SSBO-gather simulation runs as TF vertex passes on
  // WebGL2 — the SAME per-frame handoff (a packed uniform array, buffer
  // inputs, texture inputs) and the SAME output contract (a buffer the next
  // pass or the draw consumes directly). This is the "common point" the
  // GPGPU particle tier is built on: WebGPU = compute + storage buffers,
  // WebGL2 = transform feedback — one orchestrator (@rune/gl
  // createGpuParticles) drives both.

  /** Creates a transform-feedback pass: a vertex-only GLSL ES 3.00 program
   *  with its TF varyings (INTERLEAVED_ATTRIBS into ONE output buffer).
   *
   *  desc.vertex   — the GLSL source; it declares `out` varyings matching
   *                  desc.outputs, reads its per-vertex attribute inputs
   *                  (desc.attributes, bound by bufferId at run time),
   *                  texelFetch-s its texture inputs (desc.textures, bound
   *                  by textureId at run time) and its uniforms (packed
   *                  into ONE Float32Array at run time, walked per
   *                  desc.uniforms' declared sizes). gl_VertexID addresses
   *                  the pass's element.
   *  desc.outputs  — the TF varying names, in declaration order; the
   *                  interleaved output stride = the sum of their sizes.
   *  The fragment stage is a trivial `void main() {}` (rasterization is
   *  discarded during the pass — the rasterizer never runs it).
   *  NOT journaled (the same contract as the WebGPU compute family: the
   *  orchestrator recreates it on re-attach). */
  createTransformPass(desc: {
    readonly vertex: string
    readonly outputs: readonly string[]
    readonly attributes?: readonly { readonly name: string; readonly size: number; readonly stride?: number; readonly offset?: number; readonly divisor?: number }[]
    readonly textures?: readonly string[]
    readonly uniforms?: readonly { readonly name: string; readonly size: 1 | 2 | 3 | 4 }[]
  }): number

  /** Runs a transform-feedback pass: `vertexCount` vertices (POINTS), the
   *  outputs streamed into `output.bufferId` (a buffer created via
   *  createBuffer — its storage must cover vertexCount × the declared
   *  output stride).
   *
   *  The state contract (pinned by tests): the pass enables
   *  RASTERIZER_DISCARD, binds the TF object + its output buffer, binds the
   *  attribute/texture/uniform inputs, draws POINTS, and RESTORES — the TF
   *  object unbound, the TF buffer binding point cleared, RASTERIZER_DISCARD
   *  off, PIXEL_UNPACK_BUFFER untouched — so the render executor's own
   *  per-draw state assertions never see the pass.
   *  attribBuffers/textures are per-declaration-entry bufferIds/textureIds
   *  (undefined entries are skipped). uniformData is the packed float array
   *  (uniform1f/2f/3f/4fv per the declared {name, size} sequence). */
  runTransformPass(passId: number, vertexCount: number, output: {
    readonly bufferId: number
    readonly attribBuffers?: readonly (number | undefined)[]
    readonly textures?: readonly (number | undefined)[]
    readonly uniformData?: Float32Array
  }): void

  /** Deletes a transform pass (the program + the TF object). Idempotent. */
  deleteTransformPass(passId: number): void

  /** Task 132 — the PBO texture upload: texSubImage2D with the pixel source
   *  in a GL BUFFER (PIXEL_UNPACK_BUFFER) instead of a CPU array. The TF
   *  output of one pass becomes the texture the next pass samples — the
   *  GPU→GPU state round-trip with ZERO CPU traffic (the WebGL2 twin of the
   *  WebGPU storage-buffer ping-pong).
   *  The (format, type) pair derives from the TEXTURE's storage format (the
   *  Task 67 contract — rgba32f → RGBA/FLOAT). The buffer's contents from
   *  byteOffset are read as width×height tightly-packed texels. The
   *  PIXEL_UNPACK_BUFFER binding is saved and restored (no leak). */
  texSubImage2DBuffer(textureId: number, x: number, y: number, width: number, height: number, bufferId: number, byteOffset?: number): void

  // ─── Disposal (M1 §9.9 disposal discipline) ─────────────────────────────
  // Every delete* frees the GPU resource and removes the entry from the facade's
  // internal cache. A repeat call with the same id — a no-op (idempotence).
  // The runtime also writes a destroy-op to the Journal (if the facade is wrapped with withJournal).

  /** Delete a texture: gl.deleteTexture. Removes it from the textures Map.
   *  Also deletes ALL sub-mip views of this texture (created via
   *  createTextureView) — otherwise bindTexture(viewId) would keep working
   *  with a deleted texture (a silent no-op, but useless). */
  deleteTexture(textureId: number): void
  /** Delete a target: gl.deleteFramebuffer + (if it had depth) gl.deleteRenderbuffer.
   *  Does not touch the texture (it is a separate resource). Removes it from the targets Map. */
  deleteTarget(targetId: number): void
  /** Delete a program: gl.deleteProgram. Removes it from the programs Map. */
  deleteProgram(programId: number): void
  /** Delete a buffer: gl.deleteBuffer. Removes it from the buffers Map. */
  deleteBuffer(bufferId: number): void
  /** Delete a sub-mip view (created via createTextureView above).
   *  The default view (binding textureId directly in bindTexture) cannot be
   *  deleted by this method — it is managed via deleteTexture.
   *  Idempotent: a repeat deleteTextureView with the same id — a no-op.
   *
   *  After deleteTextureView: bindTexture(viewId, ...) — a no-op (the entry
   *  is not found, the sampler keeps its previous state). */
  deleteTextureView(viewId: number): void
}
