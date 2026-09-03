// soft.js — three.quarks' SoftParticleDemo ("Soft Particle & Blend
// Tiles"): smoke that fades smoothly where it intersects the SCENE
// DEPTH — no hard quad cuts through the torus knots. Theirs: a
// WebGLRenderTarget with a depthTexture; ours: a DEPTH PREPASS into a
// color surface (the window depth packed into RGB — the WebGL1-era
// technique, backend-identical) + the SOFT_PARTICLES material feature
// (Task 122): the fragment compares its own gl_FragCoord.z against the
// prepass and fades base.a within the near range.
//
// The prepass surface is a FIXED size; its projection uses the SURFACE
// aspect, so the frustum matches the canvas exactly at any resize (the
// uv mapping is normalized on both sides).
export default {
  title: 'Soft Particles',
  sub: 'depth prepass · fade at intersections · frame-animated smoke',
  camera: { yaw: 0.6, pitch: 0.1, dist: 8.2, orbit: 0.05, target: [0, 0.6, 0] },

  make(env) {
    const renderer = env.renderer

    // ── the scene: three torus knots (baked translations — static soup) ──
    const knot = env.geometry.torusKnot({ radius: 0.55, tube: 0.16, radialSegments: 48, tubularSegments: 7 })
    const place = (dx, dz, scale) => {
      const positions = new Float32Array(knot.positions.length)
      for (let v = 0; v < knot.vertexCount; v++) {
        positions[v * 3] = knot.positions[v * 3] * scale + dx
        positions[v * 3 + 1] = knot.positions[v * 3 + 1] * scale + 1.1
        positions[v * 3 + 2] = knot.positions[v * 3 + 2] * scale + dz
      }
      return { positions, normals: knot.normals, uvs: knot.uvs, vertexCount: knot.vertexCount }
    }
    const knots = [
      place(-2.3, 0, 1),
      place(2.3, 0.4, 0.85),
      place(0, -1.6, 1.1),
    ]
    for (const geo of knots) {
      env.addMesh({ id: 'soft-knot', geometry: geo, material: env.materials.lambert, uniforms: { u_albedo: [0.5, 0.55, 0.62, 1] } })
    }

    // ── the depth prepass: a raw command writing the PACKED window depth ──
    // The same position attribute + u_mvp as every scene mesh; the fragment
    // packs gl_FragCoord.z into RGB (24 bits). GLSL and WGSL pairs — the
    // renderer command compiles both, the executor picks its own.
    const DEPTH_VERT_GLSL = `#version 300 es
layout(location = 0) in vec3 position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`
    const DEPTH_FRAG_GLSL = `#version 300 es
precision highp float;
out vec4 o_color;
void main() {
  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * gl_FragCoord.z;
  enc = fract(enc);
  enc -= vec4(enc.y, enc.z, enc.w, enc.w) * (1.0 / 255.0);
  o_color = enc;
}`
    const DEPTH_WGSL = `
struct DepthParams {
  u_mvp : mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> params : DepthParams;
struct VSOut {
  @builtin(position) pos : vec4<f32>,
}
@vertex
fn vsMain(@location(0) position : vec3<f32>) -> VSOut {
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(position, 1.0);
  return out;
}
@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  var enc = vec4<f32>(1.0, 255.0, 65025.0, 16581375.0) * frag.pos.z;
  enc = fract(enc);
  enc = enc - vec4<f32>(enc.y, enc.z, enc.w, enc.w) * (1.0 / 255.0);
  return enc;
}`

    // one prepass command per knot (three static geometries) — the surface
    // capture re-targets them
    const prepassCommands = knots.map((geo, i) => renderer.command({
      id: `soft-prepass-${i}`,
      shader: { glsl: { vertex: DEPTH_VERT_GLSL, fragment: DEPTH_FRAG_GLSL }, wgsl: DEPTH_WGSL },
      pipeline: { depth: { test: 'less', write: true }, raster: { cull: 'back' } },
      attributes: { position: { data: geo.positions, size: 3 } },
      uniforms: { u_mvp: (p) => p.mvp },
      count: geo.vertexCount,
    }))

    // the prepass SURFACE (a fixed 640×480 — the aspect-corrected
    // projection below makes any size work; recreated on renderer reboots)
    const SURF_W = 640
    const SURF_H = 480
    const surface = renderer.inner.surface({ width: SURF_W, height: SURF_H, depth: true, color: [1, 1, 1, 1] })
    const captured = prepassCommands.map(cmd => surface.capture(cmd, { clear: true }))

    // ── the smoke: SOFT_PARTICLES — samples the prepass texture ──
    const smoke = env.addLayer({
      id: 'soft-smoke',
      facade: env.createParticles({
        capacity: 700,
        rate: 60,
        ramp: env.createRamp([
          // "Blend Tiles": the frame animation through the puff tiles
          { t: 0, size: 0.5, r: 0.62, g: 0.64, b: 0.68, a: 0, frame: 6 },
          { t: 0.2, size: 1.1, r: 0.68, g: 0.7, b: 0.74, a: 0.5, frame: 14 },
          { t: 1, size: 2.6, r: 0.6, g: 0.62, b: 0.66, a: 0, frame: 3 },
        ]),
        forces: { gravity: [0, 1.2, 0], drag: 0.8, turbulence: 0.4 },
        spawner: {
          shape: { kind: 'sphere', origin: [0, -0.5, 0], radius: [0.1, 0.6] },
          velocity: { mode: 'radial' },
          speed: [0.8, 1.6], life: [2.2, 3], size: [1.1, 1.7],
          color: [[0.85, 0.87, 0.92, 0.7], [0.7, 0.72, 0.78, 0.55]], seed: 223,
        },
        render: { kind: 'billboard', tiles: env.atlasTiles, spin: 0.6 },
      }),
      material: env.materials.soft,
      pipeline: env.pipelines.alpha,
      textures: {
        // both language names bound (the materials convention)
        u_depth: surface.texture,
        depthTexture: surface.texture,
      },
      props: (ctx) => ({ softParams: softParamsOf(ctx) }),
    })

    // the per-frame scratch: the surface-aspect projection + mvp
    const proj2 = new Float32Array(16)
    const mvp2 = new Float32Array(16)
    // THE PREPASS LAYER — registered LAST: it runs after the knots + the
    // smoke draw (back on the canvas — the frame's BeginPass rebinds it),
    // so the smoke samples the PREVIOUS frame's depth (one frame stale —
    // the standard practice for depth prepasses; the scene moves slowly).
    // Recording it FIRST would leave the surface FBO bound and every
    // following draw would land in the 640×480 surface, not on the canvas.
    env.addLayer({
      id: 'soft-prepass',
      record: (ctx) => {
        perspective(proj2, Math.PI / 3.2, SURF_W / SURF_H, 0.1, 200)
        multiply(mvp2, proj2, ctx.view)
        for (const cmd of captured) ctx.record(cmd, { mvp: mvp2 })
      },
    })

    /** The soft params: (1/w, 1/h, fadeRange, 0) — from the CANVAS buffer
     *  size (gl_FragCoord units); the surface size cancels out (both render
     *  the SAME frustum, uv-normalized). */
    const softParamsOf = (ctx) => {
      const cw = ctx.canvas?.width ?? ctx.width
      const ch = ctx.canvas?.height ?? ctx.height
      return [1 / Math.max(1, cw), 1 / Math.max(1, ch), 0.02, 0]
    }
    const perspective = (out, fovY, aspect, near, far) => {
      const f = 1 / Math.tan(fovY / 2)
      out.fill(0)
      out[0] = f / aspect; out[5] = f
      out[10] = far / (near - far); out[11] = -1
      out[14] = (far * near) / (near - far)
    }
    const multiply = (out, a, b) => {
      for (let c = 0; c < 4; c++) {
        const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3]
        out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
        out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
        out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
        out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
      }
    }

    return {
      frame(ctx) {
        smoke.facade.advance(ctx.dt)
      },

      dispose() {
        surface.dispose()
      },
    }
  },
}
