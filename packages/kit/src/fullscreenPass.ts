/**
 * Полноэкранный проход — дуал-соурс чанк kit (Task 112).
 *
 * Отвечает на вопрос Task 112 «зачем ещё одна сущность?» — НИКАКАЯ сущность
 * не нужна: полноэкранный треугольник ГЕНЕРИРУЕТСЯ САМ ШЕЙДЕРОМ из
 * vertex_index (gl_VertexID / @builtin(vertex_index)) — без примитива, без
 * вершинного буфера, без атрибутов. Это техничный стандарт GPU-практики
 * (три вершины из арифметики по индексу покрывают клип-пространство).
 *
 * Досье §10.3: kit — «библиотека дуал-соурс чанков (пары GLSL/WGSL с
 * одинаковыми именами) и рецептов: фуллскрин-треугольник, blur, …» —
 * этот чанк и есть тот самый «фуллскрин-треугольник».
 *
 * Два имени одной семантики:
 *  • GL: drawArrays(TRIANGLES, first=0, count=3) — вершины из gl_VertexID;
 *  • WebGPU: draw(vertexCount=3) — вершины из @builtin(vertex_index).
 *
 * UV: вершина 0 → (0,0), 1 → (2,0), 2 → (0,2) — интерполяция даёт
 * корректные UV внутри фрустума; за пределами треугольник клипуется.
 * Позиции: x = 4·(i==1) - 1, y = 4·(i==2) - 1 — классический
 * oversized-треугольник (без «шва» на диагонали квада).
 *
 * Использование: вставьте чанк ПЕРЕД своим @fragment (WGSL) или склейте
 * с фрагментным шейдером (GLSL, ES 3.00). VsOut/vout — общая структура.
 */

/** GLSL ES 3.00: полноэкранный треугольник из gl_VertexID. */
export const FULLSCREEN_PASS_GLSL = /* glsl */ `#version 300 es
precision highp float;

out vec2 v_uv;

const vec2 POS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);

void main() {
  vec2 pos = POS[gl_VertexID];
  v_uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`

/** WGSL: полноэкранный треугольник из @builtin(vertex_index). */
export const FULLSCREEN_PASS_WGSL = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) coord: vec2f,
}

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> VsOut {
  let POS = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  )
  var vout: VsOut
  let p = POS[vi]
  vout.pos = vec4f(p, 0.0, 1.0)
  vout.coord = p * 0.5 + 0.5
  return vout
}
`
