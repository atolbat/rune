/**
 * TextureView — a texture sub-region.
 *
 * Contract (see the design round "TextureView as a first-class citizen"):
 *  - WebGPU: a native GPUTextureView with origin/size — the GPU works with the sub-view
 *    as with a full-fledged texture. uvOffset=[0,0], uvScale=[1,1].
 *  - WebGL2: UV-rect emulation. textureId = the same as the parent's. uvOffset/uvScale
 *    are real, the shader must apply: `uv_final = uv * u_uvScale + u_uvOffset`.
 *
 * On both backends the user sees the same thing: { textureId, uvOffset, uvScale }.
 *
 * This is a **wrapper** over the existing Texture from @rune/gl. It does not break its API.
 * The user can use Texture directly (without a view) or create a view for a
 * sub-region. A View is a lightweight object (no separate GPU resource on WebGL2).
 */

export interface TextureViewDescriptor {
  /** Origin in pixels (top-left). */
  readonly origin?: { readonly x: number; readonly y: number; readonly z?: number }
  /** Region size. */
  readonly size?: { readonly width: number; readonly height: number; readonly depthOrArrayLayers?: number }
  /** How many mip levels to capture. Default 1. */
  readonly mipLevelCount?: number
}

export interface TextureView {
  /** ID for use in the command system. On WebGPU it is the native sub-view ID;
   *  on WebGL2 — the same ID as the parent's. */
  readonly textureId: number
  /** Region UV offset in normalized coordinates [u0, v0]. */
  readonly uvOffset: readonly [number, number]
  /** Region UV scale in normalized coordinates [u1-u0, v1-v0]. */
  readonly uvScale: readonly [number, number]
  /** Region size in pixels. */
  readonly width: number
  readonly height: number
  /** Diagnostic tag (dispose state). The optional field is declared
   *  in the interface so that the object literal in createTextureView passes
   *  the excess-property check (Task 71: tsc → 0). */
  readonly [Symbol.toStringTag]?: string
  /** Release the view. On WebGL2 — a no-op; on WebGPU — delete view. Idempotent. */
  dispose(): void
}

/** Minimal parent Texture interface for creating a view. */
export interface ViewableTexture {
  readonly textureId: number
  readonly width: number
  readonly height: number
}

/**
 * Creates a TextureView — a texture sub-region.
 *
 * On WebGL2 this is a pure CPU object: textureId is inherited from the parent, and
 * uvOffset/uvScale are computed from origin/size. The shader must support
 * `u_uvOffset`/`u_uvScale` uniforms.
 *
 * On WebGPU there could be a native implementation via gpu.createView(),
 * but in the current version of @rune/webgpu GPUFacade does not expose sub-views —
 * so the WebGPU path uses the same UV-rect emulation (functionally
 * identical, just without using WebGPU's native capability).
 *
 * Once GPUFacade gets createView(), a branch can be added here.
 */
export function createTextureView(parent: ViewableTexture, descriptor: TextureViewDescriptor = {}): TextureView {
  const origin = descriptor.origin ?? { x: 0, y: 0 }
  const size = descriptor.size ?? { width: parent.width, height: parent.height }
  const w = Math.max(1, size.width)
  const h = Math.max(1, size.height)

  // Bounds checks
  if (origin.x < 0 || origin.y < 0 || origin.x + w > parent.width || origin.y + h > parent.height) {
    throw new RangeError(
      `TextureView: region (${origin.x},${origin.y}+${w}x${h}) does not fit into texture ${parent.width}x${parent.height}`,
    )
  }

  // UV-rect in normalized coordinates. V (Y) is counted from the top
  // of the texture (image-space, as in @rune/prims/quad.ts: v=0 = the top row,
  // v grows downward). This matches the data layout on both backends:
  // WebGL2 (with flipY=false by default — see realGL.texImage2DFromSource)
  // and WebGPU (native top-left origin). Without this condition, region-based
  // sub-views would point at the wrong part of the atlas.
  const u0 = origin.x / parent.width
  const v0 = origin.y / parent.height
  const u1 = (origin.x + w) / parent.width
  const v1 = (origin.y + h) / parent.height

  let disposed = false
  return {
    textureId: parent.textureId, // on WebGL2 — the same; on WebGPU (if it were a sub-view) — different
    uvOffset: [u0, v0],
    uvScale: [u1 - u0, v1 - v0],
    width: w,
    height: h,
    dispose() {
      // The current implementation owns no separate GPU resource — a no-op.
      // Once a native WebGPU sub-view appears — deleteView goes here.
      disposed = true
    },
    get [Symbol.toStringTag]() { return disposed ? 'TextureView(disposed)' : 'TextureView' },
  }
}
