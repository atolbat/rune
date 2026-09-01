// @rune/math — колонко-мажорные матрицы 4×4 (WebGL-конвенция) для rune.
// out-первый стиль: результат пишется в переданный массив, ноль аллокаций.

export {
  mat4Create,
  mat4Identity,
  mat4Multiply,
  mat4Perspective,
  mat4RotationX,
  mat4RotationY,
  mat4Translation,
} from './mat4.ts'

// Task 81 (подготовка @rune/scene): аффинное произведение, lookAt, орто,
// обращения, TRS-композиция. Восстановлено по контракту tests/mat4Ext.test.ts.
export {
  mat4MultiplyAffine,
  mat4Invert,
  mat4InvertAffine,
  mat4LookAt,
  mat4Ortho,
  mat4FromQuatPosScale,
} from './mat4Ext.ts'

export {
  quatCreate,
  quatIdentity,
  quatNormalize,
  quatMultiply,
  quatAxisAngle,
  quatFromEulerYXZ,
  quatSlerp,
} from './quat.ts'
