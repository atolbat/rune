import { describe, expect, it } from 'bun:test'
import { compileStateProgram, createRecordingGL, createGLShadow } from '../src/index.ts'
import type { PipelineDesc } from '../src/index.ts'

describe('state program', () => {
  it('interpreter: applies only the differences from the shadow', () => {
    const { gl, calls } = createRecordingGL()
    const shadow = createGLShadow()
    const apply = compileStateProgram(
      { depth: { test: 'less', write: true }, raster: { cull: 'back' } },
      0,
      'interpret',
    )

    apply(gl, shadow)
    expect(calls).toEqual([
      'enableDepthTest', 'depthFunc(less)', 'depthMask(true)',
      'enableCull', 'cullFace(back)',
      'useProgram(0)',
    ])

    calls.length = 0
    apply(gl, shadow) // the state already matches — not a single call
    expect(calls).toEqual([])
  })

  it('codegen: behavior identical to the interpreter', () => {
    const pipeline: PipelineDesc = {
      depth: { test: 'less', write: true },
      blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' },
      raster: { cull: 'front', frontFace: 'cw' },
    }
    const interpret = compileStateProgram(pipeline, 3, 'interpret')
    const codegen = compileStateProgram(pipeline, 3, 'codegen')

    const a = createRecordingGL()
    const b = createRecordingGL()
    interpret(a.gl, createGLShadow())
    codegen(b.gl, createGLShadow())
    expect(a.calls).toEqual(b.calls)

    a.calls.length = 0
    b.calls.length = 0
    const shadowA = createGLShadow()
    const shadowB = createGLShadow()
    interpret(a.gl, shadowA)
    codegen(b.gl, shadowB)
    expect(a.calls).toEqual(b.calls)

    a.calls.length = 0 // the state is applied: a repeated diff must be empty
    b.calls.length = 0
    interpret(a.gl, shadowA)
    codegen(b.gl, shadowB)
    expect(a.calls).toEqual([])
    expect(b.calls).toEqual([])
  })

  it('depth: false — no depth calls', () => {
    const { gl, calls } = createRecordingGL()
    const apply = compileStateProgram({ depth: false }, 0, 'interpret')
    apply(gl, createGLShadow())
    expect(calls).toEqual(['useProgram(0)'])
  })
})
