/**
 * fullscreen.ts — fullscreen vertices for GPGPU passes and post-effects.
 *
 * Two representations of the same target:
 *  - fullscreenTriangle(): 3 vertices, triangle-list. A vertex extends
 *    beyond clip space, the GPU clips it itself: one triangle instead of
 *    two — one fewer vertex-shader invocation at the edge, no diagonal
 *    interpolation seam. A WebGPU idiom; works the same in WebGL2.
 *  - fullscreenQuad(): 4 vertices, triangle-strip — the canonical form of
 *    GPGPU demos (jbouny/fft-ocean, david.li/waves draw exactly this way).
 *
 * UV is computed in the shader as pos·0.5+0.5 — sufficient for sim passes
 * that read textures at texel centers (textureLoad/NEAREST).
 */

/** Fullscreen triangle (triangle-list): [-1,-1] [3,-1] [-1,3]. */
export function fullscreenTriangle(): Float32Array {
  return new Float32Array([-1.0, -1.0, 3.0, -1.0, -1.0, 3.0])
}

/** Fullscreen quad (triangle-strip): [-1,-1] [-1,1] [1,-1] [1,1]. */
export function fullscreenQuad(): Float32Array {
  return new Float32Array([-1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0])
}
