# @rune/particles — the optimization program

Status: **Phase 1 (the instanced draw), Phase 2 (the GPGPU tier), Phase
3 (the WebGL2 transform-feedback twin + the painter's order), the GPU
render tier (Task 134: the bitonic sort + the frustum cull), the GPU-side
emission (Task 135) and the real-GPU TF pipeline defaults (Task 138) are
SHIPPED — the program is COMPLETE** (Tasks 131–138); **Task 139 (the
packed-slot contract) fixed the real-GPU default-path freeze the Task 138
flip exposed — see its retro at the bottom.** The etalons below carry the before/after; the
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
- ~~**Emission on the GPU**~~ — ✅ shipped (Task 135 above: the hash-RNG
  append pass, both backends — the compute leg by default, the TF leg's
  `?emit=1`).
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

## Task 135 — GPU-SIDE EMISSION: the hash-RNG append pass

The last CPU-coupled half of the GPU tier's frame is gone — on the WebGPU
compute leg entirely, on the WebGL2 TF leg as an opt-in (`?emit=1`):
`emit: 'gpu'` on the facade. The newborns' rows are GENERATED ON THE GPU
(one `emit` entry/pass over the window), through the SAME hash stream the
CPU spawner draws (`@rune/core`'s integer `hash01` — bit-portable to WGSL
u32 and GLSL uint); the CPU keeps ONE scalar per newborn — the life (the
death clock of the aging ledger, the same hash draw). The wins: the
215 ns/spawn CPU walk dies (a 100k one-shot burst: ~11 ms → ~0), the
per-frame emit-block upload dies (zero CPU→GPU particle traffic for the
birth rows), the mirror's dead integration dies (the LEDGER walk —
age/retire/compact only), and the 17×capacity row scratch is not even
allocated (11 MiB at 160k).

- **THE UNIFORM GREW 144 → 448 bytes** (the sim family's one uniform):
  the emit block (36 floats of forces, then the window/`streamBase`/
  discriminants/seed, the shape's frame + scalars, the ranges, the
  colors, the per-frame `atOrigin`/`emitterV`) — all frame-constant, so
  the WebGPU batched-encoder uniform collapse class cannot touch it.
- **THE WINDOW**: `[emitBase, emitBase+emitCount)` at its pre-compaction
  slots, hash-indexed from the GLOBAL stream counter (the anti-jet fix's
  own domain — the kernel and the ledger hash the SAME particle). The
  GLSL twin carries the 32-bit stream/seed as TWO 16-bit float halves
  (float32 holds integers exactly only to 2^24 — the stream grows
  unboundedly; the shader recombines the bits in uint).
- **THE SUPPORT SURFACE**: the closed-form shapes (point/sphere/cone/
  disc+arms/hemisphere/donut/rectangle/grid-random/line-random) and all
  five velocity modes; the LOUD rejects: the path shape, the lattice
  modes (call-local semantics), speedByRadius/colorByRadius, the seek
  target, `orient()` and the runtime spawner replacement (the static
  interpretation is packed at attach — `rate(x)` alone stays free).
- **THE JS REFERENCE TWIN** (`gpuEmitRowModel`) — the parity oracle,
  pinned BIT-EXACT against the real CPU spawner over 11 shape
  configurations (task135.test.ts); the raw-device gate
  (scripts/task135-wgsl-emit.mjs) holds the WGSL to it with a SPLIT
  tolerance: the hash-lerp fields (life/size/color/seed — pure hash) at
  2e-7, the position/velocity fields at the f32 trig class (each
  backend's own transcendentals; SwiftShader's trig runs ~1.5e-4
  relative). The in-page GLSL gate (scripts/task135-glsl-emit.mjs) does
  the same for the TF twin on a real WebGL2 context.
- **THE TF TIER'S OWN LESSON** (three bugs found by the live page): the
  GLSL hash index FORGOT `+ gl_VertexID` — every newborn of a window got
  the same particle (one additive pileup at one point → a rasterizer
  death spiral on SwiftShader); backticks inside a template-literal
  comment split the shader source; and the interleaved
  TF-write → PBO-read → TF-write cycle on ONE buffer stalls the
  software-GL queue (the demo's TF leg now defaults `emit:'cpu'` — the
  barrier discipline: one producer + one consumer per buffer per frame;
  the dedicated emitOut buffer keeps the capability for `?emit=1`).
- **THE DEMO**: GPU Embers — `emit: compute ? 'gpu' : 'cpu'` (the same
  gating pattern as the cull flag): the compute leg emits GPU-side at
  160k; the container's software-GL TF leg keeps the proven CPU path
  (motion 99.5% at 16k in this session's gates). `?emit=1` forces the
  TF append pass on.
- **Gates**: `tests/task135.test.ts` (18: the model-vs-spawner parity,
  the config rejects, the layout maps, the facade's ledger/window/
  catch-up/replacement contract, the WGSL/GLSL source contracts);
  `tests/particlesGpuGl.test.ts` += 3 (the emit dispatch sequence —
  BEFORE compact, no row upload; the emit:'cpu' upload unchanged; the
  loud attach reject); `scripts/task135-wgsl-emit.mjs` (the raw device);
  `scripts/task135-glsl-emit.mjs` (the in-page GLSL values).

**Remaining from the original list**: a `render.cull` mode for the CPU
tier (the packers' `order` mechanism could filter, but the CPU tier has
no camera planes today — the option rejects loudly instead); the TF
leg's GPU emission on the software-GL container (the real-GPU story is
expected to take `?emit=1` as the default once a hardware oracle
confirms the queue behavior).

## Task 136 — the WebGL2 TF sampler-units fix + the CPU-tier cull

**THE BLACK SCREEN OF THE TF TIER** (the user's report: "Embers на вебгл
работают некорректно — не видны, исчезают, другой цвет, текстуры видны
квадами"). The container reproduced it dead-on: the WebGL2
transform-feedback leg of GPU Embers rendered 0.00% ember-tinted pixels
(black) with an occasional full-screen WHITE flash (37% of the canvas at
240,240,240 — the "quads"). The CPU half was healthy (13–15k live) — the
RECORDS were the garbage. Root cause, found by instrumenting the live GL
context: **`runTransformPass` bound the pass's textures to units 0..N−1
but never set the sampler uniforms** — GLSL samplers DEFAULT TO UNIT 0,
so the pack pass's `u_ramp` sampled the STATE texture. The ramp LUT
binary search then walked unsorted state values (px/vy/age/tx, ±23) —
`span` degenerated, the lerp factor extrapolated, `halfExtent` exploded
to full-screen scale with rgb up to ±23 (the white quads), and the
records' colors read state texels instead of the ramp (wrong/negative
colors; additive black). The packSorted twin was hit twice (`u_ramp` AND
`u_pairs`); the single-texture passes (advance/sortKeys/bitonic) worked
only by the luck of the default. THE FIX: one `gl.uniform1i(sampler, i)`
per bound texture in `realGL.ts` — the DRAW path has set its units since
Task 118 (the executor's `setUniform1i`); the TF family finally matches.
The gate blindness (motion 99.5% on a BLACK page): the camera orbit and
the pool glow moved pixels — the ember-tint gate now lives in the
timeline probe (`scripts/ember-timeline.mjs`, warm-pixel time series).

**THE CPU-TIER CULL** (the remaining list's own item — "the packers have
no camera planes today"): `render.cull` now runs on BOTH tiers. The CPU
tier's gate lives at `view()`: the basis carries `viewProj` (16 floats,
column-major — the frame's mvp), the facade extracts the six normalized
frustum planes ONCE per view (`gpuRenderFrustum` — the GPU tier's own
Gribb–Hartmann), and BOTH bakers (fillBillboards' soup + packInstances'
records) skip every particle whose conservative sphere (spawn size ×
rampMax · 0.5) is fully outside any plane — the GPU sortKeys test
mirrored EXACTLY (dot(n,p)+d ≤ −radius, all six planes; the parity is
pinned by an oracle test). The semantics per tier: the GPU tier packs
ZERO records for the culled (no readback, the draw count holds); the CPU
tier just SKIPS them — the soup's vertex count and the record count drop
(the upload shrinks with the view; strictly better than zero-records).
The stretched mode's velocity tail is NOT covered by the sphere (the
GPU tier's own documented conservatism) — the demo adoption stays on
camera-mode layers. Where it landed: the vfx dust motes (1,500 wrapped
motes, the fly-through volume — 140 visible records of 1,297 live in the
gate), the noise jet (3,000, the far end off-screen), and the particles
demo's fireworks + meteor presets (the soup upload shrinks).

**Gates**: `webgl2/tests/transformFeedback.test.ts` += 2 (the sampler
units, before the draw; the partial-bindings skip); `tests/task136.test.ts`
(12: the bakers' gate, the survivors-byte-identity, the soup/instance
parity under the gate, the GPU-oracle match, the order interplay, the
facade's loud viewProj contract, the radius factor); the task134
"CPU-tier rejects cull" test retired to the new acceptance. The live
verification: the ember timeline (warm 1.6–1.8% STABLE for 20 s — was
0.00% + the white flash), demo-smoke 24/24, demo-shots ALL alive (dust
motion 72.68%), the raw-device gates (sim/sort/emit WGSL + GLSL) PASS,
`task134-vfx-probe` (?sort=1&cull=1 on the TF leg) PASS.

## Task 137 — a retro note (the re-run roots + the real-GPU capacity)

The re-run blackout (the user's report: "the 2nd and further WebGL runs
show NO particles while the pill keeps counting") had two roots, both
outside the particles package proper, both fatal to the TF tier's story.
**The dangling enabled attribs**: `deleteBuffer` never severed the VAO's
`vertexAttribPointer` associations (the GLES3/WebGL2 spec leaves them),
so the GPU particle tier's dispose (toggle / demo-switch / re-boot) left
2–4 enabled locations pointing at DELETED buffers — the next `drawArrays`
DROPS with INVALID_OPERATION on strict drivers (ANGLE/D3D, Vulkan GL;
SwiftShader validates only a subset, which is why the container could not
reproduce the user's symptoms). The fix lives in `@rune/webgl2`: the
bind-time attrib ledger (the post-delete GL query is ambiguous — a real
context returns null for a deleted buffer's location) + the deleteBuffer
disarm — 7 dropped draws per demo-switch cycle → 0. **The context-life
contract**: every backend toggle used to LEAK a live context (past the
browser's per-page cap the eviction race can land on the ACTIVE context —
the "2nd run is black" class); dispose now loses the context
(`WEBGL_lose_context`) and `webglcontextlost` is handled honestly (the
loop stops, the report lands — no zombie). The capacity went
HARDWARE-AWARE the same way: the 16k cap was the SwiftShader budget
(32k at 1280×800 ≈ 12 fps); a real GPU carries the same 160k as the
compute tier (the `UNMASKED_RENDERER_WEBGL` probe — the user's "way
fewer particles on WebGL" was exactly a real browser hitting the
software-GL budget). Gates: `scripts/task137-vfx-probe.mjs` (the re-run
gate: the 1st run warm + the capacity pin, the demo-switch cycles with
ZERO drops, the verified-WebGPU round trip, the synthetic context-loss
leg), 7 renderer tests.

## Task 138 — THE REAL-GPU TF PIPELINE BY DEFAULT: the program closes

The last remaining item ("the real-GPU story is expected to take
`?emit=1` as the default once a hardware oracle confirms the queue
behavior") is closed by the hardware oracle itself: the user's live
confirmation on a real GPU ("работает щас"). The WebGL2
transform-feedback leg now takes the FULL GPU pipeline with NO opt-ins
on anything but the software-GL class — `emit:'gpu'` (the hash-RNG
append pass; the dedicated emitOut buffer keeps the
one-producer/one-consumer barrier discipline) + the frustum cull (the
pairs round-trips are hardware paths off the software GL). The
SwiftShader/llvmpipe class keeps the proven conservative defaults — the
forced combination saturates the software raster (measured again by this
task's gate: ~460 ms/frame at 16k, the compositor falls >90 s behind
while the JS loop and the emission ledger stay alive — the
busy-rasterizer class). The value-aware flags override BOTH branches in
BOTH directions: `?emit=1`/`?cull=1` force the GPU path on any hardware,
`?emit=0`/`?cull=0` force the CPU path (the escape hatch — a real-GPU
regression falls back without a code change), the bare `?emit`/`?cull`
keep the Task 135/134 force-on meaning, and `?sort` stays the pure
opt-in (the additive blend composites order-independently — the network
is the ALPHABLEND tier's tool). The perf report grew the policy fields
(`emit`, `cull`, `sort`, `softwareGL` — `window.__vfxPerf`) so the gates
pin the branch the page took.

**Gates**: `scripts/task138-vfx-probe.mjs` — five legs, each a FRESH
page (a saturated SwiftShader renderer chokes even a follow-up
navigation — a 60 s goto timeout at `domcontentloaded`): (A) the default
stays conservative (emit cpu, cull false, capacity 16000, warm pixels,
the count alive, zero drops); (B) `?emit=1&cull=1` (the policy flips,
the emission ledger alive, zero drops — the JS-side aliveness convention;
the VALUES are task135-glsl-emit's job); (C) the escape hatch parses AND
renders; (D) the bare `?emit`; (E) `?sort=1`. THE HARNESS LESSONS
pinned in the gate's header: a leg's demo can be made several times in
quick succession (the toggle's reboot re-makes the active demo) — reads
must settle on a STABLE perf-object generation (the identity check, up
to 4 windows); and the aliveness oracle under a saturated raster is
"the count is not FROZEN", not "the count climbs" (the burst's natural
retirement declines the count from ~4 s; an exact equality across 1 s
means a dead loop — the zombie class).

**The program is COMPLETE.** Every item of the original optimization
list has shipped: the instanced draw (Phase 1), the GPGPU compute tier
(Phase 2), the WebGL2 transform-feedback twin + the painter's order
(Phase 3), the GPU render tier (the bitonic sort + the frustum cull),
the GPU-side emission, the CPU-tier cull, the re-run roots, and the
hardware-aware full-pipeline defaults. What remains is deliberately NOT
here: the closed-form spawner surface for `emit:'gpu'` (path/lattice/
seek reject loudly — the v1 boundary, documented in Task 135), the
stretched-mode cull conservatism (the velocity tail outside the sphere,
Task 136), and the next GPGPU consumers (ocean, skinning, fields —
`@rune/core`'s `createGpgpu` is waiting for them).

## Task 139 — THE PACKED-SLOT CONTRACT: the real-GPU default-path freeze

The user's live report, one task after the program "closed": "вебгл эмберс
полностью зависают; один раз — сверхяркое зеленоватое пятно и всё
зависло." The Task 138 defaults put the REAL-GPU TF leg on
`emit:'gpu'` + the cull at 160k — a path the container gates had never
PIXEL-verified (task138's leg B checked only the JS ledger aliveness by
design: "no pixel gate on this leg"). The freeze reproduced in the
container the moment the flags forced the same path, and the forensics
(`scripts/task139-embers-forensics.mjs`) read the records straight off the
TF output buffers: **garbage** — halfExtent 2.2 vs the control's 0.05
(giant quads, ~2000× the drawn area), colors dark green-dominant
(`cg` up to 0.2 over `cr` 0.07 — the "greenish spot"), alpha 0 — and the
frame rate collapsed to ~7 fps at 16k (the fill-rate blowup; at the
user's 160k, seconds per frame — the frozen tab).

**The root cause — one line of `runTransformPass`** (realGL.ts): the
packed-uniform walk `continue`d on a null location BEFORE `at +=
u.size`. The emit pass declares `u_emitBase`/`u_emitCount` but never
READS them (`gl_VertexID` drives the rows) — the GLSL compiler optimizes
the pair out, `getUniformLocation` returns null, and the skipped advance
shifted EVERY uniform after the pair two floats early. The whole block
misread: `u_shapeOrigin` saw `(seedLo, seedHi, origin.x) = (417, 0, 0)`,
`u_atOrigin` saw `(origin.y, 0, 0) = (−1.5, 0, 0)` — the newborns landed
at exactly `(415.5, 0, 0)` with life drawn from the SPEED row's range
and size from the LIFE row's. The fix is the PACKED-SLOT CONTRACT: an
optimized-out uniform still OCCUPIES its slots — the uniform CALL is
skipped for a null location, the slot WALK never is. (Why the raw
emit-values gate never caught it: task135-glsl-emit's own harness walks
WITHOUT a null-check — `uniform1f(null, v)` is a legal no-op and its
`at += u.size` always advanced. The facade's walk was the only one with
the early `continue`. Why the compute leg never had it: the WGSL uniform
block rides a staging BUFFER — no per-name locations at all.)

The same task closed the latent ARRAY_BUFFER overlap: `createBuffer` /
`updateBuffer` left the buffer on the generic ARRAY_BUFFER binding —
WebGL2 raises INVALID_OPERATION if that buffer is later captured by
`bindBufferBase(TRANSFORM_FEEDBACK_BUFFER)`, silently dropping the TF
write on strict drivers (the task135 harness's own pinned lesson — its
createBuffer unbinds; the facade's did not). Both now leave the generic
binding empty.

**Gates**: `scripts/task139-embers-forensics.mjs` — the isolation matrix
(F0 default / FE `?emit=1` / FC `?cull=1` / FB `?emit=1&cull=1`), each
leg a fresh page, a full GL call tracer (cost + getError per call), the
TF output buffers captured at `bindBufferBase` and read back via
`getBufferSubData(COPY_READ_BUFFER)` (no library changes), and the
records' garbage signature scan (NaN/Inf, halfExtent magnitude, color
ranges, position collapse). THE GATE LESSONS: the forensics readback
itself can 219-s-block on a saturated ANGLE queue (read the buffers
BEFORE the screenshots; screenshots can 45-s-timeout — the starve is
itself freeze evidence, record it and carry on); a leg's page can CRASH
outright under the load (every step try/catch so the evidence collected
before the crash still lands); one leg per process (LEG env — a
saturated renderer eats minutes). `scripts/task139b-emit-diff.mjs` — the
differential that pinned the root: the demo's emitOut vs the JS
reference model (gpuEmitRowModel) for the EXACT window, plus a scratch
re-run of the demo's own shader with the orchestrator's exact uniform
packing — the scratch reproduced the garbage bit-for-bit (a uniform-layer
bug, not the round-trip), and the (415.5, 0, 0) arithmetic identified
the two-slot shift by hand. Post-fix: all four legs' records SANE
(halfMax ~0.05, in-range colors, zero NaN), FE's frame count 195 vs 39
in the same window (the saturation is gone), warm pixels on every leg,
zero GL errors, zero dropped draws. 1593 tests (+2: the packed-slot
contract, the ARRAY_BUFFER discipline), task135-glsl-emit PASS (the
values gate), task137-vfx-probe PASS, task138-vfx-probe PASS, ?v=139.

### Task 140 — THE SELF-HEALING EMBERS (the real-GPU invisible report)

The user's post-?v=139 report: **"no freeze anymore, but the particles
are not visible, while the counter at the bottom keeps counting."** The
freeze fix landed; the visible output died with it.

**The forensics arc** (`scripts/task140-*.mjs` — 10 probes, each killing
a hypothesis): the renderer-string spoof reproduced the user's EXACT page
config in-container (160k + emit:'gpu' + cull, no flags); the records
read back SANE at every capacity; the ember `drawArraysInstanced` was
issued with the live count every frame; zero GL errors. The pixel
verdicts kept flipping cold/starved — **until `--enable-unsafe-swiftshader`
joined the launch flags and the 40k screenshot landed WARM, matching the
in-frame `readPixels` oracle that had read warm all along** (the
drawing-buffer truth, read INSIDE the frame, before the swap — the
compositor was the liar, not the pipeline). The container cannot
reproduce the user's symptom: at every capacity and branch combination
the pipeline validates end-to-end. The verdict: a live-driver-only drop
(the transform-feedback write silently failing, or a draw-side
staleness, on the real ANGLE-D3D11 class the software raster never
exercises) — invisible, un reproducible, and telling the user nothing.

**The fix — defense in depth, three layers:**
1. **`createBuffer(data, usage)`** — the TF tier's five buffers
   (stateOut/records/mapBuf/emitOut/pairsOut) are rewritten EVERY frame
   (a TF pass's stream output, read back the same frame as a
   vertex/PBO source) — they now take `'dynamic'` (DYNAMIC_DRAW), the
   semantically correct hint; `'static'` (the default) keeps the
   historical one-shot-upload behavior.
2. **`readBuffer(bufferId, dst)`** — the facade's GPU-side readback
   surface (COPY_READ_BUFFER, one-shot diagnostics; false = refused =
   "unknown", never "degenerate") — through the journal/session wrappers
   and `@rune/core`'s TfComputeTier.
3. **THE SELF-HEALING DEMO** — `GpuParticles.diagnostics`: the TF tier's
   one-shot records check (frame ~30: read 64 floats, scan for the
   degenerate signature — all-zero/NaN rows while the ledger counts).
   The demo's two-stage ladder: stage 1 polls the records verdict;
   stage 2 (frame ~45) arms an in-frame canvas pixel sample right after
   the ember draw (a one-shot `drawArraysInstanced` wrapper, removed
   after first fire). Either failure → ONE console warning with the
   whole story → `window.__embersFallback` (read at MAKE time — the
   module-scope constant would freeze the import-time value; found by
   the trigger probe) → the shell's `__vfxRemakeRequested` channel →
   `activateDemo` re-makes the demo in the CONSERVATIVE mode (emit:'cpu',
   cull off — the Task-137-era configuration the user's GPU
   demonstrably rendered). `perf.fallback: 'selfcheck'` pins the branch
   for the probes; a reload retries the GPU pipeline; `?emit=1&cull=1`
   forces it back on.

**The gates** (`task140n`/`task140p`): the healthy leg — diagnostics
fire at frame 30, verdict SANE, NO false fallback, warm pixels; the
forced-fallback leg — the conservative branch with warm pixels; the
trigger leg — a simulated dropping driver (the readback zeroed at the
source) → the warning → the re-make → the conservative branch → warm
pixels. 1596 tests (+3: the usage-hint contract, the readBuffer
round-trip + refusal), ?v=140.
