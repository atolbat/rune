/**
 * @rune/particles — a CPU-simulated, GPU-agnostic particle system.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PACKAGE CONTRACT (the layer):
 *
 *   Pure CPU-side simulation. The package knows NOTHING about the GPU,
 *   renderers, shaders or loaders:
 *     IN : spawner descriptions (shapes, velocity modes, ranges),
 *          force fields (gravity, drag, turbulence, attractor, collision,
 *          noise, seek, the speed curve), dt
 *     OUT: a GPU view — the billboard soup (pos3/uv2/color4), the trail
 *          ribbon soup (the same layout), or the MESH soup (pos3/nrm3/
 *          uv2/color4) — consumed as plain vertex attributes by any draw
 *          command (the demo binds it to the unlit TEXTURE + VERTEX_COLOR
 *          material, or LAMBERT/PBR for the mesh kind; @rune/materials
 *          owns that part)
 *   The soup is the lowest common denominator of WebGL2 AND WebGPU draw
 *   paths — the default and the LCD.
 *   (Task 131: the OPTIONAL instanced path — render.draw:'instance' —
 *   packs 16-float records and lets the BILLBOARD material expand the
 *   quad on the GPU.
 *    Task 132: the GPGPU simulation tier — sim:'gpu' — runs the forces,
 *   the aging and the record pack ON THE GPU on BOTH backends: compute
 *   passes over a storage buffer (WebGPU) or transform-feedback passes
 *   over a float texture (WebGL2 — the SSBO's twin; the ONE dispatch
 *   point — the tier controller — lives in @rune/core's gpgpu.ts (Task
 *   133), and @rune/gl's createGpuParticles is the particles binding;
 *   see gpuSim.ts/gpuSimGl.ts).
 *    Task 132: render.sort — the painter's order for alpha-blended
 *   billboards (back to front, both bakers, deterministic; see sort.ts).)
 *
 *   Two levels of API (the repo's facade + composable core split):
 *     facade : createParticles — rate/burst/at/advance/view, the ramp,
 *              the forces, the burst schedule, prewarm, the render kinds
 *              (billboard / trail / mesh) — one chainable object
 *     core   : createParticleSystem (the SoA store) + createSpawner /
 *              createRamp / fillBillboards / fillTrails / fillMeshes —
 *              composable for custom behaviors (write the fields between
 *              advance() calls — the "custom plugin" story), tooling
 *
 *   PERFORMANCE discipline (the core's mobile rules):
 *     - zero allocations per frame: flat SoA fields (16 floats +
 *       the seed), the spawn record and the ramp scratch are reused,
 *       the soup buffer is allocated once at capacity; view() returns a
 *       REUSED view object (the scene.cull pattern)
 *     - swap-remove compaction (a reverse walk — nothing processed
 *       twice, nothing skipped); one exp per FRAME for the drag
 *     - stateless integer-hash spawning: emission is a pure function
 *       of (seed, index, property) — pause/resume and re-bursts are
 *       bit-identical, call order never matters
 *     - binary-search ramp sampling (the clip-sampling pattern of
 *       @rune/animation)
 *
 *   THE EMITTER FAMILY: the shapes
 *   point/sphere/cone/disc(+arms)/line/hemisphere/donut/rectangle/grid;
 *   the seek TARGETS (point / image masks — the TextureSequencer);
 *   declarative bursts {time, count, cycle, interval, probability};
 *   prewarm; the live emitter origin at().
 *
 *   THE RENDER FAMILY (Task 122): billboard modes camera/vertical/
 *   horizontal/stretched/oriented + the ATLAS (tiles + the ramp's frame
 *   channel — FrameOverLife); TRAILS (the decimated position history +
 *   the ribbon baker); MESH particles (a real geometry with normals —
 *   the LIT materials shade them).
 *
 *   THE FORCE FAMILY (Task 122): gravity, drag, sine turbulence, the
 *   point attractor, the simplex noise field, collision planes with
 *   restitution/friction, the target seek spring, the speed-over-life
 *   curve, and LimitSpeedOverLife (the speed governor over the excess).
 *
 *   THE EMITTER-MOTION FAMILY (Task 124 — the game-feel knobs):
 *     inheritVelocity — newborns ride a fraction of the emitter's own
 *              velocity (a rocket's smoke drags behind the flight);
 *     rateOverDistance — emission per world unit TRAVELED (a sword edge,
 *              tire dust: the trail tracks the swing, not the clock);
 *     collide kill/onCollide — rain dies on the floor and SPLASHES
 *              (contact events, flushed after the integration walk).
 *
 *   THE GAME-FX FAMILY (Task 126):
 *     orient() — the emitter's ORIENTATION (their worldSpace:false — a
 *              rigid attachment: the exhaust cone follows the object's
 *              heading, not the world axes);
 *     wrap — the ENDLESS VOLUME: positions wrap into a box around the at()
 *              origin (camera-anchored rain/dust that reads as infinite);
 *     attract.killRadius — the SINK: particles entering the sphere are
 *              consumed (the funnel drain, with onRetire firing);
 *     path — the POLYLINE spawner (a jagged bolt in ONE burst: lightning,
 *              beams, fire walls).
 *
 *   THE HOOKS (Task 122): onRetire (the final state of every dead
 *   particle — sub-emitters) and onSwap (external per-slot state — the
 *   trails follow it automatically).
 *
 *   DETERMINISM: same inputs → same bits, every time, every backend.
 *   The clock belongs to the caller: advance(dt) is driven from the
 *   render loop. The facade owns the rate accumulator, not the frame.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type {
  ParticleFields, SpawnRecord, ForceFields, Attractor, ParticleSystem,
  CollisionPlane, CollisionSphere, CollisionBox, Collision, CollideRecord, SeekForce, LimitSpeedForce, RetireRecord, StoreOptions,
} from './system.ts'
export { createParticleSystem, NO_FORCES, MAX_PLANES, MAX_SPHERES, MAX_BOXES, FIELD_NAMES, PARTICLE_FLOATS } from './system.ts'
export type { SpawnShape, VelocityMode, SpawnerDesc, Spawner, TargetDesc, ImageMask } from './spawn.ts'
// Task 133 re-export origin: @rune/core's random.ts (bit-identical).
export { createSpawner, hash01 } from './spawn.ts'
export type { RampPoint, Ramp } from './ramp.ts'
export { createRamp, sampleRamp, CONSTANT_RAMP, RAMP_STRIDE } from './ramp.ts'
export type { BillboardMode } from './billboards.ts'
export { fillBillboards, SOUP_STRIDE, VERTS_PER_PARTICLE } from './billboards.ts'
export type { CameraBasis, BillboardOptions } from './billboards.ts'
export type { PackOptions, InstanceField } from './instances.ts'
export { packInstances, INSTANCE_STRIDE, INSTANCE_LAYOUT } from './instances.ts'
export { sortDepthBackToFront } from './sort.ts'
export {
  gpuSimWgsl, gpuRampLUT, GPU_STATE_STRIDE, GPU_SIM_UNIFORM_BYTES, GPU_SIM_UNIFORM_FLOATS,
  GPU_SIM_U32_FIELDS, GPU_SIM_F32_FIELDS, GPU_SIM_VEC4_FIELDS, GPU_FORCE_MASK, GPU_SIM_ENTRIES,
  gpuSortWgsl, GPU_SORT_UNIFORM_FLOATS, GPU_SORT_U32_FIELDS, GPU_SORT_F32_FIELDS,
  GPU_SORT_RENDER_MASK, GPU_SORT_PAD_KEY, GPU_SORT_SENTINEL, GPU_SORT_ENTRIES,
  gpuSortPadCount, gpuSortPassSequence, gpuRampMaxSize, gpuRenderFrustum,
} from './gpuSim.ts'
// Task 135 — GPU-side emission: the shared spawner interpretation + the JS
// reference twin (the parity model) + the WGSL uniform's emit-block layout.
export type { GpuEmitConfig } from './gpuEmit.ts'
export {
  readGpuEmitConfig, gpuEmitPackStatic, gpuEmitLife, gpuEmitRowModel,
  GPU_EMIT_SHAPE, GPU_EMIT_VEL, GPU_EMIT_SALTS, GPU_EMIT_MASK,
  GPU_EMIT_BASE, GPU_EMIT_U32_FIELDS, GPU_EMIT_VEC4_FIELDS,
} from './gpuEmit.ts'
export {
  gpuSimGlAdvanceGlsl, gpuSimGlPackGlsl, gpuRampLUTTexture, GPU_GL_STATE_STRIDE,
  GPU_GL_TEXELS_PER_PARTICLE, GPU_GL_STATE_TEXTURE_W, gpuGlStateTextureH,
  GPU_GL_ADVANCE_UNIFORMS, GPU_GL_ADVANCE_F, GPU_GL_PACK_UNIFORMS, GPU_GL_PACK_F,
  GPU_GL_ADVANCE_OUTPUTS, GPU_GL_PACK_OUTPUTS,
  gpuSimGlSortKeysGlsl, gpuSimGlBitonicGlsl, gpuSimGlPackSortedGlsl,
  GPU_GL_SORTKEYS_UNIFORMS, GPU_GL_SORTKEYS_F, GPU_GL_BITONIC_UNIFORMS, GPU_GL_BITONIC_F,
  GPU_GL_SORT_OUTPUTS, GPU_GL_SORT_PAD_KEY, GPU_GL_SORT_SENTINEL, gpuGlPairsTextureH,
  gpuSimGlEmitGlsl, GPU_GL_EMIT_UNIFORMS, GPU_GL_EMIT_F,
} from './gpuSimGl.ts'
export type { TrailOptions, TrailHistory, TrailBakeOptions } from './trails.ts'
export { createTrailHistory, fillTrails } from './trails.ts'
export type { MeshGeometry, MeshOptions } from './meshes.ts'
export { fillMeshes, MESH_STRIDE } from './meshes.ts'
export type { NoiseField } from './noise.ts'
// Task 133 re-export origin: @rune/core's noise.ts (bit-identical).
export { simplex3, validateNoise } from './noise.ts'
export type { GrassFieldDesc, GrassField } from './field.ts'
export { createGrassField } from './field.ts'
export type { ParticlesDesc, Particles, SoupView, SoupLayout, BurstDesc, RenderDesc, RenderBakeOverride, WrapDesc, GpuHandoff } from './facade.ts'
export { createParticles } from './facade.ts'
