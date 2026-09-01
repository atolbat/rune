export type DepthFunc = 'never' | 'less' | 'equal' | 'lequal' | 'greater' | 'notequal' | 'gequal' | 'always'
export type CullFace = 'back' | 'front'
export type FrontFace = 'ccw' | 'cw'
export type BlendFactor =
  | 'zero' | 'one' | 'src-color' | 'one-minus-src-color'
  | 'src-alpha' | 'one-minus-src-alpha' | 'dst-color' | 'one-minus-dst-color'
export type PrimitiveKind = 'triangles' | 'triangle-strip' | 'lines' | 'points'
