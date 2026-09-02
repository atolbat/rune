// @rune/math — column-major 4×4 matrices (the WebGL convention) for rune.
// out-first style: the result is written into the passed array, zero allocations.

export {
  mat4Create,
  mat4Identity,
  mat4Multiply,
  mat4Perspective,
  mat4RotationX,
  mat4RotationY,
  mat4Translation,
} from './mat4.ts'

// Task 81 (preparing @rune/scene): affine product, lookAt, ortho,
// inversions, TRS composition. Restored per the tests/mat4Ext.test.ts contract.
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
