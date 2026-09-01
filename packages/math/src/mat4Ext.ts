/**
 * Расширения mat4 (Task 81, подготовка @rune/scene; восстановлено после
 * утраты оригинала — контракт взят из tests/mat4Ext.test.ts).
 *
 * Все функции пишут в `out` (column-major, как gl-matrix) и возвращают его.
 * Эталоны тестов: gl-matrix-совместимые значения + геометрические инварианты.
 */

/** A·B, но с допущением аффинности нижней строки (0,0,0,1) — без перемножения 4-й строки/столбца. Алиасинг-safe: значения a кэшируются до записи в out. */
export function mat4MultiplyAffine(
  out: Float32Array,
  a: Float32Array,
  b: Float32Array,
): Float32Array {
  const a00 = a[0]!, a10 = a[1]!, a20 = a[2]!
  const a01 = a[4]!, a11 = a[5]!, a21 = a[6]!
  const a02 = a[8]!, a12 = a[9]!, a22 = a[10]!
  const a03 = a[12]!, a13 = a[13]!, a23 = a[14]!
  for (let col = 0; col < 3; col++) {
    const b0 = b[col * 4 + 0]!
    const b1 = b[col * 4 + 1]!
    const b2 = b[col * 4 + 2]!
    out[col * 4 + 0] = a00 * b0 + a01 * b1 + a02 * b2
    out[col * 4 + 1] = a10 * b0 + a11 * b1 + a12 * b2
    out[col * 4 + 2] = a20 * b0 + a21 * b1 + a22 * b2
    out[col * 4 + 3] = 0
  }
  const b0 = b[12]!, b1 = b[13]!, b2 = b[14]!
  out[12] = a00 * b0 + a01 * b1 + a02 * b2 + a03
  out[13] = a10 * b0 + a11 * b1 + a12 * b2 + a13
  out[14] = a20 * b0 + a21 * b1 + a22 * b2 + a23
  out[15] = 1
  return out
}

/**
 * Обращение ОБЩЕЙ матрицы 4×4 (адъюнкатный метод, как gl-matrix invert).
 * Вырожденная (det ~ 0) → в out пишется identity (graceful: не NaN, не throw).
 */
export function mat4Invert(out: Float32Array, m: Float32Array): Float32Array {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!

  const b00 = a00 * a11 - a01 * a10
  const b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11
  const b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30
  const b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31
  const b11 = a22 * a33 - a23 * a32

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) {
    // вырожденная: identity-фолбэк (контракт «не NaN, не throw»)
    out.fill(0)
    out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1
    return out
  }
  det = 1 / det

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
  return out
}

/**
 * Обращение АФФИННОЙ матрицы (TRS: поворот+масштаб+перенос, нижняя строка 0,0,0,1).
 * Быстрее общего обращения. Вырожденная → identity-фолбэк (контракт mat4Invert).
 */
export function mat4InvertAffine(out: Float32Array, m: Float32Array): Float32Array {
  // column-major: a[row][col] живёт в m[col*4+row]
  const a00 = m[0]!, a10 = m[1]!, a20 = m[2]!
  const a01 = m[4]!, a11 = m[5]!, a21 = m[6]!
  const a02 = m[8]!, a12 = m[9]!, a22 = m[10]!
  const det =
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20)
  if (Math.abs(det) < 1e-12) {
    out.fill(0)
    out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1
    return out
  }
  const inv = 1 / det

  // обратная 3×3 (row-major inv[row][col])
  const i00 = (a11 * a22 - a12 * a21) * inv
  const i01 = (a02 * a21 - a01 * a22) * inv
  const i02 = (a01 * a12 - a02 * a11) * inv
  const i10 = (a12 * a20 - a10 * a22) * inv
  const i11 = (a00 * a22 - a02 * a20) * inv
  const i12 = (a02 * a10 - a00 * a12) * inv
  const i20 = (a10 * a21 - a11 * a20) * inv
  const i21 = (a01 * a20 - a00 * a21) * inv
  const i22 = (a00 * a11 - a01 * a10) * inv

  // column-major раскладка: out[col*4+row] = inv[row][col]
  out[0] = i00; out[1] = i10; out[2] = i20; out[3] = 0
  out[4] = i01; out[5] = i11; out[6] = i21; out[7] = 0
  out[8] = i02; out[9] = i12; out[10] = i22; out[11] = 0

  // перенос: −R⁻¹·t
  const tx = m[12]!, ty = m[13]!, tz = m[14]!
  out[12] = -(i00 * tx + i01 * ty + i02 * tz)
  out[13] = -(i10 * tx + i11 * ty + i12 * tz)
  out[14] = -(i20 * tx + i21 * ty + i22 * tz)
  out[15] = 1
  return out
}

/** Матрица вида «камера смотрит из eye в center, up — вертикаль» (gl-matrix lookAt). */
export function mat4LookAt(
  out: Float32Array,
  eyeX: number, eyeY: number, eyeZ: number,
  centerX: number, centerY: number, centerZ: number,
  upX: number, upY: number, upZ: number,
): Float32Array {
  // z = normalize(eye − center) — камера смотрит против −Z
  let zx = eyeX - centerX, zy = eyeY - centerY, zz = eyeZ - centerZ
  let len = Math.hypot(zx, zy, zz) || 1
  zx /= len; zy /= len; zz /= len
  // x = normalize(up × z)
  let xx = upY * zz - upZ * zy
  let xy = upZ * zx - upX * zz
  let xz = upX * zy - upY * zx
  len = Math.hypot(xx, xy, xz)
  if (len) { xx /= len; xy /= len; xz /= len }
  // y = z × x
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0
  out[12] = -(xx * eyeX + xy * eyeY + xz * eyeZ)
  out[13] = -(yx * eyeX + yy * eyeY + yz * eyeZ)
  out[14] = -(zx * eyeX + zy * eyeY + zz * eyeZ)
  out[15] = 1
  return out
}

/** Ортографическая проекция (gl-matrix ortho): right/left по X, top/bottom по Y. */
export function mat4Ortho(
  out: Float32Array,
  left: number, right: number, bottom: number, top: number,
  near: number, far: number,
): Float32Array {
  const lr = 1 / (left - right)
  const bt = 1 / (bottom - top)
  const nf = 1 / (near - far)
  out[0] = -2 * lr
  out[1] = 0; out[2] = 0; out[3] = 0
  out[4] = 0
  out[5] = -2 * bt
  out[6] = 0; out[7] = 0
  out[8] = 0; out[9] = 0
  out[10] = 2 * nf
  out[11] = 0
  out[12] = (left + right) * lr
  out[13] = (top + bottom) * bt
  out[14] = (far + near) * nf
  out[15] = 1
  return out
}

/** Композиция TRS: кватернион (x,y,z,w) развёрнут, затем перенос и масштаб. */
export function mat4FromQuatPosScale(
  out: Float32Array,
  x: number, y: number, z: number, w: number,
  tx: number, ty: number, tz: number,
  sx: number, sy: number, sz: number,
): Float32Array {
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2

  out[0] = (1 - (yy + zz)) * sx
  out[1] = (xy + wz) * sx
  out[2] = (xz - wy) * sx
  out[3] = 0
  out[4] = (xy - wz) * sy
  out[5] = (1 - (xx + zz)) * sy
  out[6] = (yz + wx) * sy
  out[7] = 0
  out[8] = (xz + wy) * sz
  out[9] = (yz - wx) * sz
  out[10] = (1 - (xx + yy)) * sz
  out[11] = 0
  out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1
  return out
}
