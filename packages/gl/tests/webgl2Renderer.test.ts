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
})
