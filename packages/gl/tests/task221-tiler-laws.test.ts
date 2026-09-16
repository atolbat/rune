import { describe, expect, it } from 'bun:test'
import { createRealGL } from '@rune/webgl2'

/**
 * Task 221 — THE TILER LAWS (the third phone field report: «опять темный
 * экран на вебгпу, а на вебгл ничего не рендерится вообще»).
 *
 * The report's log carried TWO independent roots, both invisible to every
 * container gate (SwiftShader is an immediate-mode emulator — it survives
 * exactly the constructs the phone's tiler reads as garbage):
 *
 *   · GL — THE DEPTH-FORMAT PARITY: the boundary resolve blitted DEPTH
 *     from a DEPTH_COMPONENT24 4x renderbuffer into the caller's
 *     DEPTH_COMPONENT32F 1x texture. blitFramebuffer demands IDENTICAL
 *     depth formats — INVALID_OPERATION, and the whole blit (COLOR
 *     included) no-ops: both FBOs report COMPLETE (each is judged alone),
 *     the caller's texture never receives a pixel, the canvas shows an
 *     empty surface, the log only says so seconds later. THE LAW: one
 *     depth format for the whole target — the 4x twin rides the 1x
 *     side's own format (32f texture → 32f twin, depthBits pick → the
 *     same pick), so the blit is format-identical by construction.
 *
 *   · GL — THE CREATION-TIME RESOLVE PROBE: FBO completeness cannot see
 *     a refused blit (it judges each framebuffer alone — a driver can
 *     accept both storages and still refuse the resolve between them).
 *     THE LAW: a 1×1 dry-run of the exact resolve blit at creation —
 *     a driver that refuses it fails the boot LOUDLY (the caller's
 *     capability ladder re-boots the surface at 1x) instead of rendering
 *     blank frames forever.
 *
 * The WG root (storeOp:'discard' on a re-opened 4x surface — the
 * load-after-discard class) lives in realGPU's pass descriptor; the
 * recording facade cannot see it and SwiftShader cannot catch it, so its
 * laws are the source leg of the round's gate (scripts/task221-local.mjs)
 * — the mock here carries the GL twins only.
 */

// The GL constants the probed paths read (WebGL2 spec values).
const C = {
  FRAMEBUFFER: 36009,
  READ_FRAMEBUFFER: 36008,
  DRAW_FRAMEBUFFER: 36009,
  FRAMEBUFFER_COMPLETE: 36053,
  COLOR_ATTACHMENT0: 36064,
  DEPTH_ATTACHMENT: 36096,
  RENDERBUFFER: 36161,
  TEXTURE_2D: 3553,
  DEPTH_COMPONENT16: 33189,
  DEPTH_COMPONENT24: 33190,
  DEPTH_COMPONENT32F: 36012,
  RGBA8: 32856,
  COLOR_BUFFER_BIT: 16384,
  DEPTH_BUFFER_BIT: 256,
  NEAREST: 9729,
  INVALID_OPERATION: 0x502,
} as const

interface Probe {
  readonly calls: string[]
  /** The queued GL errors getError hands out (FIFO, then NO_ERROR). */
  errorQueue: number[]
  blitError: number
  readonly gl: WebGL2RenderingContext
}

/** The mock GL of the probed surface paths: a call log + error control. */
function probeGL(): Probe {
  const calls: string[] = []
  let texture = 0
  let fbo = 0
  let renderbuffer = 0
  const p: Probe = {
    calls,
    errorQueue: [],
    blitError: 0,
    gl: {
      // Constants that realGL reads from the context
      FRAMEBUFFER: C.FRAMEBUFFER,
      READ_FRAMEBUFFER: C.READ_FRAMEBUFFER,
      DRAW_FRAMEBUFFER: C.DRAW_FRAMEBUFFER,
      FRAMEBUFFER_COMPLETE: C.FRAMEBUFFER_COMPLETE,
      COLOR_ATTACHMENT0: C.COLOR_ATTACHMENT0,
      DEPTH_ATTACHMENT: C.DEPTH_ATTACHMENT,
      RENDERBUFFER: C.RENDERBUFFER,
      TEXTURE_2D: C.TEXTURE_2D,
      DEPTH_COMPONENT16: C.DEPTH_COMPONENT16,
      DEPTH_COMPONENT24: C.DEPTH_COMPONENT24,
      DEPTH_COMPONENT32F: C.DEPTH_COMPONENT32F,
      RGBA8: C.RGBA8,
      COLOR_BUFFER_BIT: C.COLOR_BUFFER_BIT,
      DEPTH_BUFFER_BIT: C.DEPTH_BUFFER_BIT,
      NEAREST: C.NEAREST,
      createTexture: () => ({ id: ++texture }),
      bindTexture: () => {},
      texImage2D: () => {},
      texParameteri: () => {},
      createFramebuffer: () => ({ id: ++fbo }),
      bindFramebuffer: (target: number, fb: unknown) =>
        calls.push(`bindFramebuffer(${target === C.READ_FRAMEBUFFER ? 'READ' : target === C.DRAW_FRAMEBUFFER ? 'DRAW' : 'FB'},${(fb as { id: number } | null)?.id ?? 'null'})`),
      framebufferTexture2D: () => {},
      createRenderbuffer: () => ({ id: ++renderbuffer }),
      bindRenderbuffer: () => {},
      renderbufferStorage: (target: number, format: number, w: number, h: number) =>
        calls.push(`renderbufferStorage(${format},${w}x${h})`),
      renderbufferStorageMultisample: (target: number, samples: number, format: number, w: number, h: number) =>
        calls.push(`renderbufferStorageMultisample(${samples},${format},${w}x${h})`),
      framebufferRenderbuffer: () => {},
      checkFramebufferStatus: () => C.FRAMEBUFFER_COMPLETE,
      blitFramebuffer: (sx0: number, sy0: number, sx1: number, sy1: number, dx0: number, dy0: number, dx1: number, dy1: number, mask: number, filter: number) => {
        calls.push(`blitFramebuffer(${sx1 - sx0}x${sy1 - sy0},${mask},${filter === C.NEAREST ? 'NEAREST' : filter})`)
        if (p.blitError !== 0) p.errorQueue.push(p.blitError)
      },
      getError: () => p.errorQueue.length > 0 ? p.errorQueue.shift()! : 0,
      deleteFramebuffer: () => {},
      deleteRenderbuffer: () => {},
      deleteTexture: () => {},
      viewport: () => {},
    } as unknown as WebGL2RenderingContext,
  }
  return p
}

/** Creates a realGL facade over the probe and boots the harvest surface's
 *  resources: the color texture + the DEPTH_COMPONENT32F harvest texture. */
function bootSurface(p: Probe, samples: number, opts: { depthTexture?: boolean; depthBits?: 16 | 24 | 32 } = {}) {
  const facade = createRealGL(p.gl)
  const textureId = facade.createTexture(64, 64)
  const depthTextureId = opts.depthTexture === false
    ? undefined
    : facade.createTexture(64, 64, { format: 'depth32f' })
  const targetId = facade.createTarget(textureId, 64, 64, true, [0, 0, 0, 1], opts.depthBits, depthTextureId, samples)
  return { facade, textureId, depthTextureId, targetId }
}

describe('Task 221 — the GL tiler laws (the phone report MSAA roots)', () => {
  it('THE PARITY LAW — the 4x depth twin rides the harvest texture\'s own 32f format', () => {
    const p = probeGL()
    bootSurface(p, 4)
    // THE LAW: the multisampled depth storage is DEPTH_COMPONENT32F — the
    // SAME format as the 1x resolve side's depth32f texture. The 220 shape
    // hardcoded DEPTH_COMPONENT24 here: both FBOs COMPLETE, every boundary
    // resolve blit INVALID_OPERATION (formats must match), the whole blit
    // no-ops, the canvas renders an empty surface forever.
    const msaaDepth = p.calls.filter(c => c.startsWith('renderbufferStorageMultisample(') && c.includes(String(C.DEPTH_COMPONENT32F)))
    expect(msaaDepth.length).toBe(1)
    expect(p.calls.some(c => c.startsWith('renderbufferStorageMultisample(') && c.includes(String(C.DEPTH_COMPONENT24))))
      .toBe(false)
  })

  it('THE PARITY LAW — the depthBits legs match too (16/24/32 on BOTH sides)', () => {
    for (const bits of [16, 24, 32] as const) {
      const p = probeGL()
      bootSurface(p, 4, { depthTexture: false, depthBits: bits })
      const want = bits === 16 ? C.DEPTH_COMPONENT16 : bits === 24 ? C.DEPTH_COMPONENT24 : C.DEPTH_COMPONENT32F
      // the 1x storage and the 4x twin carry the SAME format constant
      const one = p.calls.filter(c => c.startsWith(`renderbufferStorage(${want},`))
      const twin = p.calls.filter(c => c.startsWith('renderbufferStorageMultisample(') && c.includes(`,${want},`))
      expect(one.length).toBe(1)
      expect(twin.length).toBe(1)
    }
  })

  it('THE PROBE LAW — the creation-time dry-run blit rides the exact resolve shape', () => {
    const p = probeGL()
    bootSurface(p, 4)
    // exactly one dry-run blit at creation: 1×1, COLOR|DEPTH (the harvest
    // target resolves depth too), NEAREST (the only legal resolve filter)
    const blits = p.calls.filter(c => c.startsWith('blitFramebuffer('))
    expect(blits).toEqual([`blitFramebuffer(1x1,${C.COLOR_BUFFER_BIT | C.DEPTH_BUFFER_BIT},NEAREST)`])
  })

  it('THE PROBE LAW — a refused dry-run is a LOUD boot refusal (the ladder catches it)', () => {
    const p = probeGL()
    p.blitError = C.INVALID_OPERATION // the driver refuses the resolve blit
    expect(() => bootSurface(p, 4)).toThrow('the driver refused the multisample resolve blit')
  })

  it('THE PROBE LAW — a stale sticky error does not poison the verdict (drained first)', () => {
    const p = probeGL()
    p.errorQueue.push(C.INVALID_OPERATION) // an older op's sticky flag
    // the drain clears it, the probe's own blit is clean → the boot stands
    expect(() => bootSurface(p, 4)).not.toThrow()
    expect(p.calls.some(c => c.startsWith('blitFramebuffer('))).toBe(true)
  })

  it('THE 1x LAW — no probe, no twins (the legacy boot is untouched)', () => {
    const p = probeGL()
    bootSurface(p, 1)
    expect(p.calls.some(c => c.startsWith('renderbufferStorageMultisample('))).toBe(false)
    expect(p.calls.some(c => c.startsWith('blitFramebuffer('))).toBe(false)
  })
})
