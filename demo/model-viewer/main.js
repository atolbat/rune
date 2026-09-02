// Демо «model-viewer»: сцена с загрузчиком — три модели из three.js examples.
//   Forest House — glTF + AVIF-текстуры + Draco (webgl_loader_gltf_avif)
//   Samba Dancing — FBX, скелет, бинд-поза (webgl_loader_fbx)
//   Nefertiti — glTF + object-space normal map (webgl_materials_normalmap_object_space)
// Сценарий: кнопка «Загрузить и показать» → прогресс-бар (AssetLoader:
// fetch → parse → decode) → сцена. Переключение моделей; загруженные
// показываются мгновенно. Вращение — драгом (тач/мышь) + авто-спин.
// Демо импортирует СОБРАННЫЕ бандлы: dist/rune.esm.js + dist/rune-loaders.esm.js.
import { createRenderer } from '../../dist/rune.esm.js'
import { AssetLoader } from '../../dist/rune-loaders.esm.js'

/* ─── Модели ─────────────────────────────────────────────────────────────── */

const MODELS = [
  {
    id: 'house',
    title: 'Forest House',
    sub: 'glTF · AVIF · Draco',
    url: 'assets/forest_house.glb',
    bytes: 303_984,
  },
  {
    id: 'samba',
    title: 'Samba Dancing',
    sub: 'FBX · скелет · бинд-поза',
    url: 'assets/samba.fbx',
    bytes: 3_681_360,
  },
  {
    id: 'nefertiti',
    title: 'Nefertiti',
    sub: 'glTF · normal map (object space)',
    url: 'assets/Nefertiti.glb',
    bytes: 1_233_240,
  },
]

const MODE_NAMES = { auto: 'Авто (WebGPU → фолбэк WebGL2)', webgl2: 'WebGL2', webgpu: 'WebGPU' }
const LIGHT_DIR = [0.5, 0.8, 0.6]

/* ─── Шейдеры (dual-source: GLSL + WGSL — один спек, оба бэкенда) ────────── */

// Текстурированный Lambert (Forest House): tex.rgb * (ambient + lambert).
// alphaCutoff: MASK-материалы отбрасывают прозрачные фрагменты; BLEND —
// рисуются с блендингом (pipeline), OPAQUE — cutoff 0 (никогда не сработает).
const TEXTURED_VERT = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
uniform mat4 u_mvp;
uniform mat4 u_model;
out vec3 v_normal;
out vec2 v_uv;
void main() {
  v_normal = mat3(u_model) * normal;
  v_uv = uv;
  gl_Position = u_mvp * vec4(position, 1.0);
}`

const TEXTURED_FRAG = `#version 300 es
precision mediump float;
in vec3 v_normal;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3 u_lightDir;
uniform float u_alphaCutoff;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  if (!gl_FrontFacing) n = -n; // doubleSided материалы дома
  float lambert = max(dot(n, normalize(u_lightDir)), 0.0);
  vec4 tex = texture(u_tex, v_uv);
  if (tex.a < u_alphaCutoff) discard;
  o_color = vec4(tex.rgb * (0.35 + 0.65 * lambert), tex.a);
}`

const TEXTURED_WGSL = `
struct Params {
  u_mvp     : mat4x4<f32>,
  u_model   : mat4x4<f32>,
  u_lightDir : vec4<f32>,
  u_alphaCutoff : f32,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) worldNormal : vec3<f32>,
  @location(1) uv : vec2<f32>,
}

@vertex
fn vsMain(
  @location(0) inPos : vec3<f32>,
  @location(1) inNormal : vec3<f32>,
  @location(2) inUv : vec2<f32>,
) -> VSOut {
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(inPos, 1.0);
  out.worldNormal = (params.u_model * vec4<f32>(inNormal, 0.0)).xyz;
  out.uv = inUv;
  return out;
}

struct FSIn {
  @location(0) worldNormal : vec3<f32>,
  @location(1) uv : vec2<f32>,
  @builtin(front_facing) ff : bool,
}

@fragment
fn fsMain(frag : FSIn) -> @location(0) vec4<f32> {
  var n = normalize(frag.worldNormal);
  n = select(-n, n, frag.ff); // doubleSided материалы дома
  let lambert = max(dot(n, normalize(params.u_lightDir.xyz)), 0.0);
  let tex = textureSample(texTexture, texSampler, frag.uv);
  if (tex.a < params.u_alphaCutoff) { discard; }
  return vec4<f32>(tex.rgb * (0.35 + 0.65 * lambert), tex.a);
}`

// Плоский Lambert (Samba): albedo * (ambient + lambert), текстур нет.
const FLAT_VERT = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
uniform mat4 u_mvp;
uniform mat4 u_model;
out vec3 v_normal;
void main() {
  v_normal = mat3(u_model) * normal;
  gl_Position = u_mvp * vec4(position, 1.0);
}`

const FLAT_FRAG = `#version 300 es
precision mediump float;
in vec3 v_normal;
uniform vec3 u_lightDir;
uniform vec3 u_albedo;
out vec4 o_color;
void main() {
  vec3 n = normalize(v_normal);
  float lambert = max(dot(n, normalize(u_lightDir)), 0.0);
  o_color = vec4(u_albedo * (0.3 + 0.7 * lambert), 1.0);
}`

const FLAT_WGSL = `
struct Params {
  u_mvp     : mat4x4<f32>,
  u_model   : mat4x4<f32>,
  u_lightDir : vec4<f32>,
  u_albedo   : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) worldNormal : vec3<f32>,
}

@vertex
fn vsMain(
  @location(0) inPos : vec3<f32>,
  @location(1) inNormal : vec3<f32>,
) -> VSOut {
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(inPos, 1.0);
  out.worldNormal = (params.u_model * vec4<f32>(inNormal, 0.0)).xyz;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let lambert = max(dot(normalize(frag.worldNormal), normalize(params.u_lightDir.xyz)), 0.0);
  return vec4<f32>(params.u_albedo.rgb * (0.3 + lambert * 0.7), 1.0);
}`

// Object-space normal map (Nefertiti): нормаль берётся ИЗ КАРТЫ НОРМАЛЕЙ
// (RGB → объектное пространство), геометрические нормали не нужны — как в
// исходном примере three.js (deleteAttribute('normal')).
const NORMALMAP_VERT = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec2 uv;
uniform mat4 u_mvp;
uniform mat4 u_model;
out vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = u_mvp * vec4(position, 1.0);
}`

const NORMALMAP_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_normalMap;
uniform mat4 u_model;
uniform vec3 u_lightDir;
out vec4 o_color;
void main() {
  vec3 nObj = texture(u_normalMap, v_uv).xyz * 2.0 - 1.0;
  vec3 n = normalize(mat3(u_model) * nObj);
  if (!gl_FrontFacing) n = -n; // doubleSided: бюст открыт с двух сторон
  float lambert = max(dot(n, normalize(u_lightDir)), 0.0);
  vec3 base = texture(u_tex, v_uv).rgb;
  o_color = vec4(base * (0.22 + 0.78 * lambert), 1.0);
}`

const NORMALMAP_WGSL = `
struct Params {
  u_mvp     : mat4x4<f32>,
  u_model   : mat4x4<f32>,
  u_lightDir : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;
@group(1) @binding(2) var nrmTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vsMain(
  @location(0) inPos : vec3<f32>,
  @location(1) inUv : vec2<f32>,
) -> VSOut {
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(inPos, 1.0);
  out.uv = inUv;
  return out;
}

struct FSIn {
  @location(0) uv : vec2<f32>,
  @builtin(front_facing) ff : bool,
}

@fragment
fn fsMain(frag : FSIn) -> @location(0) vec4<f32> {
  let nObj = textureSample(nrmTexture, texSampler, frag.uv).xyz * 2.0 - 1.0;
  var n = normalize((params.u_model * vec4<f32>(nObj, 0.0)).xyz);
  n = select(-n, n, frag.ff);
  let lambert = max(dot(n, normalize(params.u_lightDir.xyz)), 0.0);
  let base = textureSample(texTexture, texSampler, frag.uv);
  return vec4<f32>(base.rgb * (0.22 + 0.78 * lambert), 1.0);
}`

/* ─── Локальная математика mat4 (колоночно-мажорная, как @rune/math) ──────── */

const M = () => new Float32Array(16)

function mat4Identity(out) {
  out.fill(0)
  out[0] = out[5] = out[10] = out[15] = 1
  return out
}

function mat4Multiply(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3]
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11]
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3]
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
  }
  return out
}

function mat4Perspective(out, fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2)
  out.fill(0)
  out[0] = f / aspect
  out[5] = f
  out[10] = far / (near - far)
  out[11] = -1
  out[14] = (far * near) / (near - far)
  return out
}

function mat4Translation(out, x, y, z) {
  mat4Identity(out)
  out[12] = x
  out[13] = y
  out[14] = z
  return out
}

function mat4Scale(out, s) {
  mat4Identity(out)
  out[0] = out[5] = out[10] = s
  return out
}

function mat4RotationX(out, angle) {
  const c = Math.cos(angle), s = Math.sin(angle)
  mat4Identity(out)
  out[5] = c
  out[6] = s
  out[9] = -s
  out[10] = c
  return out
}

function mat4RotationY(out, angle) {
  const c = Math.cos(angle), s = Math.sin(angle)
  mat4Identity(out)
  out[0] = c
  out[2] = -s
  out[8] = s
  out[10] = c
  return out
}

function mat4LookAt(out, ex, ey, ez, cx, cy, cz) {
  // z = normalize(eye − center) — конвенция камеры rune/@rune/math
  let zx = ex - cx, zy = ey - cy, zz = ez - cz
  let len = Math.hypot(zx, zy, zz) || 1
  zx /= len; zy /= len; zz /= len
  // x = normalize(cross(up, z)), up = (0, 1, 0)
  let xx = zz, xy = 0, xz = -zx
  len = Math.hypot(xx, xy, xz)
  if (len < 1e-6) { xx = 1; xy = 0; xz = 0 } else { xx /= len; xz /= len }
  // y = cross(z, x)
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0
  out[12] = -(xx * ex + xy * ey + xz * ez)
  out[13] = -(yx * ex + yy * ey + yz * ez)
  out[14] = -(zx * ex + zy * ey + zz * ez)
  out[15] = 1
  return out
}

/** ТRS-узел glTF → матрица (кватернион x,y,z,w; масштаб равномерный по осям). */
function mat4FromTrs(out, translation, rotation, scale) {
  if (rotation === undefined || rotation === null) {
    mat4Identity(out)
  } else {
    const [x, y, z, w] = rotation
    const x2 = x + x, y2 = y + y, z2 = z + z
    const xx = x * x2, xy = x * y2, xz = x * z2
    const yy = y * y2, yz = y * z2, zz = z * z2
    const wx = w * x2, wy = w * y2, wz = w * z2
    out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0
    out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0
    out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1
  }
  if (scale !== undefined && scale !== null) {
    for (let i = 0; i < 12; i += 4) {
      out[i] *= scale[0]
      out[i + 1] *= scale[1]
      out[i + 2] *= scale[2]
    }
  }
  if (translation !== undefined && translation !== null) {
    out[12] += translation[0]
    out[13] += translation[1]
    out[14] += translation[2]
  }
  return out
}

/* ─── Геометрия: деиндексация и запекание нод ────────────────────────────── */

/** Раскрывает индексы в «суп вершин»: ленты rune рисуют drawArrays. */
function deindexed(positions, normals, uvs, indices) {
  if (indices === null || indices === undefined) {
    return { positions, normals, uvs }
  }
  const count = indices.length
  const out = new Float32Array(count * 3)
  const outN = normals !== null && normals !== undefined ? new Float32Array(count * 3) : null
  const outU = uvs !== null && uvs !== undefined ? new Float32Array(count * 2) : null
  for (let i = 0; i < count; i++) {
    const src = indices[i]
    out[i * 3] = positions[src * 3]
    out[i * 3 + 1] = positions[src * 3 + 1]
    out[i * 3 + 2] = positions[src * 3 + 2]
    if (outN !== null) {
      outN[i * 3] = normals[src * 3]
      outN[i * 3 + 1] = normals[src * 3 + 1]
      outN[i * 3 + 2] = normals[src * 3 + 2]
    }
    if (outU !== null) {
      outU[i * 2] = uvs[src * 2]
      outU[i * 2 + 1] = uvs[src * 2 + 1]
    }
  }
  return { positions: out, normals: outN, uvs: outU }
}

/** Запекает матрицу ноды в позиции/нормали (равномерный масштаб assumed). */
function bakedByMatrix(positions, normals, matrix) {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    positions[i] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]
    positions[i + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]
    positions[i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  }
  if (normals !== null && normals !== undefined) {
    for (let i = 0; i < normals.length; i += 3) {
      const x = normals[i], y = normals[i + 1], z = normals[i + 2]
      normals[i] = matrix[0] * x + matrix[4] * y + matrix[8] * z
      normals[i + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z
      normals[i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z
    }
  }
}

/** Границы объединения всех мешей (по уже запечённым позициям). */
function sceneBounds(meshes) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const mesh of meshes) {
    const p = mesh.positions
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = p[i + a]
        if (v < min[a]) min[a] = v
        if (v > max[a]) max[a] = v
      }
    }
  }
  if (!Number.isFinite(min[0])) {
    return { min: [0, 0, 0], max: [1, 1, 1], center: [0, 0, 0], radius: 1 }
  }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const radius = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1
  return { min, max, center, radius }
}

/* ─── Draco-адаптер: контракт @rune/loaders (bytes, attributes) → геометрия ── */

// forest_house.glb требует KHR_draco_mesh_compression. Декодер —
// draco_wasm_wrapper.js + draco_decoder.wasm из three.js (локальные ассеты
// демо — внешних CDN-зависимостей нет). Обёртка emscripten — классический
// скрипт: грузим текстом и разворачиваем new Function (module-контекст её
// не экспортирует), модуль инстанцируется один раз и кэшируется.
let dracoModule = null

async function loadDracoModule() {
  if (dracoModule !== null) return dracoModule
  const [wrapperText, wasmBinary] = await Promise.all([
    fetch('assets/draco_wasm_wrapper.js').then(response => {
      if (!response.ok) throw new Error(`draco wrapper: HTTP ${response.status}`)
      return response.text()
    }),
    fetch('assets/draco_decoder.wasm').then(response => {
      if (!response.ok) throw new Error(`draco wasm: HTTP ${response.status}`)
      return response.arrayBuffer()
    }),
  ])
  const factory = new Function(`${wrapperText}\n; return DracoDecoderModule`)()
  dracoModule = await new Promise((resolve, reject) => {
    try {
      factory({ wasmBinary, onModuleLoaded: resolve })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
  return dracoModule
}

/** Декодирует Draco-примитив по образцу three.js DRACOLoader (MIT). */
async function decodeDraco(bytes, attributes) {
  const draco = await loadDracoModule()
  const decoder = new draco.Decoder()
  try {
    const array = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const geometryType = decoder.GetEncodedGeometryType(array)
    if (geometryType !== draco.TRIANGULAR_MESH) {
      throw new Error('demo: Draco — не триангулярный меш')
    }
    const mesh = new draco.Mesh()
    const status = decoder.DecodeArrayToMesh(array, array.byteLength, mesh)
    if (!status.ok() || mesh.ptr === 0) {
      throw new Error(`demo: Draco decode — ${status.error_msg()}`)
    }
    const numPoints = mesh.num_points()

    const readAttribute = (name, components) => {
      const uniqueId = attributes[name]
      if (uniqueId === undefined) return null
      const attribute = decoder.GetAttributeByUniqueId(mesh, uniqueId)
      const byteLength = numPoints * components * 4
      const ptr = draco._malloc(byteLength)
      decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, draco.DT_FLOAT32, byteLength, ptr)
      const view = new Float32Array(draco.HEAPF32.buffer, ptr, numPoints * components)
      const out = view.slice() // копия из WASM-heap — malloc/free ниже
      draco._free(ptr)
      return out
    }

    const positions = readAttribute('POSITION', 3)
    if (positions === null) throw new Error('demo: Draco-примитив без POSITION')
    const normals = readAttribute('NORMAL', 3)
    const uvs = readAttribute('TEXCOORD_0', 2)

    // Индексы: GetTrianglesUInt32Array → копия из heap
    const numIndices = mesh.num_faces() * 3
    const indexByteLength = numIndices * 4
    const indexPtr = draco._malloc(indexByteLength)
    decoder.GetTrianglesUInt32Array(mesh, indexByteLength, indexPtr)
    const indexView = new Uint32Array(draco.HEAPF32.buffer, indexPtr, numIndices)
    const indices = indexView.slice()
    draco._free(indexPtr)

    draco.destroy(mesh)
    return { positions, normals, uvs, indices }
  } finally {
    draco.destroy(decoder)
  }
}

/* ─── Парсинг модели → подготовленные меши (бэкенд-независимые) ───────────── */

const loader = new AssetLoader({ dracoDecoder: decodeDraco })

/** glTF/GLB: ноды → мировые матрицы → запекание → деиндексация + материалы. */
function prepareGltf(model) {
  const meshes = []
  const nodeMatrix = M()
  const visit = (nodeIndex, parent) => {
    const node = model.nodes[nodeIndex]
    if (node === undefined) return
    mat4FromTrs(nodeMatrix, node.translation, node.rotation, node.scale)
    if (node.matrix !== undefined && node.matrix !== null) {
      // Полная матрица ноды (колоночно-мажорный массив из glTF)
      for (let i = 0; i < 16; i++) nodeMatrix[i] = node.matrix[i]
    }
    const world = parent === null ? nodeMatrix.slice() : mat4Multiply(M(), parent, nodeMatrix)
    if (node.mesh !== null) {
      const mesh = model.meshes[node.mesh]
      if (mesh !== undefined) {
        for (const primitive of mesh.primitives) {
          const material = primitive.material !== null ? model.materials[primitive.material] : undefined
          const positions = primitive.positions.slice()
          const normals = primitive.normals !== null ? primitive.normals.slice() : null
          bakedByMatrix(positions, normals, world)
          const flat = deindexed(positions, normals, primitive.uvs, primitive.indices)
          const baseColorImage = material?.baseColorImage
          meshes.push({
            positions: flat.positions,
            normals: flat.normals,
            uvs: flat.uvs,
            bitmap: baseColorImage !== null && baseColorImage !== undefined
              ? model.images[baseColorImage]
              : null,
            normalBitmap: material?.normalImage !== null && material?.normalImage !== undefined
              ? model.images[material.normalImage]
              : null,
            albedo: material?.baseColorFactor?.slice(0, 3) ?? [1, 1, 1],
            blend: material?.alphaMode === 'BLEND',
            alphaCutoff: material?.alphaMode === 'MASK' ? (material.alphaCutoff || 0.5) : 0,
            cull: material?.doubleSided === true ? 'none' : 'back',
            name: mesh.name,
          })
        }
      }
    }
    for (const child of node.children) visit(child, world)
  }
  for (const root of model.sceneRoots) visit(root, null)
  return finishPrepared(meshes, model.stats)
}

/** FBX (Samba): меши уже в мировых координатах — только деиндексация + цвет. */
function prepareFbx(model) {
  const meshes = []
  const SKIN_TONE = [0.72, 0.53, 0.42]
  const JOINT_TONE = [0.42, 0.5, 0.62]
  for (const mesh of model.meshes) {
    const flat = deindexed(mesh.positions, mesh.normals, null, mesh.indices)
    meshes.push({
      positions: flat.positions,
      normals: flat.normals,
      uvs: null,
      bitmap: null,
      normalBitmap: null,
      albedo: mesh.name.includes('Joints') ? JOINT_TONE : SKIN_TONE,
      blend: false,
      alphaCutoff: 0,
      cull: 'none', // бинд-поза Mixamo: подмышки/складки открыты с двух сторон
      name: mesh.name,
    })
  }
  return finishPrepared(meshes, { vertices: 0, triangles: 0 })
}

function finishPrepared(meshes, stats) {
  const bounds = sceneBounds(meshes)
  let vertices = 0
  let triangles = 0
  for (const mesh of meshes) {
    vertices += mesh.positions.length / 3
    triangles += mesh.positions.length / 9
  }
  return { meshes, bounds, stats: { ...stats, vertices, triangles } }
}

/* ─── Шелл и панель моделей ───────────────────────────────────────────────── */

const shell = window.RuneDemoShell.mount({
  title: 'rune — model viewer',
  desc: 'Три модели three.js examples: glTF+AVIF+Draco, FBX, normal map. Кнопка загрузки с прогрессом, переключение, вращение драгом.',
  hint: 'Локально: <code>bun run demo</code> → /demo/model-viewer/ · Бандлы: <code>dist/rune.esm.js</code> + <code>dist/rune-loaders.esm.js</code>',
  defaults: { mode: 'auto' },
  onMode: (mode) => void boot(mode),
  onPause: () => {
    activeRenderer?.stop()
    shell.log.event('Пауза')
  },
  onResume: () => {
    activeRenderer?.start()
    shell.log.event('Продолжили')
  },
})

// Панель поверх канваса: табы моделей + кнопка загрузки + прогресс.
const panel = document.createElement('div')
panel.className = 'mv-panel'

const tabs = document.createElement('div')
tabs.className = 'mv-tabs'
panel.append(tabs)

const loadButton = document.createElement('button')
loadButton.type = 'button'
loadButton.className = 'mv-load'
panel.append(loadButton)

const progress = document.createElement('div')
progress.className = 'mv-progress'
const barTrack = document.createElement('div')
barTrack.className = 'mv-bar-track'
const bar = document.createElement('div')
bar.className = 'mv-bar'
barTrack.append(bar)
const status = document.createElement('span')
status.className = 'mv-status'
progress.append(barTrack, status)
panel.append(progress)

const statsLine = document.createElement('span')
statsLine.className = 'mv-stats'
panel.append(statsLine)

const dragHint = document.createElement('span')
dragHint.className = 'mv-hint-drag'
dragHint.textContent = 'драг — вращение'

let currentModelId = MODELS[0].id
const prepared = new Map() // id → подготовленные меши (бэкенд-независимые)
const attached = new Map() // id → сцена на ТЕКУЩЕМ рендерере (сбрасывается в boot)

function renderTabs() {
  tabs.replaceChildren()
  for (const model of MODELS) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'mv-tab'
    if (prepared.has(model.id)) tab.classList.add('mv-loaded')
    tab.setAttribute('aria-pressed', String(model.id === currentModelId))
    const title = document.createElement('b')
    title.textContent = model.title
    const sub = document.createElement('span')
    sub.textContent = model.sub
    tab.append(title, sub)
    tab.addEventListener('click', () => selectModel(model.id))
    tabs.append(tab)
  }
}

function setProgress(ratio, detail) {
  progress.classList.add('mv-active')
  bar.style.width = `${Math.round(ratio * 100)}%`
  status.textContent = detail ?? ''
}

function hideProgress() {
  progress.classList.remove('mv-active')
  bar.style.width = '0%'
}

function renderPanelState() {
  const model = MODELS.find(m => m.id === currentModelId)
  const isPrepared = prepared.has(currentModelId)
  loadButton.textContent = isPrepared
    ? `Показать «${model.title}»`
    : `Загрузить и показать · ${(model.bytes / 1024 / 1024).toFixed(1)} МБ`
  loadButton.disabled = loadBusy
  if (isPrepared && !loadBusy) hideProgress()
  renderTabs()
}

/* ─── Загрузка модели (AssetLoader: fetch → parse → decode) ───────────────── */

let loadBusy = false
let loadSeq = 0

async function loadModel(model) {
  const seq = ++loadSeq
  loadBusy = true
  renderPanelState()
  setProgress(0, 'в очереди')
  shell.log.event(`Загрузка «${model.title}» (${(model.bytes / 1024 / 1024).toFixed(1)} МБ)…`)
  const startedAt = performance.now()
  try {
    const handle = loader.load(model.url, {
      onProgress: phase => {
        if (seq !== loadSeq) return
        setProgress(phase.ratio, `${phaseDetailRu(phase)} · ${(phase.loaded / 1024).toFixed(0)} КБ`)
      },
    })
    // LoadHandle — thenable: await хэндла даёт распарсенный ассет
    const asset = await handle
    if (seq !== loadSeq) return
    const preparedModel = model.id === 'samba' ? prepareFbx(asset) : prepareGltf(asset)
    prepared.set(model.id, preparedModel)
    shell.log.event(
      `«${model.title}» готова: ${preparedModel.stats.vertices.toLocaleString('ru-RU')} вершин, ` +
      `${Math.round(preparedModel.stats.triangles).toLocaleString('ru-RU')} треугольников за ` +
      `${((performance.now() - startedAt) / 1000).toFixed(1)} с`,
    )
    await showModel(model.id)
  } catch (error) {
    if (seq !== loadSeq) return
    shell.log.error(`Загрузка «${model.title}» не удалась: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    shell.setBadge('ошибка загрузки', 'err')
    hideProgress()
  } finally {
    loadBusy = false
    renderPanelState()
  }
}

function phaseDetailRu(phase) {
  switch (phase.phase) {
    case 'queued': return 'в очереди'
    case 'fetching': return `скачивание (${Math.round(phase.ratio * 100)}%)`
    case 'decoding': return `парсинг: ${phase.detail}`
    case 'done': return 'готово'
    default: return phase.phase
  }
}

/* ─── Сцена на текущем рендерере ──────────────────────────────────────────── */

async function showModel(id) {
  currentModelId = id
  renderPanelState()
  if (!prepared.has(id)) {
    statsLine.textContent = ''
    return
  }
  if (activeRenderer === null) return
  if (!attached.has(id)) await attachScene(id)
  const scene = attached.get(id)
  if (scene !== undefined) {
    statsLine.textContent = `${scene.stats.vertices.toLocaleString('ru-RU')} верш · ${Math.round(scene.stats.triangles).toLocaleString('ru-RU')} три · ${scene.meshes.length} меш.`
  }
  shell.log.event(`Сцена: «${MODELS.find(m => m.id === id).title}»`)
}

function selectModel(id) {
  if (loadBusy) return
  currentModelId = id
  if (prepared.has(id)) {
    void showModel(id)
  } else {
    renderPanelState()
    statsLine.textContent = 'модель ещё не загружена — нажмите кнопку'
    shell.log.event(`Выбрана «${MODELS.find(m => m.id === id).title}» (не загружена)`)
  }
}

loadButton.addEventListener('click', () => {
  if (loadBusy) return
  const model = MODELS.find(m => m.id === currentModelId)
  if (prepared.has(currentModelId)) {
    void showModel(currentModelId)
    return
  }
  void loadModel(model)
})

/** Компилирует команды и текстуры подготовленной модели на текущем рендерере. */
async function attachScene(id) {
  const model = prepared.get(id)
  if (model === undefined || activeRenderer === null) return
  const drawMeshes = []
  for (const mesh of model.meshes) {
    const variant = mesh.normalBitmap !== null ? 'normalmap' : mesh.bitmap !== null ? 'textured' : 'flat'
    const bitmap = await resolveBitmap(mesh.bitmap)
    if (mesh.bitmap !== null && bitmap === null) {
      shell.log.warn(`меш «${mesh.name}»: текстура не декодировалась — рисуем albedo`)
    }
    const normalBitmap = mesh.normalBitmap !== null ? await resolveBitmap(mesh.normalBitmap) : null
    const attributes = {}
    const textures = {}
    const uniforms = {
      u_mvp: (p) => p.mvp,
      u_model: (p) => p.model,
      u_lightDir: LIGHT_DIR,
    }
    if (variant === 'textured') {
      attributes.position = { data: mesh.positions, size: 3 }
      attributes.normal = { data: mesh.normals, size: 3 }
      attributes.uv = { data: mesh.uvs, size: 2 }
      attributes.inPos = attributes.position
      attributes.inNormal = attributes.normal
      attributes.inUv = attributes.uv
      uniforms.u_alphaCutoff = mesh.alphaCutoff
    } else if (variant === 'normalmap') {
      attributes.position = { data: mesh.positions, size: 3 }
      attributes.uv = { data: mesh.uvs, size: 2 }
      attributes.inPos = attributes.position
      attributes.inUv = attributes.uv
    } else {
      attributes.position = { data: mesh.positions, size: 3 }
      attributes.normal = { data: mesh.normals, size: 3 }
      attributes.inPos = attributes.position
      attributes.inNormal = attributes.normal
      uniforms.u_albedo = mesh.albedo
    }

    const glslOf = () => {
      if (variant === 'textured') return { vertex: TEXTURED_VERT, fragment: TEXTURED_FRAG }
      if (variant === 'normalmap') return { vertex: NORMALMAP_VERT, fragment: NORMALMAP_FRAG }
      return { vertex: FLAT_VERT, fragment: FLAT_FRAG }
    }
    const wgslOf = () => {
      if (variant === 'textured') return TEXTURED_WGSL
      if (variant === 'normalmap') return NORMALMAP_WGSL
      return FLAT_WGSL
    }

    // Текстуры: битмапы glTF уже декодированы парсером (createImageBitmap)
    let glTexture = null
    if (variant === 'textured' && bitmap !== null) {
      glTexture = activeRenderer.texture(bitmap.width, bitmap.height)
      glTexture.uploadImage(bitmap)
      textures.u_tex = glTexture
      textures.texTexture = glTexture
    } else if (variant === 'normalmap' && bitmap !== null && normalBitmap !== null) {
      glTexture = activeRenderer.texture(bitmap.width, bitmap.height)
      glTexture.uploadImage(bitmap)
      const glNormal = activeRenderer.texture(normalBitmap.width, normalBitmap.height)
      glNormal.uploadImage(normalBitmap)
      textures.u_tex = glTexture
      textures.u_normalMap = glNormal
      textures.texTexture = glTexture
      textures.nrmTexture = glNormal
    }

    const spec = {
      id: `${id}:${mesh.name}:${variant}`,
      shader: { glsl: glslOf(), wgsl: wgslOf() },
      pipeline: {
        depth: { test: 'less', write: true },
        raster: { cull: mesh.cull },
        ...(mesh.blend ? { blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' } } : {}),
      },
      attributes,
      uniforms,
      textures: Object.keys(textures).length > 0 ? textures : undefined,
      count: mesh.positions.length / 3,
    }
    const command = activeRenderer.command(spec)
    drawMeshes.push({ command, order: mesh.blend ? 1 : 0 })
  }
  // Прозрачные меши — после opaque (дом: трава/листья/окна поверх)
  drawMeshes.sort((a, b) => a.order - b.order)
  attached.set(id, { meshes: drawMeshes.map(m => m.command), stats: model.stats })
}

/** Битмап из GltfImage (promise) — null при неудаче декода. */
async function resolveBitmap(image) {
  if (image === null || image === undefined) return null
  try {
    return await image.bitmap
  } catch {
    return null
  }
}

/* ─── Рендерер и цикл кадра ───────────────────────────────────────────────── */

let activeRenderer = null
let bootSeq = 0

const view = M()
const projection = M()
const viewProj = M()
const rotX = M()
const rotY = M()
const spin = M()
const fit = M()
const model = M()
const mvp = M()
let cachedAspect = 0

// Вращение: авто-спин + драг (тач/мышь), pitch зажат.
let yaw = 0.6
let pitch = 0.18
let dragging = false
let lastX = 0
let lastY = 0
let lastInteraction = 0

function bindDrag(canvas) {
  canvas.style.touchAction = 'none'
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true
    lastX = event.clientX
    lastY = event.clientY
    lastInteraction = performance.now()
    canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return
    const dx = event.clientX - lastX
    const dy = event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    yaw += dx * 0.006
    pitch = Math.min(1.2, Math.max(-1.2, pitch + dy * 0.006))
    lastInteraction = performance.now()
  })
  const stop = () => { dragging = false }
  canvas.addEventListener('pointerup', stop)
  canvas.addEventListener('pointercancel', stop)
}

/** Кадр: камера fixed, модель вращается (turntable). */
function frameCallback(ctx, record) {
  if (ctx.aspect !== cachedAspect) {
    cachedAspect = ctx.aspect
    mat4Perspective(projection, Math.PI / 3.4, ctx.aspect, 0.1, 100)
  }
  mat4LookAt(view, 0, 0.55, 3.2, 0, 0, 0)
  mat4Multiply(viewProj, projection, view)

  // авто-спин: пауза пока драгают и 1.5 с после
  if (!dragging && performance.now() - lastInteraction > 1500) yaw += ctx.dt * 0.35

  mat4RotationX(rotX, pitch)
  mat4RotationY(rotY, yaw)
  mat4Multiply(spin, rotX, rotY)

  const scene = attached.get(currentModelId)
  if (scene === undefined) return
  const bounds = prepared.get(currentModelId)?.bounds
  if (bounds !== undefined) {
    const scale = 1.5 / bounds.radius
    mat4Scale(fit, scale)
    fit[12] = -bounds.center[0] * scale
    fit[13] = -bounds.center[1] * scale
    fit[14] = -bounds.center[2] * scale
  }
  mat4Multiply(model, spin, fit)
  mat4Multiply(mvp, viewProj, model)
  for (const command of scene.meshes) record(command, { mvp, model })
}

async function boot(mode) {
  const seq = ++bootSeq

  if (activeRenderer !== null) {
    try { activeRenderer.dispose() } catch { /* контекст мог умереть с канвасом */ }
    activeRenderer = null
    attached.clear()
  }
  shell.slot.replaceChildren(panel)
  const canvas = document.createElement('canvas')
  canvas.id = 'canvas'
  shell.slot.append(canvas, dragHint)
  bindDrag(canvas)

  shell.log.event(`Запуск: режим «${MODE_NAMES[mode] ?? mode}»`)

  try {
    const renderer = createRenderer({
      canvas,
      backend: mode === 'auto' ? undefined : mode,
      clear: { color: [0.07, 0.08, 0.11, 1], depth: 1 },
      // Каналы тихих ошибок валидации (GL_INVALID_* / WebGPU uncaptured):
      // без них «чёрный канвас» не объясняет себя — стандарт демо требует лог
      onGlError: (message) => shell.log.warn(`GL: ${message}`),
      onGpuError: (message) => shell.log.warn(`GPU: ${message}`),
    })
    await renderer.start()
    if (seq !== bootSeq) { renderer.dispose(); return }
    activeRenderer = renderer
    renderer.frame(frameCallback)
    attached.clear()
    const backendName = renderer.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
    shell.setBadge(backendName, renderer.backend === 'webgpu' ? 'gpu' : 'gl')
    shell.log.info(`Бэкенд: ${backendName}${renderer.backend === 'webgl2' && mode === 'auto' ? ' (фолбэк)' : ''}`)

    // Загруженные модели компилируются на новом рендерере по требованию
    if (prepared.has(currentModelId)) {
      await attachScene(currentModelId)
      if (seq !== bootSeq) return
      renderPanelState()
    }
  } catch (error) {
    if (seq !== bootSeq) return
    const message = error instanceof Error ? error.message : String(error)
    shell.setBadge(mode === 'webgpu' ? 'WebGPU недоступен' : 'ошибка запуска', 'err')
    shell.log.error(`Запуск на «${mode}» не удался: ${message}`)
    if (mode === 'webgpu') {
      shell.log.info('Это не ошибка библиотеки — бэкенда нет в этом браузере. Переключите тумблер на «Авто» или WebGL2.')
    }
    return
  }

  shell.log.event('Визуализация запущена')
  const live = shell.slot.querySelector('canvas')
  shell.log.info(`Канвас: ${live.clientWidth}×${live.clientHeight} css-px, DPR ${window.devicePixelRatio}`)
  shell.markReady()
}

shell.log.info(`WebGL2: ${typeof WebGL2RenderingContext !== 'undefined' ? 'есть в браузере' : 'отсутствует'}`)
renderPanelState()
statsLine.textContent = 'выберите модель и нажмите «Загрузить»'
await boot(shell.mode)
