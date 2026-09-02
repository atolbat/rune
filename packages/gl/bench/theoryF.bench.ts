import { webgl2Adapter } from '../src/index.ts'
import type { PortableSpec } from '../src/index.ts'
import { reflectGlsl } from '@rune/core'

/**
 * Theory F: shader reflection cache.
 * Hypothesis: commands massively share shaders (materials, instancing) — parsing
 * the source on every compilation is redundant; a source-keyed cache turns
 * recompilation into a map lookup. We compare compiling N commands with unique
 * shaders (misses) vs N commands with a shared shader (hits).
 */

const BASE_VERT = `#version 300 es
in vec3 position;
uniform mat4 u_mvp;
uniform vec4 u_tint;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`

const BASE_FRAG = `#version 300 es
precision mediump float;
uniform float u_alpha;
out vec4 o; void main() { o = vec4(u_alpha); }`

const COMMANDS = 400

function specWith(fragSuffix: string): PortableSpec {
  return {
    shader: {
      glsl: { vertex: BASE_VERT, fragment: `${BASE_FRAG}\n// ${fragSuffix}` },
      wgsl: '',
    },
    uniforms: { u_alpha: 0.5 },
    count: 3,
  }
}

function compileBatch(unique: boolean, salt: number): void {
  const adapter = webgl2Adapter()
  const context = adapter.create()
  for (let i = 0; i < COMMANDS; i++) {
    // salt guarantees: "unique" batch runs do not hit the cache again
    const variant = unique ? `variant ${i}-${salt}` : 'shared'
    adapter.compile(context, specWith(variant))
  }
}

function bestOfBatch(unique: boolean, repeats: number): number {
  let best = Infinity
  for (let r = 0; r < repeats; r++) {
    const startedAt = performance.now()
    compileBatch(unique, r)
    const elapsed = performance.now() - startedAt
    if (elapsed < best) best = elapsed
  }
  return best
}

for (let i = 0; i < 30; i++) { compileBatch(true, 1000 + i); compileBatch(false, 0) } // warmup

const missMs = bestOfBatch(true, 9)
const hitMs = bestOfBatch(false, 9)

console.log('── Theory F: shader reflection cache, compiling 400 commands ──')
console.log(`compilation with unique shaders    : ${missMs.toFixed(2)} ms`)
console.log(`compilation with a shared shader   : ${hitMs.toFixed(2)} ms`)
console.log(`the cache speeds up compilation by a factor of ${(missMs / hitMs).toFixed(1)}`)
console.log('the beneficiary is replay (switchBackend/loss): recompilation without parsing')
