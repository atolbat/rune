/**
 * FFT Стокхэма — РЕЦЕПТ kit (Task 112).
 *
 * Решение пользователя Task 112: «FFT не должен быть в ядре. В ките или ещё
 * где — да. Но там явно есть полезные паттерны, что можно оставить в ядре».
 * Паттерны (halfFloat-кодек, pingPong, формат-тиры) уехали в @rune/core;
 * сам FFT — рецепт kit: чистое расписание проходов + дуал-соурс чанки
 * (GLSL/WGSL с одинаковыми именами — досье §10.3 «Kit — библиотека
 * дуал-соурс чанков и рецептов»).
 *
 * Что здесь:
 *  • fft2dPasses(resolution) — ПЛАН 2D-БПФ Стокхэма: 2·log₂N проходов
 *    (N/2 горизонтальных + N/2 вертикальных), ping-pong parity, размер
 *    подтрансформации 2^k. Чистая функция — бэкенд-агностична: вызывающий
 *    мапит 'a'/'b'/'result' на свои текстуры и биндит чанк шейдера.
 *  • FFT_GLSL_SUBTRANSFORM / FFT_WGSL_SUBTRANSFORM — один и тот же проход
 *    сабтрансформации на двух языках: четыре комплексных числа в RGBA
 *    (две последовательности трансформируются одновременно — как в
 *    david.li/waves), ось — юниформом (одна программа на обе оси — вместо
 *    двух #define-вариантов демо), вход — u_input.
 *
 * Контракт прохода (оба бэкенда):
 *   uniforms: u_transformSize (N), u_subtransformSize (2^k), u_horizontal (0|1)
 *   texture:  u_input (RGBA, NEAREST-семантика: чтение по центрам текселей)
 *   output:   текущая цель рендера N×N
 */

/** Один проход БПФ из плана. */
export interface FftPass {
  /** Индекс прохода (0 .. 2·log₂N-1). */
  readonly index: number
  /** Ось: первая половина — строки (horizontal), вторая — столбцы. */
  readonly axis: 'horizontal' | 'vertical'
  /** Размер подтрансформации 2^k (k = 1..log₂N). */
  readonly subtransformSize: number
  /** Откуда ЧИТАТЬ: 'a'/'b' — ping-pong пара, 'spectrum' — вход плана. */
  readonly input: 'spectrum' | 'a' | 'b'
  /** Куда ПИСАТЬ: 'a'/'b' — ping-pong пара, 'result' — финальный выход. */
  readonly output: 'a' | 'b' | 'result'
}

/**
 * План 2D-БПФ Стокхэма для сетки resolution×resolution (степень двойки).
 *
 * Выводит ту же последовательность, что цикл демо david.li/waves:
 *   i=0            : spectrum → a
 *   i нечёт        : a → b
 *   i чёт (внутри) : b → a
 *   i=последний    : (по parity) a|b → result
 *   на i=iterations/2 ось меняется horizontal → vertical
 *   subtransformSize = 2^((i mod N/2·log₂… см. код) + 1)
 *
 * Пример (N=4, 4 прохода): [h:2 spec→a] [h:4 a→b] [v:2 b→a] [v:4 a→res].
 */
export function fft2dPasses(resolution: number): readonly FftPass[] {
  if (resolution < 2 || (resolution & (resolution - 1)) !== 0) {
    throw new Error(`fft2dPasses: resolution должен быть степенью двойки ≥ 2, получено ${resolution}`)
  }
  const logN = Math.round(Math.log2(resolution))
  const iterations = logN * 2
  const half = iterations / 2
  const passes: FftPass[] = []
  for (let i = 0; i < iterations; i++) {
    const axis: FftPass['axis'] = i < half ? 'horizontal' : 'vertical'
    const subtransformSize = Math.pow(2, (i % half) + 1)
    let input: FftPass['input']
    let output: FftPass['output']
    if (i === 0) {
      input = 'spectrum'
      output = 'a'
    } else if (i === iterations - 1) {
      // Чётность (iterations-1) после i=0 (spec→a): нечётные пишут в b…
      // Последний вход — по parity: повторяет логику демо
      // (iterations % 2 === 0 ? PING : PONG) при ping=a, pong=b.
      input = iterations % 2 === 0 ? 'a' : 'b'
      output = 'result'
    } else if (i % 2 === 1) {
      input = 'a'
      output = 'b'
    } else {
      input = 'b'
      output = 'a'
    }
    passes.push({ index: i, axis, subtransformSize, input, output })
  }
  return passes
}

/** GLSL ES 3.00-проход сабтрансформации (фрагмент). Ось — юниформом:
 *  одна программа на обе оси (в демо — два #define-варианта; здесь —
 *  половина компиляций). Полноэкранный треугольник — из gl_VertexID
 *  (см. fullscreenPass.ts), вершинный буфер не нужен. */
export const FFT_GLSL_SUBTRANSFORM = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_input;
uniform float u_transformSize;
uniform float u_subtransformSize;
uniform float u_horizontal;

out vec4 outColor;

vec2 multiplyComplex(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.y * b.x + a.x * b.y);
}

void main() {
  float index = mix(gl_FragCoord.y, gl_FragCoord.x, u_horizontal) - 0.5;
  float evenIndex = floor(index / u_subtransformSize) * (u_subtransformSize * 0.5)
                  + mod(index, u_subtransformSize * 0.5);

  // transform two complex sequences simultaneously
  float halfN = u_transformSize * 0.5;
  vec2 samplePos = mix(
    vec2(evenIndex + 0.5, gl_FragCoord.y),
    vec2(gl_FragCoord.x, evenIndex + 0.5),
    u_horizontal
  ) / u_transformSize;
  vec4 even = texture(u_input, samplePos);
  vec4 odd = texture(u_input, samplePos + vec2(mix(halfN, 0.0, u_horizontal),
                                               mix(0.0, halfN, u_horizontal)) / u_transformSize);

  float twiddleArgument = -2.0 * 3.14159265359 * (index / u_subtransformSize);
  vec2 twiddle = vec2(cos(twiddleArgument), sin(twiddleArgument));

  outColor = vec4(even.xy + multiplyComplex(twiddle, odd.xy),
                  even.zw + multiplyComplex(twiddle, odd.zw));
}
`

/** WGSL-проход сабтрансформации (фрагмент; вершина — fullscreenPass-чанк).
 *  textureLoad вместо texture2D: сим-проходы читают точно по центрам
 *  текселей (NEAREST-семантика побитово; david.li/waves-порты). */
export const FFT_WGSL_SUBTRANSFORM = /* wgsl */ `
struct FftUniforms {
  u: vec4f, // x: transformSize, y: subtransformSize, z: horizontal, w: —
}

@group(0) @binding(0) var<uniform> uni: FftUniforms;
@group(0) @binding(1) var srcTex: texture_2d<f32>;

fn multiplyComplex(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.y * b.x + a.x * b.y)
}

fn glMod(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y)
}

@fragment
fn fsMain(vout: VsOut) -> @location(0) vec4f {
  let PI = 3.14159265359
  let transformSize = uni.u.x
  let subtransformSize = uni.u.y
  let horizontal = uni.u.z > 0.5

  let index = select(vout.coord.y * transformSize - 0.5, vout.coord.x * transformSize - 0.5, horizontal)
  let evenIndex = floor(index / subtransformSize) * (subtransformSize * 0.5) + glMod(index, subtransformSize * 0.5)

  // transform two complex sequences simultaneously
  let halfN = transformSize * 0.5
  var even: vec4f
  var odd: vec4f
  if (horizontal) {
    even = textureLoad(srcTex, vec2i(evenIndex + 0.5, vout.pos.y), 0)
    odd = textureLoad(srcTex, vec2i(evenIndex + halfN + 0.5, vout.pos.y), 0)
  } else {
    even = textureLoad(srcTex, vec2i(vout.pos.x, evenIndex + 0.5), 0)
    odd = textureLoad(srcTex, vec2i(vout.pos.x, evenIndex + halfN + 0.5), 0)
  }

  let twiddleArgument = -2.0 * PI * (index / subtransformSize)
  let twiddle = vec2f(cos(twiddleArgument), sin(twiddleArgument))

  let outputA = even.xy + multiplyComplex(twiddle, odd.xy)
  let outputB = even.zw + multiplyComplex(twiddle, odd.zw)

  return vec4f(outputA, outputB)
}
`
