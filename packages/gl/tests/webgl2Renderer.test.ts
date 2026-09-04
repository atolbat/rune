import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'

/** createWebGL2Renderer: auto-loop, resize/DPR, streaming idle slot. */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

describe('createWebGL2Renderer', () => {
  it('step drives a frame: clear + draw, uniforms by name', () => {
    const { gl, calls } = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })

    const VERT = `#version 300 es
layout(location = 0) in vec3 position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`
    const FRAG = `#version 300 es
precision mediump float;
uniform vec4 u_tint;
out vec4 o_color;
void main() { o_color = u_tint; }`
    const command = renderer.command({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_tint: [1, 0.5, 0.25, 1] },
      count: 3,
    })
    renderer.frame((_ctx, record) => record(command, {}))
    renderer.step(16)

    expect(calls.some(call => call.startsWith('clear('))).toBe(true)
    expect(calls).toContain('drawArrays(triangles,0,3,1)')
    expect(calls).toContain('uniform4fv(u_tint)')
    expect(calls[0]).toBe('setViewport(800,600)')
    renderer.stop()
  })

  it('resize is idempotent: the same CSS size does not touch the viewport', () => {
    const { gl, calls } = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      dpr: 2,
      createGL: () => gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const viewports = () => calls.filter(call => call.startsWith('setViewport(')).length
    const before = viewports()
    renderer.resize(800, 600) // the same size
    expect(viewports()).toBe(before)
    renderer.resize(400, 300) // new CSS → an 800×600 buffer at dpr=2
    expect(calls).toContain('setViewport(1600,1200)')
    expect(calls).toContain('setViewport(800,600)')
    renderer.stop()
  })

  it('uploads run in the idle slot after the frame', () => {
    const { gl } = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    let ran = 0
    renderer.uploads.push({ bytes: 1, priority: 1, run: () => { ran++ } })
    expect(ran).toBe(0) // before the frame — silent
    renderer.step(16)
    expect(ran).toBe(1) // after the frame — idle slot
    renderer.stop()
  })

  it('a 1024² texture is uploaded ENTIRELY in the first idle slot (theory N)', () => {
    const { gl, calls } = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const texture = renderer.texture(1024, 1024)
    texture.upload(new Uint8Array(1024 * 1024 * 4))
    renderer.step(16)

    // Call order on the recorder: the preview first, everything — in the first frame
    const tiles = calls.filter(call => call.startsWith('texSubImage2D('))
    expect(tiles.length).toBe(65) // a 128×128 preview + 64 tiles
    expect(tiles[0]).toBe('texSubImage2D(1,0,0,128,128)')

    // Coverage: tiles as full rows, 1024 rows without holes or overlaps
    const rows = new Set<number>()
    for (const call of tiles.slice(1)) {
      const match = /^texSubImage2D\(\d+,(\d+),(\d+),(\d+),(\d+)\)$/.exec(call)
      expect(match).not.toBeNull()
      const x = Number(match![1]), y = Number(match![2]), w = Number(match![3]), h = Number(match![4])
      expect(x).toBe(0) // full width — rows
      expect(w).toBe(1024)
      for (let row = y; row < y + h; row++) {
        expect(rows.has(row)).toBe(false) // no overlaps
        rows.add(row)
      }
    }
    expect(rows.size).toBe(1024)

    renderer.step(32) // second frame: no new uploads — the texture is already complete
    expect(calls.filter(call => call.startsWith('texSubImage2D(')).length).toBe(65)
    renderer.stop()
  })

  it('transients is available and does not grow between frames (idea No. 2)', () => {
    const { gl } = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    renderer.frame(() => { renderer.transients.f32(16) }) // one callback, not accumulating
    for (let frame = 0; frame < 20; frame++) {
      renderer.step(16 + frame * 16)
    }
    const stats = renderer.transients.stats()
    expect(stats.created).toBe(2) // one length × depth=2 frames — flat
    expect(stats.frames).toBe(20)
    renderer.stop()
  })

  // Task 129 — the live report: "WebGL at some point starts drawing
  // everything in the bottom-left corner, as if the canvas shrank 4x".
  // The per-frame canvas-state check must adopt an external drawing-buffer
  // move (anything wrote canvas.width behind our resize) and re-sync the
  // viewport — once, not every frame.
  it('Task 129: an external canvas.width write is healed — the viewport re-syncs, once', () => {
    const { gl, calls } = createRecordingGL()
    const errors: string[] = []
    const canvas = fakeCanvas()
    const renderer = createWebGL2Renderer({
      canvas,
      createGL: () => gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      onGlError: message => errors.push(message),
    })
    renderer.step(16) // a normal frame — nothing to heal
    expect(errors.length).toBe(0)

    canvas.width = 1234 // an external write (browser/extension/driver path)
    renderer.step(32)
    expect(calls).toContain('setViewport(1234,600)')
    expect(errors.some(message => message.includes('canvas state heal'))).toBe(true)

    const heals = errors.length
    renderer.step(48) // adopted — quiet now
    expect(errors.length).toBe(heals)
    renderer.stop()
  })

  it('Task 129: a DPR change without a CSS change re-derives the buffer (the live-DPR poll)', () => {
    const { gl, calls } = createRecordingGL()
    const canvas = fakeCanvas()
    const windowRef = (globalThis as Record<string, unknown>).window as { devicePixelRatio: number } | undefined
    // a fake live DPR: bun tests have no window — install one for the poll
    const hadWindow = windowRef !== undefined
    const hadDpr = windowRef?.devicePixelRatio
    ;(globalThis as Record<string, unknown>).window = { devicePixelRatio: 2 }
    try {
      const renderer = createWebGL2Renderer({
        canvas,
        createGL: () => gl,
        observeResize: false,
        now: () => 0,
        requestFrame: () => () => {},
        onGlError: () => {},
      })
      // boot: no window yet? — the boot read sees dpr 2 (canvasDpr reads window)
      const bootViewports = calls.filter(call => call.startsWith('setViewport(')).length
      expect(bootViewports).toBe(1)
      expect(calls[0]).toBe('setViewport(1600,1200)') // 800×600 CSS × 2
      // the DPR moves 2 → 3 WITHOUT any CSS change; the poll fires every 64 frames
      ;(globalThis as unknown as { window: { devicePixelRatio: number } }).window.devicePixelRatio = 3
      for (let frame = 0; frame < 64; frame++) renderer.step(16)
      expect(calls).toContain('setViewport(2400,1800)') // re-derived at the live DPR
      renderer.stop()
    } finally {
      if (hadWindow) {
        ;(globalThis as Record<string, unknown>).window = windowRef
        if (hadDpr !== undefined) windowRef!.devicePixelRatio = hadDpr
      } else {
        delete (globalThis as Record<string, unknown>).window
      }
    }
  })
})
