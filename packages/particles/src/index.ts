/**
 * @rune/particles — a CPU-simulated, GPU-agnostic particle system.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PACKAGE CONTRACT (the layer):
 *
 *   Pure CPU-side simulation. The package knows NOTHING about the GPU,
 *   renderers, shaders or loaders:
 *     IN : spawner descriptions (shapes, velocity modes, ranges),
 *          force fields (gravity, drag, turbulence), dt
 *     OUT: a camera-facing billboard SOUP — one Float32Array of
 *          pos3/uv2/color4 vertices, 6 per particle — consumed as plain
 *          vertex attributes by any draw command (the demo binds it to
 *          an unlit TEXTURE + VERTEX_COLOR material with additive
 *          blending; @rune/materials owns that part)
 *   No instancing, no point sprites, no transform feedback — the soup is
 *   the lowest common denominator of WebGL2 AND WebGPU draw paths.
 *
 *   Two levels of API (the repo's facade + composable core split):
 *     facade : createParticles — rate/burst/advance/billboards, the
 *              ramp, the forces, the spin — one chainable object
 *     core   : createParticleSystem (the SoA store) + createSpawner /
 *              createRamp / fillBillboards — composable for custom
 *              emitters, GPU-side reinterpretation, tooling
 *
 *   PERFORMANCE discipline (the core's mobile rules):
 *     - zero allocations per frame: flat SoA fields (13 floats +
 *       the seed), the spawn record and the ramp scratch are reused,
 *       the soup buffer is allocated once at capacity; billboards()
 *       returns a REUSED view object (the scene.cull pattern)
 *     - swap-remove compaction (a reverse walk — nothing processed
 *       twice, nothing skipped); one exp per FRAME for the drag
 *     - stateless integer-hash spawning: emission is a pure function
 *       of (seed, index, property) — pause/resume and re-bursts are
 *       bit-identical, call order never matters
 *     - binary-search ramp sampling (the clip-sampling pattern of
 *       @rune/animation)
 *
 *   THE GALAXY KIT (Task 117, the emitter power of three-nebula-style
 *   demos): the disc shape takes `arms` / `armSpread` / `twist` — spiral
 *   arm density; the spawner takes `speedByRadius` (Keplerian shear:
 *   speed·(ref/r)^power — the inner rim outruns the outer) and
 *   `colorByRadius` (the tint follows the radius: a warm core, cool arms).
 *   Together with tangential velocity they make a shearing spiral galaxy
 *   from ONE declarative spawner (see the demo's galaxy preset).
 *
 *   DETERMINISM: same inputs → same bits, every time, every backend.
 *   The clock belongs to the caller: advance(dt) is driven from the
 *   render loop. The facade owns the rate accumulator, not the frame.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type { ParticleFields, SpawnRecord, ForceFields, ParticleSystem } from './system.ts'
export { createParticleSystem, NO_FORCES } from './system.ts'
export type { SpawnShape, VelocityMode, SpawnerDesc, Spawner } from './spawn.ts'
export { createSpawner, hash01 } from './spawn.ts'
export type { RampPoint, Ramp } from './ramp.ts'
export { createRamp, sampleRamp, CONSTANT_RAMP } from './ramp.ts'
export { fillBillboards, SOUP_STRIDE, VERTS_PER_PARTICLE } from './billboards.ts'
export type { CameraBasis, BillboardOptions } from './billboards.ts'
export type { ParticlesDesc, Particles, SoupView } from './facade.ts'
export { createParticles } from './facade.ts'
