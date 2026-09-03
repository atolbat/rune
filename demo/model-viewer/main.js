// "model-viewer" demo: a scene with a loader — three models from the three.js examples
//   Forest House — glTF + AVIF textures + Draco (webgl_loader_gltf_avif),
//     shaded by the PBR light model (Cook-Torrance: the exact separable
//     Smith-GGX + Schlick Fresnel + Lambert diffuse, its glTF factors for
//     metallic/roughness) — the pbrMask() defaults of @rune/materials
//   Samba Dancing — FBX, skeleton, skinning, clip playback (webgl_loader_fbx)
//   Nefertiti — glTF + object-space normal map (webgl_materials_normalmap_object_space)
//   Matcap Cube — a procedural geometry shaded by the MATCAP pipeline feature
// ALL shaders come from @rune/materials — the assembly pipeline: a feature
// mask per mesh variant, one minimal dual-source (GLSL+WGSL) shader pair per
// combination, shared through the numeric-key variant cache. No hand-written
// GLSL/WGSL lives in this file.
// Flow: a Load button → progress bar (AssetLoader: fetch → parse → decode) →
// the scene. Model switching; loaded models show instantly. Rotation via
// drag (touch/mouse) + auto-spin; zoom via pinch (two fingers) and wheel.
// The demo imports the BUILT bundles: dist/rune.esm.js + dist/rune-loaders.esm.js
// + dist/rune-animation.esm.js + dist/rune-materials.esm.js.
import { createRenderer } from '../../dist/rune.esm.js?v=121'
import { AssetLoader } from '../../dist/rune-loaders.esm.js?v=121'
import { createAnimator } from '../../dist/rune-animation.esm.js?v=121'
import {
  materialOf,
  pbrMask,
  SKIN,
  NORMALMAP,
  TEXTURE,
  FLAT_ALBEDO,
  DOUBLE_SIDED,
  LAMBERT,
  ALPHA_CUTOFF,
  MATCAP,
} from '../../dist/rune-materials.esm.js?v=121'

/* ─── Models ─────────────────────────────────────────────────────────────── */

const MODELS = [
  {
    id: 'house',
    title: 'Forest House',
    sub: 'glTF · AVIF · Draco · PBR',
    url: 'assets/forest_house.glb',
    bytes: 303_984,
    pbr: true,
  },
  {
    id: 'samba',
    title: 'Samba Dancing',
    sub: 'FBX · skeleton · animation',
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
  {
    id: 'matcap',
    title: 'Matcap Cube',
    sub: 'procedural · matcap shading',
    url: null,
    bytes: 0,
    prepare: prepareMatcapCube,
  },
]

const MODE_NAMES = { auto: 'Auto (WebGPU → WebGL2 fallback)', webgl2: 'WebGL2', webgpu: 'WebGPU' }
const LIGHT_DIR = [0.5, 0.8, 0.6]
// The direct-light radiance for the PBR model (the sun). 2.2 ≈ 0.7π: with
// the 1/π of the Lambert diffuse the lit face lands at ≈0.85 of the albedo
// (headroom for the specular lobe) — 4.0 overexposed every sun-facing
// pixel by 27% and clipped it to a flat washed-out white. The Lambert path
// bakes its level into the ambient terms instead.
const LIGHT_COLOR = [2.2, 2.2, 2.2]
// The sky fill (the u_ambient IBL stand-in): ≈0.3 of the albedo in the
// shadow, slightly cool. Without it the shadow side fell to pitch black —
// the “the house changed” look; the pre-PBR Lambert carried a 0.35 ambient.
const AMBIENT_COLOR = [0.28, 0.3, 0.34]

/* ─── Materials (the @rune/materials assembly pipeline) ───────────────── */

// One feature mask per mesh variant — the assembler stitches the minimal
// GLSL + WGSL pair, the numeric-key cache returns the SAME object on every
// attach (backend switches included). The attribute names are unified
// across the two languages: one binding per buffer.
const NJ = 67 // samba skeleton: 67 joints (see the load log)
const MATERIALS = {
  // Forest House: Cook-Torrance PBR (the exact separable Smith-GGX + Schlick
  // + Lambert diffuse — the pbrMask defaults), textured, MASK alpha, open
  // surfaces; the metallic/roughness factors come from the glTF materials
  pbr: () => materialOf({ features: pbrMask() | TEXTURE | DOUBLE_SIDED | ALPHA_CUTOFF }),
  // A PBR mesh with an object-space normal map (general glTF shape)
  pbrNmap: () => materialOf({ features: pbrMask() | TEXTURE | NORMALMAP | DOUBLE_SIDED }),
  // Textured Lambert (the pre-PBR house look)
  textured: () => materialOf({ features: TEXTURE | LAMBERT | DOUBLE_SIDED | ALPHA_CUTOFF }),
  // Nefertiti: the normal comes from an object-space normal map
  normalmap: () => materialOf({ features: TEXTURE | NORMALMAP | LAMBERT | DOUBLE_SIDED }),
  // Samba: a 67-joint skin palette, flat albedo, open Mixamo folds
  skinned: () => materialOf({ features: SKIN | LAMBERT | FLAT_ALBEDO | DOUBLE_SIDED, jointCount: NJ }),
  // Unskinned fallback: flat Lambert
  flat: () => materialOf({ features: FLAT_ALBEDO | LAMBERT }),
  // The matcap cube: the light comes from a sampled sphere, no light dir
  matcap: () => materialOf({ features: MATCAP | FLAT_ALBEDO }),
}

/* ─── Local mat4 math (column-major, like @rune/math) ────────────────────── */

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
  // z = normalize(eye − center) — the rune/@rune/math camera convention
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

/** glTF TRS node → matrix (quaternion x,y,z,w; per-axis scale). */
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

/* ─── Geometry: deindexing and node baking ───────────────────────────────── */

/** Expands indices into a "vertex soup": rune tapes draw via drawArrays. */
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

/** Bakes the node matrix into positions/normals (uniform scale assumed). */
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

/** Bounds of the union of all meshes (over already-baked positions). */
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

/* ─── Draco adapter: the @rune/loaders contract (bytes, attributes) → geometry */

// forest_house.glb requires KHR_draco_mesh_compression. The decoder is
// draco_wasm_wrapper.js + draco_decoder.wasm from three.js (local demo
// assets — no external CDN dependencies). The emscripten wrapper is a
// classic script: we fetch it as text and unwrap it with new Function (the
// module context does not export it); the module is instantiated once and
// cached.
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

/** Decodes a Draco primitive following the three.js DRACOLoader (MIT). */
async function decodeDraco(bytes, attributes) {
  const draco = await loadDracoModule()
  const decoder = new draco.Decoder()
  try {
    const array = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const geometryType = decoder.GetEncodedGeometryType(array)
    if (geometryType !== draco.TRIANGULAR_MESH) {
      throw new Error('demo: Draco — not a triangular mesh')
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
      const out = view.slice() // copy out of the WASM heap — malloc/free below
      draco._free(ptr)
      return out
    }

    const positions = readAttribute('POSITION', 3)
    if (positions === null) throw new Error('demo: Draco primitive without POSITION')
    const normals = readAttribute('NORMAL', 3)
    const uvs = readAttribute('TEXCOORD_0', 2)

    // Indices: GetTrianglesUInt32Array → a copy out of the heap
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

/* ─── Model parsing → prepared meshes (backend-independent) ──────────────── */

const loader = new AssetLoader({ dracoDecoder: decodeDraco })

/** glTF/GLB: nodes → world matrices → baking → deindexing + materials. */
function prepareGltf(model, entry) {
  const meshes = []
  const nodeMatrix = M()
  const visit = (nodeIndex, parent) => {
    const node = model.nodes[nodeIndex]
    if (node === undefined) return
    mat4FromTrs(nodeMatrix, node.translation, node.rotation, node.scale)
    if (node.matrix !== undefined && node.matrix !== null) {
      // Full node matrix (a column-major array from glTF)
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
            // The glTF PBR factors (used by the PBR light model; defaults 1.0
            // per the spec) + the optional metallicRoughness texture
            // (G = roughness, B = metallic — multiplied by the factors).
            roughness: material?.roughnessFactor ?? 1,
            metallic: material?.metallicFactor ?? 1,
            mrBitmap: material?.mrImage !== null && material?.mrImage !== undefined
              ? model.images[material.mrImage]
              : null,
            albedo: material?.baseColorFactor?.slice(0, 3) ?? [1, 1, 1],
            blend: material?.alphaMode === 'BLEND',
            alphaCutoff: material?.alphaMode === 'MASK' ? (material.alphaCutoff || 0.5) : 0,
            cull: material?.doubleSided === true ? 'none' : 'back',
            name: mesh.name,
            pbr: entry.pbr === true,
          })
        }
      }
    }
    for (const child of node.children) visit(child, world)
  }
  for (const root of model.sceneRoots) visit(root, null)
  return finishPrepared(meshes, model.stats)
}

/** FBX (Samba): skinned soup + an animation player. The FBX loader
 *  decodes skeleton/skin/clips; @rune/animation samples the clip and
 *  fills the u_bones palette (the loader's types pass structurally —
 *  no adapters, no copies). */
function prepareFbx(model) {
  const meshes = []
  const SKIN_TONE = [0.72, 0.53, 0.42]
  const JOINT_TONE = [0.42, 0.5, 0.62]
  for (const mesh of model.meshes) {
    const flat = deindexedSkinned(mesh)
    meshes.push({
      positions: flat.positions,
      normals: flat.normals,
      joints: flat.joints,
      weights: flat.weights,
      uvs: null,
      bitmap: null,
      normalBitmap: null,
      albedo: mesh.name.includes('Joints') ? JOINT_TONE : SKIN_TONE,
      blend: false,
      alphaCutoff: 0,
      cull: 'none', // Mixamo bind pose: armpits/folds are open on both sides
      name: mesh.name,
      skinned: mesh.skin !== undefined,
    })
  }
  // The animator samples the clip, evaluates the joint hierarchy
  // (parents first — the loader sorts so) and writes skin = world × invBind
  // into the palette (16 floats per joint).
  const animation = createAnimator(model.skeleton, model.clips[0] ?? null)
  const preparedModel = finishPrepared(meshes, { vertices: 0, triangles: 0 })
  preparedModel.animation = animation
  return preparedModel
}

/** Matcap Cube: a procedural soup (no asset to download) shaded by the
 *  MATCAP feature — the light comes from a pre-lit sphere texture sampled
 *  by the view-space normal. The matcap itself is drawn on a canvas: a
 *  studio sphere (highlight upper-left, cool rim) — symmetric, so the
 *  classic V-flip pitfalls of third-party matcaps do not apply. */
function prepareMatcapCube() {
  const { positions, normals } = cubeSoup(1)
  const meshes = [{
    positions,
    normals,
    uvs: null,
    bitmap: null,
    normalBitmap: null,
    matcap: true,
    matcapSource: matcapCanvas(),
    albedo: [1, 1, 1], // white tint — the matcap provides the color
    blend: false,
    alphaCutoff: 0,
    cull: 'back',
    name: 'cube',
  }]
  return finishPrepared(meshes, { vertices: 0, triangles: 0 })
}

/** 6 faces × 2 triangles × 3 vertices = 36 vertices — the same construction
 *  as @rune/prims cube(): tangential basis per face (cross(u, v) = n),
 *  corners in CCW front order. */
function cubeSoup(half) {
  const FACES = [
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ]
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
  const positions = new Float32Array(36 * 3)
  const normals = new Float32Array(36 * 3)
  let at = 0
  for (const face of FACES) {
    for (const index of [0, 1, 2, 0, 2, 3]) {
      const [cu, cv] = CORNERS[index]
      positions[at * 3] = (face.u[0] * cu + face.v[0] * cv) * half
      positions[at * 3 + 1] = (face.u[1] * cu + face.v[1] * cv) * half
      positions[at * 3 + 2] = (face.u[2] * cu + face.v[2] * cv) * half
      normals[at * 3] = face.n[0]
      normals[at * 3 + 1] = face.n[1]
      normals[at * 3 + 2] = face.n[2]
      at++
    }
  }
  return { positions, normals }
}

let matcapCanvasCache = null
function matcapCanvas() {
  if (matcapCanvasCache !== null) return matcapCanvasCache
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const g = canvas.getContext('2d')
  const grad = g.createRadialGradient(112, 96, 12, 128, 128, 128)
  grad.addColorStop(0, '#ffffff')
  grad.addColorStop(0.45, '#8fb4ff')
  grad.addColorStop(0.8, '#3c5a96')
  grad.addColorStop(1, '#141b30')
  g.fillStyle = grad
  g.fillRect(0, 0, 256, 256)
  matcapCanvasCache = canvas
  return canvas
}

/** Expands the indexed skin into a vertex soup with 4-float joints/weights
 *  (rune tapes draw via drawArrays; joint indices travel as f32 attributes). */
function deindexedSkinned(mesh) {
  const count = mesh.indices.length
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const joints = new Float32Array(count * 4)
  const weights = new Float32Array(count * 4)
  const skin = mesh.skin
  for (let i = 0; i < count; i++) {
    const src = mesh.indices[i]
    positions[i * 3] = mesh.positions[src * 3]
    positions[i * 3 + 1] = mesh.positions[src * 3 + 1]
    positions[i * 3 + 2] = mesh.positions[src * 3 + 2]
    normals[i * 3] = mesh.normals[src * 3]
    normals[i * 3 + 1] = mesh.normals[src * 3 + 1]
    normals[i * 3 + 2] = mesh.normals[src * 3 + 2]
    if (skin !== undefined) {
      for (let c = 0; c < 4; c++) {
        joints[i * 4 + c] = skin.jointIndices[src * 4 + c]
        weights[i * 4 + c] = skin.jointWeights[src * 4 + c]
      }
    }
  }
  return { positions, normals, joints, weights }
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

/* ─── Shell and the model picker ───────────────────────────────────────────────── */

const shell = window.RuneDemoShell.mount({
  layout: 'fullscreen',
  title: 'rune — model viewer',
  defaults: { mode: 'auto' },
  onMode: (mode) => void boot(mode),
  onPause: () => {
    activeRenderer?.stop()
    shell.log.event('Paused')
  },
  onResume: () => {
    activeRenderer?.start()
    shell.log.event('Resumed')
  },
})

// Bottom pill: the current model (or load progress); opens the model sheet.
const pill = document.createElement('button')
pill.type = 'button'
pill.className = 'mv-pill'
pill.hidden = true
pill.addEventListener('click', () => setSheetOpen(true))

// Bottom sheet: model list + load button + progress + stats.
const sheet = document.createElement('div')
sheet.className = 'mv-sheet'
const sheetHead = document.createElement('div')
sheetHead.className = 'mv-head'
const sheetTitle = document.createElement('span')
sheetTitle.className = 'mv-title'
sheetTitle.textContent = 'Models'
const sheetClose = document.createElement('button')
sheetClose.type = 'button'
sheetClose.className = 'mv-close'
sheetClose.textContent = '✕'
sheetClose.setAttribute('aria-label', 'Close')
sheetClose.addEventListener('click', () => setSheetOpen(false))
sheetHead.append(sheetTitle, sheetClose)

const rows = document.createElement('div')
rows.className = 'mv-rows'

const loadButton = document.createElement('button')
loadButton.type = 'button'
loadButton.className = 'mv-load'

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

const statsLine = document.createElement('span')
statsLine.className = 'mv-stats'

sheet.append(sheetHead, rows, loadButton, progress, statsLine)

const dragHint = document.createElement('span')
dragHint.className = 'mv-hint mv-gone'
dragHint.textContent = 'drag to rotate'

let sheetOpen = false
let currentModelId = MODELS[0].id
const prepared = new Map() // id → prepared meshes (backend-independent)
const attached = new Map() // id → scene on the CURRENT renderer (reset in boot)

function setSheetOpen(open) {
  sheetOpen = open
  sheet.hidden = !open
  pill.hidden = open
  if (open) dragHint.classList.add('mv-gone')
}

function renderRows() {
  rows.replaceChildren()
  for (const model of MODELS) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'mv-row' + (prepared.has(model.id) ? ' mv-loaded' : '')
    row.setAttribute('aria-pressed', String(model.id === currentModelId))
    const main = document.createElement('span')
    main.className = 'mv-main'
    const title = document.createElement('b')
    title.textContent = model.title
    const sub = document.createElement('span')
    sub.className = 'mv-sub'
    sub.textContent = model.sub
    main.append(title, sub)
    const size = document.createElement('span')
    size.className = 'mv-size'
    size.textContent = model.bytes > 0 ? `${(model.bytes / 1024 / 1024).toFixed(1)} MB` : 'built-in'
    row.append(main, size)
    row.addEventListener('click', () => selectModel(model.id))
    rows.append(row)
  }
}

function setProgress(ratio, detail) {
  progress.classList.add('mv-active')
  bar.style.width = `${Math.round(ratio * 100)}%`
  status.textContent = detail ?? ''
  if (!sheetOpen) pill.textContent = `Loading… ${Math.round(ratio * 100)}%`
}

function hideProgress() {
  progress.classList.remove('mv-active')
  bar.style.width = '0%'
}

function renderPill() {
  if (loadBusy) return // the pill shows load progress instead
  const model = MODELS.find(m => m.id === currentModelId)
  pill.textContent = model === undefined ? 'Models' : model.title
}

function renderSheetState() {
  const model = MODELS.find(m => m.id === currentModelId)
  const isPrepared = prepared.has(currentModelId)
  loadButton.textContent = isPrepared
    ? 'Show'
    : model.bytes > 0
      ? `Load & show · ${(model.bytes / 1024 / 1024).toFixed(1)} MB`
      : 'Create & show'
  loadButton.disabled = loadBusy
  if (isPrepared && !loadBusy) hideProgress()
  renderRows()
  renderPill()
}

/* ─── Model loading (AssetLoader: fetch → parse → decode) ───────────────── */

let loadBusy = false
let loadSeq = 0

async function loadModel(model) {
  const seq = ++loadSeq
  loadBusy = true
  renderSheetState()
  setProgress(0, 'queued')
  shell.log.event(model.bytes > 0
    ? `Loading “${model.title}” (${(model.bytes / 1024 / 1024).toFixed(1)} MB)…`
    : `Building “${model.title}” (procedural — no download)…`)
  const startedAt = performance.now()
  try {
    let preparedModel
    if (model.prepare !== undefined) {
      // Procedural models (the matcap cube): the geometry is generated, not fetched
      setProgress(1, 'building')
      preparedModel = model.prepare()
    } else {
      const handle = loader.load(model.url, {
        onProgress: phase => {
          if (seq !== loadSeq) return
          setProgress(phase.ratio, `${phaseDetail(phase)} · ${(phase.loaded / 1024).toFixed(0)} KB`)
        },
      })
      // LoadHandle is thenable: awaiting the handle yields the parsed asset
      const asset = await handle
      if (seq !== loadSeq) return
      preparedModel = model.id === 'samba' ? prepareFbx(asset) : prepareGltf(asset, model)
    }
    prepared.set(model.id, preparedModel)
    shell.log.event(
      `“${model.title}” ready: ${preparedModel.stats.vertices.toLocaleString('en-US')} vertices, ` +
      `${Math.round(preparedModel.stats.triangles).toLocaleString('en-US')} triangles in ` +
      `${((performance.now() - startedAt) / 1000).toFixed(1)} s`,
    )
    await showModel(model.id)
    setSheetOpen(false) // done — hide the UI, the scene takes over
  } catch (error) {
    if (seq !== loadSeq) return
    shell.log.error(`Failed to load “${model.title}”: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    shell.setBadge('load failed', 'err')
    hideProgress()
  } finally {
    loadBusy = false
    renderSheetState()
  }
}

function phaseDetail(phase) {
  switch (phase.phase) {
    case 'queued': return 'queued'
    case 'fetching': return `downloading (${Math.round(phase.ratio * 100)}%)`
    case 'decoding': return `parsing: ${phase.detail}`
    case 'done': return 'done'
    default: return phase.phase
  }
}

/* ─── Scene on the current renderer ──────────────────────────────────────────── */

async function showModel(id) {
  currentModelId = id
  renderSheetState()
  if (!prepared.has(id)) {
    statsLine.textContent = ''
    return
  }
  if (activeRenderer === null) return
  if (!attached.has(id)) await attachScene(id)
  const scene = attached.get(id)
  if (scene !== undefined) {
    const animation = prepared.get(id)?.animation
    const animInfo = animation !== undefined && animation.clipName !== null
      ? ` · ${animation.jointCount} joints · ${animation.duration.toFixed(1)} s clip`
      : ''
    statsLine.textContent =
      `${scene.stats.vertices.toLocaleString('en-US')} verts · ` +
      `${Math.round(scene.stats.triangles).toLocaleString('en-US')} tris · ` +
      `${scene.meshes.length} meshes${animInfo}`
  }
  dragHint.classList.remove('mv-gone')
  shell.log.event(`Scene: “${MODELS.find(m => m.id === id).title}”`)
}

function selectModel(id) {
  if (loadBusy) return
  currentModelId = id
  if (prepared.has(id)) {
    void showModel(id)
    setSheetOpen(false)
  } else {
    renderSheetState()
    statsLine.textContent = 'not loaded yet — press Load'
    shell.log.event(`Selected “${MODELS.find(m => m.id === id).title}” (not loaded)`)
  }
}

loadButton.addEventListener('click', () => {
  if (loadBusy) return
  const model = MODELS.find(m => m.id === currentModelId)
  if (prepared.has(currentModelId)) {
    void showModel(currentModelId)
    setSheetOpen(false)
    return
  }
  void loadModel(model)
})

/** Compiles the commands and textures of a prepared model on the current renderer. */
async function attachScene(id) {
  const model = prepared.get(id)
  if (model === undefined || activeRenderer === null) return
  const drawMeshes = []
  for (const mesh of model.meshes) {
    const variant = mesh.pbr === true && mesh.bitmap !== null
      ? (mesh.normalBitmap !== null ? 'pbrNmap' : 'pbr')
      : mesh.skinned === true
        ? 'skinned'
        : mesh.matcap === true
          ? 'matcap'
          : mesh.normalBitmap !== null ? 'normalmap' : mesh.bitmap !== null ? 'textured' : 'flat'
    const bitmap = await resolveBitmap(mesh.bitmap)
    if (mesh.bitmap !== null && bitmap === null) {
      shell.log.warn(`mesh “${mesh.name}”: texture failed to decode — drawing albedo`)
    }
    const normalBitmap = mesh.normalBitmap !== null ? await resolveBitmap(mesh.normalBitmap) : null
    // ONE binding per buffer: the pipeline's attribute names are the same
    // in GLSL and WGSL (position/normal/uv/joints/weights) — no inPos/a_joints
    // dual bookkeeping like the hand-written shaders had.
    const attributes = {}
    const textures = {}
    const uniforms = {
      u_mvp: (p) => p.mvp,
      u_model: (p) => p.model,
      u_lightDir: LIGHT_DIR,
    }
    if (variant === 'pbr' || variant === 'pbrNmap') {
      // The Cook-Torrance inputs: camera position (the view vector), the
      // glTF metallic/roughness factors, the light radiance
      attributes.position = { data: mesh.positions, size: 3 }
      attributes.normal = { data: mesh.normals, size: 3 }
      attributes.uv = { data: mesh.uvs, size: 2 }
      uniforms.u_lightColor = LIGHT_COLOR
      uniforms.u_ambient = AMBIENT_COLOR
      uniforms.u_camPos = (p) => p.camPos
      uniforms.u_roughness = mesh.roughness
      uniforms.u_metallic = mesh.metallic
      if (variant === 'pbr') uniforms.u_alphaCutoff = mesh.alphaCutoff
    } else if (variant === 'textured') {
      attributes.position = { data: mesh.positions, size: 3 }
      attributes.normal = { data: mesh.normals, size: 3 }
      attributes.uv = { data: mesh.uvs, size: 2 }
      uniforms.u_alphaCutoff = mesh.alphaCutoff
    } else if (variant === 'normalmap') {
      attributes.position = { data: mesh.positions, size: 3 }
      attributes.uv = { data: mesh.uvs, size: 2 }
    } else if (variant === 'skinned') {
      attributes.position = { data: mesh.positions, size: 3 }
      attributes.normal = { data: mesh.normals, size: 3 }
      attributes.joints = { data: mesh.joints, size: 4 }
      attributes.weights = { data: mesh.weights, size: 4 }
      uniforms.u_albedo = mesh.albedo
      uniforms.u_bones = (p) => p.bones
    } else if (variant === 'matcap') {
      attributes.position = { data: mesh.positions, size: 3 }
      attributes.normal = { data: mesh.normals, size: 3 }
      // the view matrix: the matcap is sampled by the VIEW-space normal
      uniforms.u_view = (p) => p.view
      uniforms.u_albedo = mesh.albedo
    } else {
      attributes.position = { data: mesh.positions, size: 3 }
      attributes.normal = { data: mesh.normals, size: 3 }
      uniforms.u_albedo = mesh.albedo
    }

    // The material: a feature mask → the assembled minimal GLSL+WGSL pair,
    // cached by the numeric key (the same object on every re-attach).
    const material = MATERIALS[variant]()

    // Textures: glTF bitmaps are already decoded by the parser (createImageBitmap)
    let glTexture = null
    if ((variant === 'pbr' || variant === 'pbrNmap') && bitmap !== null) {
      glTexture = activeRenderer.texture(bitmap.width, bitmap.height)
      glTexture.uploadImage(bitmap)
      textures.u_tex = glTexture
      textures.texTexture = glTexture
      if (variant === 'pbrNmap' && normalBitmap !== null) {
        const glNormal = activeRenderer.texture(normalBitmap.width, normalBitmap.height)
        glNormal.uploadImage(normalBitmap)
        textures.u_normalMap = glNormal
        textures.nrmTexture = glNormal
      }
      // The glTF metallicRoughness map (G = roughness, B = metallic)
      if (mesh.mrBitmap !== null) {
        const mrBitmap = await resolveBitmap(mesh.mrBitmap)
        if (mrBitmap !== null) {
          const glMr = activeRenderer.texture(mrBitmap.width, mrBitmap.height)
          glMr.uploadImage(mrBitmap)
          textures.u_mrTex = glMr
          textures.mrTexture = glMr
        }
      }
    } else if (variant === 'textured' && bitmap !== null) {
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
    } else if (variant === 'matcap' && mesh.matcapSource !== null) {
      const matcapBitmap = await createImageBitmap(mesh.matcapSource)
      glTexture = activeRenderer.texture(256, 256)
      glTexture.uploadImage(matcapBitmap)
      textures.u_matcap = glTexture
      textures.matTexture = glTexture
    }

    const spec = {
      id: `${id}:${mesh.name}:${variant}`,
      shader: { glsl: material.glsl, wgsl: material.wgsl },
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
  // Transparent meshes after opaque ones (the house: grass/leaves/windows on top)
  drawMeshes.sort((a, b) => a.order - b.order)
  attached.set(id, { meshes: drawMeshes.map(m => m.command), stats: model.stats })
  if (model.animation !== undefined && model.animation.clipName !== null) {
    shell.log.event(
      `Animation: clip “${model.animation.clipName}” — ${model.animation.jointCount} joints, ` +
      `${model.animation.duration.toFixed(1)} s loop`,
    )
  }
}

/** Bitmap from a GltfImage (promise) — null if decoding fails. */
async function resolveBitmap(image) {
  if (image === null || image === undefined) return null
  try {
    return await image.bitmap
  } catch {
    return null
  }
}

/* ─── Renderer and the frame loop ───────────────────────────────────────────────── */

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
// The camera eye (the mat4LookAt origin) — reused per frame, feeds the PBR
// view vector (u_camPos); x/y are the fixed orbit pivot, z follows camDist.
const camPos = new Float32Array([0, 0.55, 3.2])
let cachedAspect = 0

// Rotation: auto-spin + drag (touch/mouse), pitch is clamped.
// Zoom: two-finger pinch (the distance ratio) + mouse wheel.
let yaw = 0.6
let pitch = 0.18
let camDist = 3.2
const CAM_DIST_MIN = 1.7
const CAM_DIST_MAX = 6.5
let dragging = false
let lastX = 0
let lastY = 0
let lastInteraction = 0

function clampDist(d) {
  return Math.min(CAM_DIST_MAX, Math.max(CAM_DIST_MIN, d))
}

function bindInput(canvas) {
  canvas.style.touchAction = 'none'
  const pointers = new Map() // id → {x, y}
  let pinchStartDist = 0
  let pinchStartCam = camDist

  const distance = () => {
    const [a, b] = pointers.values()
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  canvas.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 1) {
      dragging = true
      lastX = event.clientX
      lastY = event.clientY
    } else {
      dragging = false // two fingers — pinch, not orbit
      pinchStartDist = distance()
      pinchStartCam = camDist
    }
    lastInteraction = performance.now()
    // Pointer capture is best-effort: synthetic/test events have no active
    // pointer, and a lost pointer must not break the gesture.
    try { canvas.setPointerCapture(event.pointerId) } catch { /* released or synthetic */ }
  })
  canvas.addEventListener('pointermove', (event) => {
    const tracked = pointers.get(event.pointerId)
    if (tracked === undefined) return
    tracked.x = event.clientX
    tracked.y = event.clientY
    if (pointers.size >= 2) {
      // pinch zoom: the same gesture distance ratio → camera distance ratio
      const d = distance()
      if (pinchStartDist > 1) {
        camDist = clampDist(pinchStartCam * (pinchStartDist / Math.max(d, 1)))
      }
    } else if (dragging) {
      const dx = event.clientX - lastX
      const dy = event.clientY - lastY
      lastX = event.clientX
      lastY = event.clientY
      yaw += dx * 0.006
      pitch = Math.min(1.2, Math.max(-1.2, pitch + dy * 0.006))
    }
    lastInteraction = performance.now()
  })
  const stop = (event) => {
    pointers.delete(event.pointerId)
    if (pointers.size === 0) dragging = false
    // one finger left after a pinch — restart the orbit from its position
    if (pointers.size === 1) {
      const [a] = pointers.values()
      lastX = a.x
      lastY = a.y
      dragging = true
    }
  }
  canvas.addEventListener('pointerup', stop)
  canvas.addEventListener('pointercancel', stop)
  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && pointers.size === 0) dragging = false
  })
  // desktop: wheel zoom
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault()
    camDist = clampDist(camDist * (1 + event.deltaY * 0.0012))
    lastInteraction = performance.now()
  }, { passive: false })
}

/** Frame: an orbit camera (drag/pinch/wheel), the model rotates (turntable)
 *  and animated models advance their clips. */
function frameCallback(ctx, record) {
  if (ctx.aspect !== cachedAspect) {
    cachedAspect = ctx.aspect
    mat4Perspective(projection, Math.PI / 3.4, ctx.aspect, 0.1, 100)
  }
  mat4LookAt(view, 0, 0.55, camDist, 0, 0, 0)
  mat4Multiply(viewProj, projection, view)
  camPos[2] = camDist

  // auto-spin: paused while dragging and for 1.5 s after
  if (!dragging && performance.now() - lastInteraction > 1500) yaw += ctx.dt * 0.35

  mat4RotationX(rotX, pitch)
  mat4RotationY(rotY, yaw)
  mat4Multiply(spin, rotX, rotY)

  const scene = attached.get(currentModelId)
  if (scene === undefined) return
  const current = prepared.get(currentModelId)
  const bounds = current?.bounds
  if (bounds !== undefined) {
    const scale = 1.5 / bounds.radius
    mat4Scale(fit, scale)
    fit[12] = -bounds.center[0] * scale
    fit[13] = -bounds.center[1] * scale
    fit[14] = -bounds.center[2] * scale
  }
  mat4Multiply(model, spin, fit)
  mat4Multiply(mvp, viewProj, model)
  // skeletal animation: advance the clip and hand the bone palette over
  const animation = current?.animation
  if (animation !== undefined) animation.advance(ctx.dt)
  const bones = animation !== undefined ? animation.palette : null
  // `view` feeds the matcap (the view-space normal lookup); `camPos` feeds
  // the PBR view vector.
  for (const command of scene.meshes) record(command, { mvp, model, bones, view, camPos })
}

async function boot(mode) {
  const seq = ++bootSeq

  if (activeRenderer !== null) {
    try { activeRenderer.dispose() } catch { /* the context may have died with the canvas */ }
    activeRenderer = null
    attached.clear()
  }
  shell.slot.replaceChildren()
  const canvas = document.createElement('canvas')
  canvas.id = 'canvas'
  shell.slot.append(canvas, pill, sheet, dragHint)
  bindInput(canvas)
  // the drag hint disappears at the first touch of the scene
  canvas.addEventListener('pointerdown', () => dragHint.classList.add('mv-gone'), { once: true })
  setTimeout(() => dragHint.classList.add('mv-gone'), 8000)

  shell.log.event(`Booting: “${MODE_NAMES[mode] ?? mode}”`)

  try {
    const renderer = createRenderer({
      canvas,
      backend: mode === 'auto' ? undefined : mode,
      clear: { color: [0.07, 0.08, 0.11, 1], depth: 1 },
      // Silent validation error channels (GL_INVALID_* / WebGPU uncaptured):
      // without them a “black canvas” explains nothing — the demo standard requires a log
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
    shell.log.info(`Backend: ${backendName}${renderer.backend === 'webgl2' && mode === 'auto' ? ' (fallback)' : ''}`)

    // Loaded models compile on the new renderer on demand
    if (prepared.has(currentModelId)) {
      await attachScene(currentModelId)
      if (seq !== bootSeq) return
      renderSheetState()
    }
  } catch (error) {
    if (seq !== bootSeq) return
    const message = error instanceof Error ? error.message : String(error)
    shell.setBadge(mode === 'webgpu' ? 'WebGPU unavailable' : 'startup failed', 'err')
    shell.log.error(`Boot on “${mode}” failed: ${message}`)
    if (mode === 'webgpu') {
      shell.log.info('This is not a library error — the backend is missing in this browser. Switch the toggle to Auto or WebGL2.')
    }
    return
  }

  shell.log.event('Rendering started')
  const live = shell.slot.querySelector('canvas')
  shell.log.info(`Canvas: ${live.clientWidth}×${live.clientHeight} css-px, DPR ${window.devicePixelRatio}`)
  shell.markReady()
}

shell.log.info(`WebGL2: ${typeof WebGL2RenderingContext !== 'undefined' ? 'present in the browser' : 'missing'}`)
setSheetOpen(true) // first visit: the sheet with the Load button is the entry point
renderSheetState()
statsLine.textContent = 'pick a model and press Load'
await boot(shell.mode)
