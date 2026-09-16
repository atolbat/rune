import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer, createWebGpuRenderer } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createRecordingGPU } from '@rune/webgpu'
import type { Surface } from '../src/surface.ts'

/**
 * Task 220 — THE MSAA SURFACE (the field report's «одни лесенки» — the
 * walker's AA had died by construction: Task 219's single-pass present
 * moved the scene into the offscreen surface and retired every
 * antialiasing path with it).
 *
 * The surface's sample count at the unit level (the recording facades):
 *   · SurfaceOptions.samples rides BOTH renderers' surface() into
 *     facade createTarget (the samples= mark);
 *   · the exposed texture stays the RESOLVED 1x image (the presentation
 *     blit's source — the contract every reader already depends on);
 *   · the WG spec's no-depth-resolve law: samples > 1 + depthTexture is
 *     REFUSED LOUDLY on the WG leg (a silently unresolvable attachment
 *     would render undefined depth) — while the GL leg takes the combo
 *     (blitFramebuffer resolves depth — the documented asymmetry);
 *   · the capability door: 1x legs are bit-identical to the old shape
 *     (no samples mark — the legacy journal entries unchanged).
 *
 * The REAL resolve (the 4x render → the 1x texture — coverage values at
 * a triangle edge, the WG inline resolveTarget, the GL boundary blit) is
 * the browser gate's law (scripts/task220-local.mjs) — the container's
 * real GPUs are where pixels live.
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

describe('Task 220 — the MSAA surface', () => {
  describe('WebGPU (the recording facade)', () => {
    it('samples rides into createTarget (the samples= mark)', async () => {
      const recording = createRecordingGPU()
      const renderer = await createWebGpuRenderer({
        canvas: fakeCanvas(),
        createGPU: async () => recording.gpu,
        observeResize: false,
        now: () => 0,
        requestFrame: () => () => {},
      })
      const surface = renderer.surface({ width: 64, height: 48, depth: true, samples: 4 })
      expect(recording.calls.some(c => c.includes('createTarget(1,64,48,depth,samples=4)'))).toBe(true)
      // the exposed texture is the RESOLVED 1x image — the same shape every
      // reader (blit, read, sampler) already depends on
      expect(surface.texture.width).toBe(64)
      expect(surface.texture.height).toBe(48)
      renderer.stop()
    })

    it('samples > 1 + depthTexture is refused loudly (the spec has no depth resolve)', async () => {
      const recording = createRecordingGPU()
      const renderer = await createWebGpuRenderer({
        canvas: fakeCanvas(),
        createGPU: async () => recording.gpu,
        observeResize: false,
        now: () => 0,
        requestFrame: () => () => {},
      })
      expect(() => renderer.surface({ width: 64, height: 48, depth: true, depthTexture: true, samples: 4 }))
        .toThrow('no depth resolve')
      renderer.stop()
    })

    it('the facade door mirrors the refusal (createTarget itself)', () => {
      const recording = createRecordingGPU()
      const gl = recording.gpu
      const textureId = gl.createTexture(64, 48, 'canvas')
      const depthTextureId = gl.createTexture(64, 48, 'depth32float')
      expect(() => gl.createTarget(textureId, 64, 48, true, [0, 0, 0, 1], depthTextureId, 4))
        .toThrow('no depth resolve')
      // the 1x combo stays legal (the A6 harvest surface — the validation legs)
      expect(() => gl.createTarget(textureId, 64, 48, true, [0, 0, 0, 1], depthTextureId, 1)).not.toThrow()
    })

    it('a 1x surface is the legacy shape (no samples mark — the old journals unchanged)', async () => {
      const recording = createRecordingGPU()
      const renderer = await createWebGpuRenderer({
        canvas: fakeCanvas(),
        createGPU: async () => recording.gpu,
        observeResize: false,
        now: () => 0,
        requestFrame: () => () => {},
      })
      renderer.surface({ width: 64, height: 48, depth: true })
      expect(recording.calls.some(c => c.includes('createTarget(1,64,48,depth)') && !c.includes('samples='))).toBe(true)
      renderer.stop()
    })
  })

  describe('WebGL2 (the recording facade)', () => {
    it('samples rides into createTarget (the samples= mark)', () => {
      const recording = createRecordingGL()
      const renderer = createWebGL2Renderer({
        canvas: fakeCanvas(),
        createGL: () => recording.gl,
        observeResize: false,
        now: () => 0,
        requestFrame: () => () => {},
      })
      const surface: Surface<unknown> = renderer.surface({ width: 96, height: 64, depth: true, samples: 4 })
      expect(recording.calls.some(c => c.includes('createTarget(1,96,64,depth,samples=4)'))).toBe(true)
      expect(surface.texture.width).toBe(96)
      renderer.stop()
    })

    it('the GL leg takes samples + depthTexture (the blit resolves depth too)', () => {
      const recording = createRecordingGL()
      const renderer = createWebGL2Renderer({
        canvas: fakeCanvas(),
        createGL: () => recording.gl,
        observeResize: false,
        now: () => 0,
        requestFrame: () => () => {},
      })
      // the harvest surface at 4x: the boundary blit carries COLOR|DEPTH
      // into the caller's own textures — no refusal on this leg
      expect(() => renderer.surface({ width: 96, height: 64, depth: true, depthTexture: true, samples: 4 })).not.toThrow()
      expect(recording.calls.some(c => c.includes('depthTex=') && c.includes('samples=4'))).toBe(true)
      renderer.stop()
    })

    it('a 1x surface is the legacy shape (no samples mark)', () => {
      const recording = createRecordingGL()
      const renderer = createWebGL2Renderer({
        canvas: fakeCanvas(),
        createGL: () => recording.gl,
        observeResize: false,
        now: () => 0,
        requestFrame: () => () => {},
      })
      renderer.surface({ width: 96, height: 64, depth: true })
      expect(recording.calls.some(c => c.includes('createTarget(1,96,64,depth)') && !c.includes('samples='))).toBe(true)
      renderer.stop()
    })
  })
})
