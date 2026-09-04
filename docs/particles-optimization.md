# @rune/particles — the optimization program

Status: **the baselines are in, the plan is written, nothing has been ported
yet.** This document is the map for the next optimization pass: what we
measured, what it means, what to move where, and which seams in the code
are already prepared for it.

---

## 1. The etalons (measured, this repo, Bun 1.3 / one core)

`bun packages/particles/bench/particles.bench.ts` (median of 5 runs):

| stage | 100k live | ns/particle | notes |
|---|---|---|---|
| **advance + bake** (the full frame) | **10.5 ms** | 105 | what a demo pays |
| ├─ **advance only** (integrate + forces + retire) | **1.85 ms** | 18.5 | the GPGPU candidate |
| └─ **bake only** (soup expansion + ramp sampling) | **8.7 ms** | 87 | **the real bottleneck** |
| bake's output | 20.6 MiB soup/frame | — | 100k × 6 verts × 9 floats |
| forces-heavy (noise + seek + collide + limit) | 19.6 ms | 196 | the worst-case advance |
| emission (100k one-shot burst) | 21.5 ms | 215 | the spawn path |
| steady state (~9.5k live, typical demo) | 1.08 ms | 114 | fine as-is |
| allocation identity (500 frames) | STABLE | — | zero allocations per frame |

**The headline: the CPU simulation is NOT the bottleneck.** At 100k live
particles the integration walk costs 1.85 ms; the *billboard soup bake*
— expanding each particle into 6 vertices × 9 floats on the CPU, then
uploading the whole thing every frame — costs **8.7 ms and 20.6 MiB of
frame traffic**. 83% of the frame is geometry expansion that the GPU
could do itself.

(Reference point: the grass field demo already proves the pattern —
42,000 blades, ONE instanced draw, all vertex math on the GPU, ~0 CPU
per frame. The particle soup is the same problem, unsolved.)

## 2. The plan (phased, each phase independently shippable)

### Phase 1 — the instanced draw path (kills the bake, the big win)

Replace the per-particle 6-vertex soup with **one quad drawn N times**:

- The quad's 4 corner positions come from `gl_VertexID`/`@builtin(vertex_index)`
  (the grass field's exact trick — no vertex buffer at all).
- Per-particle data rides INSTANCE attributes: `i_pos vec3, i_size float,
  i_color vec4, i_uv0 vec2 (tile), i_spin float, i_seed float` — 13 floats
  per particle written straight from the SoA store (5.2 MiB at 100k vs
  today's 20.6 MiB soup, and no per-vertex expansion at all).
- The VERTEX shader does the billboard math (camera/vertical/horizontal/
  stretched/oriented modes are all a `u_mode` uniform switch), the ramp
  sampling (a small uniform-array LUT or a 1D texture), the atlas tile
  pick, the spin. This is exactly what `fillBillboards` does today, moved
  across the bus.
- Expected: the bake's 8.7 ms → ~1 ms (a store→instance-buffer pack),
  upload traffic 20.6 → 5.2 MiB, and the draw count unchanged (1 per layer).
- CPU cost after Phase 1 at 100k: ~2.8 ms/frame (advance 1.85 + pack ~1).

Works identically on WebGL2 and WebGPU (both have instanced draws; the
engine's `step: 'instance'` attribute plumbing already exists — the feed's
star quads and the grass field use it).

### Phase 2 — GPGPU advance (kills the integration walk)

Only worth it after Phase 1 (it attacks the remaining 1.85–2.8 ms):

- **WebGPU**: the SoA store becomes storage buffers (or one interleaved
  `array<f32>` buffer). A compute pass integrates: gravity/drag/noise/seek/
  collide/limit, one workgroup per 64 particles, `@builtin(invocation_index)`
  as the particle id. Retirement/compaction stays CPU-side (a compact
  readback of the alive index list — one `uint32 × count` buffer, cheap)
  or moves to a prefix-sum pass later.
- **WebGL2** (no compute shaders): two options —
  a. **transform feedback**: the integration as a vertex shader over the
     particle buffer, ping-ponged between two VBOs (the classic pre-compute
     GPGPU); renderable as the Phase-1 instance source directly — zero
     readbacks.
  b. **float-texture ping-pong** (the WebGL1-era fallback): RGBA32F
     attachments, positions/velocities as texels. Slower, only if (a) is
     blocked (feedback loop restrictions on some drivers).
- Emission stays CPU-side initially (215 ns/spawn is fine up to ~50k/s;
  a GPU RNG hash + an append buffer is the later step).

### Phase 3 — the small stuff (do opportunistically)

- **Sorting**: translucent layers currently draw in spawn order; a
  depth-bucket sort (64 buckets by view-space z, counting sort, per layer)
  costs ~0.5 ms at 100k and kills most of the popping. GPU bitonic sort
  only if the buckets prove insufficient.
- **Culling**: a per-layer frustum reject of the whole facade, then a
  per-particle distance cull baked into the Phase-1 pack loop (one
  comparison per particle).
- **Bake micro-optimizations** (if Phase 1 is deferred): the ramp's binary
  search is ~6 branches/particle — a flat LUT of 64 samples linearly
  interpolated turns it into 2 loads; `Math.hypot` → a squared-norm fast
  path in the stretched mode's rest check.
- **Spawn-side**: the hash RNG (`hash01`) is already stateless and fast;
  the emission cost is dominated by validation + field writes, both
  irreducible without changing the contract.

## 3. The seams prepared in the code (as of this document)

- `system.ts` — the SoA store is one flat `Float32Array` per field
  (`ParticleFields`), publicly readable AND writable through the facade
  (`facade.fields`): a GPU backend can bind the same store as instance
  sources without touching the API surface.
- `facade.ts` — the two stages of the frame are already isolated calls:
  `advance(dt)` (all simulation) and `view(basis)` (all baking). A Phase-1
  or Phase-2 backend swaps the IMPLEMENTATION of exactly one of them.
- `billboards.ts` — `fillBillboards` is a pure function of (store, basis,
  options): its math is the reference semantics the vertex-shader port
  must reproduce bit-for-bit (the existing tests are the parity suite).
- `field.ts` (grass) — the working precedent for the whole pattern:
  CPU-baked instance arrays + GPU vertex expansion, both backends, one
  draw. Phase 1 is "field.ts, but for the dynamic soup".
- `bench/particles.bench.ts` — the etalon harness with `--json`: run it
  on the same machine before/after any phase; the numbers in section 1
  are the pre-port reference.

## 4. What NOT to do yet

- No WebGPU-only features on the hot path (the dual-backend contract is
  the product; WebGL2 keeps parity via transform feedback, not stubs).
- No async readbacks in the frame path (the WebGPU readback exists and
  works, but a per-frame `mapAsync` stall would eat the win; Phase 2's
  compaction is the only allowed readback, batched).
- No change to the demo-facing API (`createParticles` desc, facade
  methods) — the optimization is internal by contract.
