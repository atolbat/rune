/**
 * Матрицы 4×4, колонко-мажорные (как WebGL/WGSL): element[col*4 + row].
 * Все функции пишут в out и возвращают его; входы не мутируются.
 */

/** Аллоцирует новую матрицу 4×4 и заполняет единичной (gl-matrix-стиль). */
export function mat4Create(): Float32Array {
  return mat4Identity(new Float32Array(16))
}

/** Единичная матрица. */
export function mat4Identity(out: Float32Array): Float32Array {
  out.fill(0)
  out[0] = out[5] = out[10] = out[15] = 1
  return out
}

/** Трансляция. */
export function mat4Translation(out: Float32Array, x: number, y: number, z: number): Float32Array {
  mat4Identity(out)
  out[12] = x
  out[13] = y
  out[14] = z
  return out
}

/** Перспектива (OpenGL-конвенция, взгляд в −Z). */
export function mat4Perspective(
  out: Float32Array,
  fovy: number,
  aspect: number,
  near: number,
  far: number,
): Float32Array {
  const f = 1 / Math.tan(fovy / 2)
  out.fill(0)
  out[0] = f / aspect
  out[5] = f
  out[10] = (far + near) / (near - far)
  out[11] = -1
  out[14] = (2 * far * near) / (near - far)
  return out
}

/** Вращение вокруг X. */
export function mat4RotationX(out: Float32Array, angle: number): Float32Array {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  mat4Identity(out)
  out[5] = c
  out[6] = s
  out[9] = -s
  out[10] = c
  return out
}

/** Вращение вокруг Y. */
export function mat4RotationY(out: Float32Array, angle: number): Float32Array {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  mat4Identity(out)
  out[0] = c
  out[2] = -s
  out[8] = s
  out[10] = c
  return out
}

/** Произведение out = a · b (колонко-мажорное). Алиасинг безопасен:
 *  out === a и out === b дают результат отдельного out (REGRESSION «гиперкуба»:
 *  демо писало произведение в первый же операнд). */
export function mat4Multiply(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
  // a читается по всем колонкам, пока out пишется колонка за колонкой:
  // при out === a вход затирался бы на первой записи. b читается строго
  // перед записью своей колонки — алиасинг с b безопасен без копии.
  const left = out === a ? new Float32Array(a) : a
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4]
    const b1 = b[col * 4 + 1]
    const b2 = b[col * 4 + 2]
    const b3 = b[col * 4 + 3]
    out[col * 4] = left[0] * b0 + left[4] * b1 + left[8] * b2 + left[12] * b3
    out[col * 4 + 1] = left[1] * b0 + left[5] * b1 + left[9] * b2 + left[13] * b3
    out[col * 4 + 2] = left[2] * b0 + left[6] * b1 + left[10] * b2 + left[14] * b3
    out[col * 4 + 3] = left[3] * b0 + left[7] * b1 + left[11] * b2 + left[15] * b3
  }
  return out
}
