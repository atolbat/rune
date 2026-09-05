# @rune/particles — the optimization program

Status: **Phase 1 (the instanced draw), Phase 2 (the GPGPU tier) and
Phase 3 (the WebGL2 transform-feedback twin + the painter's order) are
SHIPPED** (Tasks 131–132). The etalons below carry the before/after; the
phases describe what moved where, and what remains.

---

## 1. The etalons (measured, this repo, Bun 1.3 / one core)

`bun packages/particles/bench/particles.bench.ts` (median of 5 runs):

| stage | the soup (before) | the instanced path (after) | notes |
|---|---|---|---|
| **advance + bake** (100k live) | 10.5 ms | **5.3 ms** (advance 1.8 + pack 3.5) | the CPU frame of a draw:'instance' layer |
| └─ **bake only** (the 6-vertex CPU expansion) | 8.7 ms | — | replaced by the GPU corner expansion |
| └─ **pack only** (Task 131: the 16-float records) | — | **3.6 ms** | ~2.4 ms with a constant ramp |
| the per-frame traffic | 20.6 MiB | **6.1 MiB** | 3.4× less |
| forces-heavy (100k) | 19.6 ms | 19.6 ms (CPU) / ~0 CPU (GPU tier) | the GPU tier runs them as compute |
| emission (100k one-shot) | 21.5 ms | 21.5 ms | CPU-side in both tiers |
| steady state (~9.5k live) | 1.05 ms | ~0.7 ms | |
| allocation identity (500 frames) | STABLE | STABLE | both paths |

The GPGPU tier's CPU cost at 160k live (the GPU Embers demo): **~1 ms**
(emission + the aging walk + the handoff) — the forces, the aging on the
GPU, the wrap and the record pack all run as compute passes; the per-frame
CPU→GPU particle traffic is the emit block + the swap list only.

## 2. Phase 1 — the instanced draw path ✅ SHIPPED

`render: { kind: 'billboard', draw: 'instance' }` — one quad drawn N times:

- `instances.ts` — `packInstances()`: ONE 16-float record per particle
  (pos, vel, the ramp-resolved color, the half-extent/spin/seed/age
  parameters, the atlas tile origin). The count parity with
  `fillBillboards()/6` is pinned by tests; the JS twin of the shader math
  is the bit-reference (the parity suite, task131.test.ts).
- The **BILLBOARD material feature** (@rune/materials): the vertex stage
  expands the 6-corner quad from `gl_VertexID` / `@builtin(vertex_index)`
  — all five modes (camera/vertical/horizontal/stretched/oriented), the
  spin, the atlas tile scale — one draw call: 6 vertices × N instances.
  The fragment stage composes unchanged (ALPHA_CUTOFF, SOFT_PARTICLES,
  OUTPUT_DITHER all work on top).
- The soup stays the default (the LCD contract); every billboard layer of
  /demo/vfx/ moved to the instance path (73 layers).

## 3. Phase 2 — the GPGPU tier (WebGPU compute) ✅ SHIPPED (opt-in)

`sim: 'gpu'` — the WebGPU compute tier:

- **The state** lives in one storage buffer (the SoA fields interleaved,
  17 floats × capacity — the `FIELD_NAMES` seam). The CPU keeps the
  count/age/life (emission, death, compaction); the positions/velocities
  are GPU-authoritative.
- **The readback-free split**: the CPU never reads the GPU state. Death
  is the CPU's own age/life walk; the compaction's swap list is collected
  by the `onSwap` hook and REPLAYED on the GPU (the same moves in the
  same order — the exact CPU compaction).
- **The passes** (`gpuSim.ts`'s WGSL, dispatched by `@rune/gl`'s
  `createGpuParticles` between `advance()` and the draw): `compact` (the
  swap replay) → `advance` (gravity/drag/turbulence/attract/noise/limit +
  the integration + age + the wrap) → `pack` (the same 16-float instance
  records, GPU-side — the render binds the buffer directly, ZERO
  per-frame CPU→GPU particle traffic).
- **The forces supported**: gravity, drag, turbulence, attract (static),
  noise (the same permutation table as the CPU), limitSpeed, wrap. The
  CPU-coupled features are rejected LOUDLY (onRetire, collide, seek,
  speedCurve, attract.killRadius, prewarm — the death site and the
  contact events are CPU-blind).
- **The parity gate** (`scripts/task131-wgsl-sim.mjs`, the raw-device
  path): after 90 frames of gravity+drag, the GPU state matches the CPU
  reference to **1 f32 ULP** (worst |Δ| = 0.00001 over 2250 particles);
  the pack records match at the same tolerance; the noise run moves
  2048/2048 with zero NaN.
- **The demo**: "GPU Embers" (#24) — 160k embers on WebGPU; the same demo
  on WebGL2 runs the CPU tier at 32k (the tier split, not a stub — the
  dual-backend look-parity contract keeps every other demo on sim:'cpu').

## 3b. Phase 3 — the WebGL2 TRANSFORM-FEEDBACK twin ✅ SHIPPED (Task 132)

**The SSBO's twin — the common point**: `createGpuParticles(facade,
backend)` now dispatches by the facade's shape — a WebGPU `GPUFacade`
(`createCompute`) runs the compute tier above; a WebGL2 `GLFacade`
(`createTransformPass`) runs the **transform-feedback tier** (Task 133:
the dispatch itself moved to `@rune/core`'s `gpgpu.ts` — `createGpgpu`;
`@rune/gl`'s `createGpuParticles` is the particles binding). The demo
code is identical for both backends; the tier is the library's business.

- **The state** lives in one rgba32f texture (a flat texel array, 5 texels
  = 20 floats per particle — the 3-float pad keeps every TF row 4-float
  aligned, the attribute-offset rule). The TF output's sequential texel
  order matches the texture exactly — `texSubImage2DBuffer` (the PBO
  upload) round-trips the state buffer→texture with zero CPU traffic,
  the WebGL2 twin of the storage-buffer ping-pong.
- **The passes** (`gpuSimGl.ts`'s GLSL, dispatched by `@rune/gl`'s
  `createGpuParticlesTf`, now over the `@rune/core` TF tier — Task 133):
  `compactAdvance` (ONE gather pass — vertex i =
  final slot i reads the pre-state of particle `map[i]` through the
  texture, integrates it, writes slot i; the WGSL compact + advance
  composed) → the PBO round-trip → `pack` (vertex i = `gl_VertexID` — the
  same 16-float instance records, bound directly as the draw's instance
  attributes through `bufferId`).
- **The map**: the CPU compaction's provenance — the swap list replayed
  on indices exactly as the WGSL compact replays it on state; `map[j]` =
  the pre-slot of the particle that ends up at slot j. Pinned by a golden
  test (positions encoding their own pre-slots).
- **The facade's handoff** gained the catch-up: a MANUAL `burst()` between
  advances now reaches the GPU (the emit gather starts at the synced
  count, not the current one — the between-advance bursts were silently
  lost before, on BOTH tiers).
- **The renderer seams** (`@rune/webgl2`): the TF family
  (`createTransformPass` / `runTransformPass` / `deleteTransformPass` /
  `texSubImage2DBuffer`) — the GLSL twin of the WebGPU compute contract
  (a packed uniform array, buffer/texture inputs, ONE output buffer; the
  state contract: RASTERIZER_DISCARD only inside begin/end, the TF object
  + its bindings unbound after, a DEDICATED VAO so the renderer's vertex
  state never sees the pass).
- **The dormant-bug harvest**: the enum fix (`GL_RGBA32F` is 0x8814, not
  0x8816 — the typo survived the mock-based tests since the Task 67 HDR
  work; no demo allocated a float texture until this tier) and the
  Float32Array-view rule for FLOAT uploads (ANGLE rejects Uint8Array
  views).
- **The demo**: "GPU Embers" now runs `sim:'gpu'` on BOTH backends — 160k
  on WebGPU, 16k on WebGL2 (the software-GL budget; a real GPU carries
  far more).

## 3c. The painter's order — `render.sort` ✅ SHIPPED (Task 132)

`render: { ..., sort: true }` on a billboard layer: **back to front**
(depth = dot(forward, position), far first — `sort.ts`). The SAME index
sequence feeds both bakers (the soup quads and the instance records —
the draw-format parity), the comparator is a total order (engine-independent
determinism), the scratch is caller-owned (zero per-frame allocation).
Additive layers need nothing (the blend commutes); the trail kind rejects
it (one continuous ribbon), the mesh kind rejects it (the depth buffer
resolves), `sim:'gpu'` rejects it (the records are packed GPU-side — no
CPU positions to sort; the CPU mirror holds none by design). Applied to
the alpha-blended smokes: the sentry's impact smoke, the explosion, the
dust, the soft, the slash dust, the laser's charge wisps and boom smoke.

## 4. The renderer seams added (Task 131)

- `@rune/webgpu`: external buffers (`createExternalBuffer` /
  `writeExternalBuffer` / `readExternalBuffer` / `bindExternalVertexBuffer`)
  and compute (`createCompute` / `runCompute` — a fixed five-binding
  layout: 0 uniform, 1 rw, 2 ro, 3 rw, 4 ro storage; one bind group per
  family; dispatches enqueue before the render pass opens).
- The WGPU command/executor: an attribute with `bufferId` binds the
  external buffer (the GL side already had the contract — the feed's
  dual-bind).
- `@rune/gl`: `createGpuParticles(facade, gpuFacade)` — the orchestrator
  (Task 133: the particles binding; the tier controller itself is
  `@rune/core`'s `createGpgpu`).

## 5. What remains (the opportunistic list)

- ~~**WebGL2 transform feedback**~~ — ✅ shipped (Phase 3b above).
- ~~**Sorting**~~ — ✅ shipped (Phase 3c above: the full depth sort, the
  painter's order; a counting-sort bucket pass stays interesting for
  100k+-sized alpha layers).
- **Culling**: a per-particle distance cull in the pack loop (one
  comparison) + the per-layer frustum reject.
- **Emission on the GPU**: a hash-RNG append pass (the 215 ns/spawn CPU
  cost is fine to ~50k/s).
- **The GPU-tier sort**: a compute/TF bitonic sort over the records (the
  CPU tier's mirror holds no positions — the GPU-side key pass would
  come with the culling pass above).
- **The ramp LUT as a texture** (the pack's binary search → a texture
  fetch): ~1 ms at 100k, only if the GPU pack ever needs the relief (the
  TF tier already does it — texture fetches in GLSL).

## 6. The verification of this program (Tasks 131–132)

- `task131.test.ts` — the instance path's parity suite (the packer, the
  JS twin vs fillBillboards, the facade integration).
- `task131gpu.test.ts` — the facade's sim:'gpu' contract (validation,
  the handoff protocol, the CPU mirror's determinism).
- `task132.test.ts` — the painter's order (the sort, the draw-format
  parity, the validation rejections).
- `tests/particlesGpuGl.test.ts` (@rune/gl) — the TF tier: the GLSL
  generation (the ES 3.00 contract, the reserved words, the force
  order), the provenance golden test, the step sequence, the dispatch.
- `tests/transformFeedback.test.ts` (@rune/webgl2) — the TF family's
  state contract (the varyings-before-link, the discard/TF bind/unbind
  sequence, the dedicated VAO, the PBO upload's bind/restore).
- The WebGPU pipeline cache's vertex-layout key (the Sword Slash crash's
  renderer-side root): two commands sharing a shader+desc but binding
  different strides are DIFFERENT pipelines — pinned in command.test.ts.
- `scripts/task131-wgsl-raw.mjs` — the BILLBOARD material's WGSL rendered
  PIXEL-VERIFIED on a raw device (the camera-mode quad: position, extent,
  color, uv through the real pipeline).
- `scripts/task131-wgsl-sim.mjs` — the compute sim's 1-ULP parity vs the
  CPU reference (the raw-device gate).
- `scripts/task131-sim-probe.mjs` — the on-hardware state gate (the local
  SwiftShader env cannot mapAsync the live device — the documented
  limitation; local coverage is the raw gate above).
- The full demo gates: demo-smoke (24 live), demo-shots (24 ×
  motion+alive+bright + the round trip), task128-probe (24 cycling on the
  WebGPU flags, the GPU tier live at 104k, GPU log clean).

## Task 133 — the tier controller extracted to @rune/core

The SSBO↔transform-feedback common point left the particles stack and became a
backend-agnostic primitive: `@rune/core`'s `gpgpu.ts` (`createGpgpu`) — the
dispatch by facade shape, the tracked-resource lifecycle (dispose in reverse
creation order, once), and the f32/u32 uniform scratch. `@rune/gl`'s
`createGpuParticles` is now the particles binding on top of it
(`particlesGpu.ts` / `particlesGpuGl.ts` / the shared `particlesGpuConfig.ts`
force interpretation). The WebGPU facade gained `deleteCompute` (the compute
family's staging uniform buffer was leaked on every orchestrator re-attach
before). The deterministic simplex noise (`simplex3`/`PERM`/`GRAD3`) moved to
`@rune/core/noise.ts` and `hash01` to `@rune/core/random.ts` (bit-identical,
re-exported by @rune/particles) — the CPU↔GPU parity tables are a
cross-backend contract, not a consumer's property.

## Task 134 — the GPU render tier: the bitonic sort + the frustum cull

The render-side half of the GPGPU tier (the list's own remaining items):
`render.sort` and `render.cull` now run ON THE GPU, on BOTH backends, as a
SECOND kernel family over the same four buffers.

- **THE SORT FAMILY** (`@rune/particles` `gpuSimWgsl`/`gpuSimGl*`): `sortKeys`
  builds the (key, index) pairs — the NEGATED depth key (−dot(forward, p):
  an ascending network draws far-to-near, the painter's order); the culled
  and the pads carry the sentinel (PAD_KEY 1e30, index 2^25) so they sort to
  the END. The bitonic network is dispatched over the canonical (k, j)
  sequence (`gpuSortPassSequence`: log₂N·(log₂N+1)/2 passes). The sorted
  `pack` gathers `state[pairs[i].y]` — the visible prefix lands far-to-near,
  the sentinel tail packs the ZERO record (half extent 0 — a degenerate
  instance that draws nothing; the draw count stays the CPU's count, no
  readback).
- **THE CULL**: `gpuRenderFrustum` (Gribb–Hartmann over the frame's
  column-major mvp, normalized) feeds six planes to `sortKeys`; the test is
  the conservative sphere `size · rampMax · 0.5 ≥ every drawn extent` — a
  sprite never pops at the edge. Cull-only mode = sortKeys + the sorted pack
  (TWO extra passes, no network — the cheap gate).
- **THE SELF-DRIVING NETWORK** (the WebGPU shape): the frame's compute
  dispatches share ONE encoder, and `queue.writeBuffer` lands before EVERY
  dispatch in it — a per-pass (k, j) uniform would collapse to the LAST
  write (all 171 passes running the same compare-exchange: found by the
  raw-device gate reading the records back). The fix: the (k, j) state rides
  the RECORDS buffer's head (`sortKeys` seeds (2, 1); the new `sortStep`
  entry advances it: j > 1 → (k, j/2), j == 1 → (2k, k), k > padN → done).
  The orchestrator dispatches `[bitonic, sortStep] × passCount` with a
  pass-INVARIANT uniform. The GLSL twin keeps the direct per-pass uniforms —
  the GL facade sets them at pass EXECUTION time (the immediate path has no
  batched-encoder collapse).
- **THE CAMERA CONTRACT**: `step(dt, camera?)` — `camera.forward` (the sort
  axis, loud throw when missing), `camera.viewProj` (the cull planes). The
  vfx shell's frame context carries both (`ctx.basis.forward`, `ctx.mvp`).
- **THE DEMO**: GPU Embers takes the cull on the compute leg by default and
  `?sort=1`/`?cull=1` force both flags on the TF leg (the software GL's PBO
  round-trips fall back to CPU copies — the "TexSubImage with unpack buffer"
  performance warning — so the default leg stays at Task 132's tuned 16k).
  The `?v` cache-bust moved to 134 across the vfx page (one module instance
  — a split `?v` instantiates the bundle twice and corrupts the shared-state
  rendering; pinned the hard way).

**Gates**: `tests/task134.test.ts` (the (k, j) model vs Array.sort, the pair
semantics, the frustum golden, the WGSL/GLSL sources, the facade flips);
`tests/particlesGpuGl.test.ts` (the TF sort pipeline's recorded sequence +
the SSBO dispatch sequence via a recording compute facade);
`scripts/task134-wgsl-sort.mjs` (the raw-device gate: the real WGSL compiled
and run — the readback records verified far-to-near with the culled slots
zeroed); `scripts/task134-vfx-probe.mjs` (the live page with both flags,
JS-side aliveness — the count climbs at 13k with the network running); the
demo-shots motion gate gained the RETRY (the SwiftShader compositor stalls
intermittently — a live page measured 0.07% → 0.30% → 73.10% in three
consecutive windows; the gate takes up to three windows and passes on the
first moving one — a genuinely frozen canvas never recovers).

**Remaining from the original list**: GPU-side emission (the hash-RNG append
pass — the last CPU-coupled half of the frame); a `render.cull` mode for the
CPU tier (the packers' `order` mechanism could filter, but the CPU tier has
no camera planes today — the option rejects loudly instead).
