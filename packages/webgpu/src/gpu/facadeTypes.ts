export type DepthFunc = 'never' | 'less' | 'equal' | 'lequal' | 'greater' | 'notequal' | 'gequal' | 'always'
export type CullFace = 'back' | 'front'
export type FrontFace = 'ccw' | 'cw'
export type BlendFactor =
  | 'zero' | 'one' | 'src-color' | 'one-minus-src-color'
  | 'src-alpha' | 'one-minus-src-alpha' | 'dst-color' | 'one-minus-dst-color'
  | 'dst-alpha' | 'one-minus-dst-alpha' | 'src-alpha-saturated'
/** The blend equation — the GPUBlendOperation names map 1:1. */
export type BlendEquation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max'
export type PrimitiveKind = 'triangles' | 'triangle-strip' | 'lines' | 'points'
