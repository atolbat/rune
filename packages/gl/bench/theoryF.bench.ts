import { webgl2Adapter } from '../src/index.ts'
import type { PortableSpec } from '../src/index.ts'
import { reflectGlsl } from '@rune/core'

/**
 * Теория F: кэш рефлексии шейдеров.
 * Гипотеза: команды массово делят шейдеры (материалы, инстансинг) — парсинг
 * исходника на каждую компиляцию лишний; кэш по исходнику превращает повторную
 * компиляцию в чтение карты. Сравниваем компиляцию N команд с уникальными
 * шейдерами (промахи) против N команд с общим шейдером (попадания).
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
    // salt гарантирует: прогоны «уникальных» партий не попадают в кэш повторно
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

for (let i = 0; i < 30; i++) { compileBatch(true, 1000 + i); compileBatch(false, 0) } // прогрев

const missMs = bestOfBatch(true, 9)
const hitMs = bestOfBatch(false, 9)

console.log('── Теория F: кэш рефлексии, компиляция 400 команд ──')
console.log(`компиляция с уникальными шейдерами : ${missMs.toFixed(2)} мс`)
console.log(`компиляция с общим шейдером        : ${hitMs.toFixed(2)} мс`)
console.log(`кэш ускоряет компиляцию в ${(missMs / hitMs).toFixed(1)} раза`)
console.log('выгодоприобретатель — replay (switchBackend/loss): повторная компиляция без парсинга')
