import { describe, expect, it } from 'bun:test'
import { makeQuadIndices, SOUP_STRIDE, VERTS_PER_PARTICLE, fillBillboards } from '../src/billboards.ts'
import { createParticleSystem } from '../src/system.ts'
import { CONSTANT_RAMP } from '../src/ramp.ts'

/** Task 180 — THE TEST KIT: expands the four-corner quad soup into the
 * pre-180 SIX-vertex stream — exactly what the shared static index pattern
 * draws ([0,1,2,0,2,3] per quad). The legacy pins in the suite below read
 * the EXPANSION, so their historical assertions keep pinning the same
 * bytes the GPU now assembles through the index buffer: the strongest form
 * of the "the drawn image cannot change" contract. */
export function expandQuadSoup(soup: Float32Array, vertexCount: number): Float32Array {
  const quads = Math.floor(vertexCount / VERTS_PER_PARTICLE)
  const out = new Float32Array(quads * 6 * SOUP_STRIDE)
  const idx = makeQuadIndices(quads)
  for (let j = 0; j < quads * 6; j++) {
    const src = idx[j] * SOUP_STRIDE
    const dst = j * SOUP_STRIDE
    for (let k = 0; k < SOUP_STRIDE; k++) out[dst + k] = soup[src + k]
  }
  return out
}

describe('Task 180 — the soup index tier (the test kit)', () => {
  it('makeQuadIndices: the pattern is [0,1,2,0,2,3] per quad, prefix-stable', () => {
    const p16 = makeQuadIndices(100)
    expect(p16).toBeInstanceOf(Uint16Array) // 400 verts ≤ 65536 → u16
    expect(p16.length).toBe(600)
    // quad 0 and quad 3: the same shape, offset by the quad's corner base
    for (const q of [0, 3, 99]) {
      const v = q * 4
      expect(Array.from(p16.slice(q * 6, q * 6 + 6))).toEqual([v, v + 1, v + 2, v, v + 2, v + 3])
    }
    // the 16384-quad boundary: 65536 verts — still Uint16; one quad more — Uint32
    expect(makeQuadIndices(16384)).toBeInstanceOf(Uint16Array)
    const p32 = makeQuadIndices(16385)
    expect(p32).toBeInstanceOf(Uint32Array)
    expect(p32.length).toBe(16385 * 6)
    const v = 16384 * 4
    expect(Array.from(p32.slice(16384 * 6, 16384 * 6 + 6))).toEqual([v, v + 1, v + 2, v, v + 2, v + 3])
  })

  it('makeQuadIndices: honest validation', () => {
    expect(() => makeQuadIndices(-1)).toThrow()
    expect(() => makeQuadIndices(2.5)).toThrow()
    expect(makeQuadIndices(0).length).toBe(0)
  })

  it('fillBillboards: FOUR unique corners; the expansion IS the pre-180 six-vert stream', () => {
    const ps = createParticleSystem(2)
    ps.emit(2, (i, out) => {
      out.x = 10 + i; out.y = 0; out.z = 0; out.vx = 0; out.vy = 0; out.vz = 0
      out.life = 1; out.size = 2; out.r = 0.5; out.g = 1; out.b = 0.25; out.a = 0.75
      out.seed = 0.125 * i; out.tx = 0; out.ty = 0; out.tz = 0
      void i
    })
    const soup = new Float32Array(2 * 4 * SOUP_STRIDE)
    const verts = fillBillboards(ps, { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] }, soup, { ramp: CONSTANT_RAMP })
    expect(verts).toBe(8) // 2 live × 4 unique corners
    // the four corners: (-1,-1), (1,-1), (1,1), (-1,1) around (10, 0, 0)
    expect(soup[0]).toBe(9); expect(soup[1]).toBe(-1)
    expect(soup[9 + 0]).toBe(11); expect(soup[9 + 1]).toBe(-1)
    expect(soup[18 + 0]).toBe(11); expect(soup[18 + 1]).toBe(1)
    expect(soup[27 + 0]).toBe(9); expect(soup[27 + 1]).toBe(1)
    // the uv corners: (0,0), (1,0), (1,1), (0,1)
    expect(soup[3]).toBe(0); expect(soup[4]).toBe(0)
    expect(soup[12]).toBe(1); expect(soup[13]).toBe(0)
    expect(soup[21]).toBe(1); expect(soup[22]).toBe(1)
    expect(soup[30]).toBe(0); expect(soup[31]).toBe(1)
    // THE EXPANSION CONTRACT: [0,1,2,0,2,3] over the corners — the exact
    // six-vertex stream the pre-180 baker wrote inline (the parity the
    // drawn image rides on). Corner 0 reappears at verts 3 and 4 is corner
    // 2 — the shared-triangle duplication, now done by the index pattern.
    const six = expandQuadSoup(soup, verts)
    expect(six.length).toBe(2 * 6 * SOUP_STRIDE)
    // Source position of corner c of quad q in the FOUR-vert soup.
    const src4 = (quad: number, corner: number) => quad * VERTS_PER_PARTICLE * SOUP_STRIDE + corner * SOUP_STRIDE
    // Vert j of quad q in the EXPANDED six-vert stream.
    const sixAt = (quad: number, j: number) => quad * 6 * SOUP_STRIDE + j * SOUP_STRIDE
    // The pattern's own order: [0, 1, 2, 0, 2, 3].
    const PATTERN = [0, 1, 2, 0, 2, 3]
    for (const quad of [0, 1]) {
      for (let j = 0; j < 6; j++) {
        expect(Array.from(six.slice(sixAt(quad, j), sixAt(quad, j) + 9)))
          .toEqual(Array.from(soup.slice(src4(quad, PATTERN[j]), src4(quad, PATTERN[j]) + 9)))
      }
      // the unique corners' uv signature: (1,0) at corner 1, (0,1) at corner 3
      expect(six[sixAt(quad, 1) + 3]).toBe(1); expect(six[sixAt(quad, 1) + 4]).toBe(0)
      expect(six[sixAt(quad, 5) + 3]).toBe(0); expect(six[sixAt(quad, 5) + 4]).toBe(1)
    }
  })
})
