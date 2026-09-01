/**
 * fullscreen.ts — полноэкранные вершины для GPGPU-проходов и пост-эффектов.
 *
 * Два представления одной цели:
 *  - fullscreenTriangle(): 3 вершины, triangle-list. Вершина выходит за
 *    клип-пространство, GPU клипует сам: один треугольник вместо двух —
 *    на один вызов меньше вершинного шейдера на границе, нет диагонального
 *    шва интерполяции. Идиома WebGPU; в WebGL2 работает так же.
 *  - fullscreenQuad(): 4 вершины, triangle-strip — каноническая форма
 *    GPGPU-демо (jbouny/fft-ocean, david.li/waves рисуют именно так).
 *
 * UV вычисляются в шейдере как pos·0.5+0.5 — для сим-проходов, читающих
 * текстуры по центрам текселей (textureLoad/NEAREST), этого достаточно.
 */

/** Полноэкранный треугольник (triangle-list): [-1,-1] [3,-1] [-1,3]. */
export function fullscreenTriangle(): Float32Array {
  return new Float32Array([-1.0, -1.0, 3.0, -1.0, -1.0, 3.0])
}

/** Полноэкранный квад (triangle-strip): [-1,-1] [-1,1] [1,-1] [1,1]. */
export function fullscreenQuad(): Float32Array {
  return new Float32Array([-1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0])
}
