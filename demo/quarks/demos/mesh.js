// mesh.js — three.quarks' MeshMaterialDemo ("Mesh Standard Material with
// Environment Map"): particles that are REAL 3D MESHES — capsules with a
// Cook-Torrance PBR material (metallic 1.0, roughness 0.2), tumbling in
// 3D (their Rotation3DOverLife), prewarmed so the fountain opens flowing.
// Our env-map stand-in is the direct sun + the ambient sky fill (the
// @rune/materials PBR model — a true IBL is a future feature of its own).
export default {
  title: 'Mesh Particles (PBR)',
  sub: 'capsule instancing · Cook-Torrance · 3D tumble · prewarm',
  camera: { yaw: 0.6, pitch: 0.28, dist: 7.5, orbit: 0.06, target: [0, 1.2, 0] },

  make(env) {
    // A LOW-poly capsule (8 radial × 3 cap segments = 80 tris = 240 verts
    // per particle — the soup budget: 90 alive × 240 = 21.6k verts/frame).
    const geo = env.geometry.capsule({ radius: 0.16, height: 0.62, radialSegments: 8, capSegments: 3 })

    const layer = env.addLayer({
      id: 'mesh-capsules',
      facade: env.createParticles({
        capacity: 110,
        rate: 26,
        prewarm: 6,
        ramp: env.createRamp([
          { t: 0, size: 0.4, r: 0.95, g: 0.97, b: 1, a: 1 },
          { t: 0.2, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0.55, r: 0.85, g: 0.88, b: 0.95, a: 1 },
        ]),
        forces: { gravity: [0, -2.6, 0], drag: 0.15, turbulence: 0 },
        spawner: {
          // their demo: a cone r 0.1 angle 1, speed 1, life 2–3, rotating
          shape: { kind: 'cone', origin: [0, 0, 0], axis: [0, 1, 0], halfAngle: 0.9, baseRadius: 0.12, length: [0, 0.05] },
          velocity: { mode: 'lobe' },
          speed: [0.9, 1.5], life: [2.4, 3.4], size: [2.6, 3.4],
          color: [[0.75, 0.77, 0.8, 1], [0.62, 0.66, 0.72, 1]], seed: 131,
        },
        render: { kind: 'mesh', geometry: geo, axis: 'random', spin: 2.4 },
      }),
      material: env.materials.pbr,
      // solid meshes: depth WRITE on (they occlude each other), back-face
      // culling on (closed capsules)
      pipeline: { depth: { test: 'less', write: true }, raster: { cull: 'back' } },
      uniforms: {
        u_albedo: [0.82, 0.84, 0.88, 1], // the neutral metal base; the soup tint modulates
        u_lightDir: () => env.LIGHT_DIR,
        // THEIR demo's metallic look comes from an ENVIRONMENT MAP; our PBR
        // is the two-light outdoor model (a sun + an ambient sky fill — a
        // real IBL is a future feature of its own). Full metal (metallic=1)
        // KILLS the diffuse and ambient terms — one sun on a mid-roughness
        // metal reads near-black. 0.72 keeps a bright brushed-metal look:
        // a strong specular lobe + the residual diffuse.
        u_lightColor: [2.6, 2.5, 2.35, 1],
        u_ambient: [0.55, 0.6, 0.75, 1],
        u_roughness: 0.16,
        u_metallic: 0.72,
      },
    })

    return {
      frame(ctx) {
        layer.facade.advance(ctx.dt)
      },
    }
  },
}
