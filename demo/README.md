# rune demos

Live examples of the renderer. Every demo lives **in its own folder** inside
`demo/`, references the **built bundle** of the library (`dist/rune.esm.js`)
and follows the shared shell standard: a mobile-first layout, a backend
toggle, a log panel.

## Demos online (GitHub Pages)

| Demo | Link | What it shows |
|------|------|---------------|
| hello-cube | https://atolbat.github.io/rune/demo/hello-cube/ | A cube in one line: `showAny()` / `showOn()`, an Auto/WebGL2/WebGPU toggle, a log with copy |
| model-viewer | https://atolbat.github.io/rune/demo/model-viewer/ | Three three.js example models: Forest House (glTF · AVIF · Draco — Cook-Torrance PBR from its glTF factors), Samba Dancing (FBX — skeleton, skinning, a looping clip), Nefertiti (glTF · object-space normal map), plus a procedural Matcap Cube. A fullscreen mobile-first viewer: a Load button with a progress bar (`AssetLoader`), model switching, drag rotation + pinch zoom; every shader is assembled by `@rune/materials` (a feature mask per mesh — no hand-written GLSL/WGSL). **Task 204 — tap-to-pick**: a tap (not a drag) casts the primary ray through `cameraRay` (no matrix inversion), transforms it into the model's baked local space analytically (`local = (Rᵀ·world − t)/s` — the column-major law), and walks a TWO-LEVEL BVH: the mesh tier (one AABB per prepared mesh, built at load), then the picked mesh's lazy per-triangle BVH — the hit reports the mesh name, the triangle, the distance and both BVHs' own stats; the picking boxes are additively inflated (the flat-geometry hygiene: a planar ground plane's degenerate AABB would kill corner-grazing rays in the slab test's float rounding); the page's own gates prove the walk (real vertices projected through the frame's matrices must be picked back — 40/40 — and the BVH's nearest-entry answers match the brute-force sweep on both tiers) |
| particles | https://atolbat.github.io/rune/demo/particles/ | `@rune/particles` live: eight presets (fountain, fireworks, galaxy, embers, drift, snow, orbit, meteor) built from the `createParticles` facade (the galaxy preset: 3 spiral arms, Keplerian shear, color-by-radius; orbit: a point attractor (the gravity behavior); drift: standing dust motes) — a CPU-simulated SoA store with deterministic hash spawning and over-life ramps, baked each frame into a camera-facing billboard soup (one interleaved buffer, one blended draw call, dynamic vertex count, zero allocations per frame); orbit + pinch zoom. **Task 204**: every preset runs the CPU-tier frustum cull (`render.cull` — the conservative per-particle sphere test, pixel-identical by construction; the pill carries the culled count, the accounting is exact), and the frame is a DECLARED GRAPH (`createFrameGraph` from `@rune/core` — the recipe as data): `sim → bake → upload → draw → present` with versioned resources (the persistent SoA state, the transient soup/soup-gpu, the overlay-law target), the ~4 Hz stats pass as a gated copy root, and Pause = the SIM pass gated out of the frame while the draw keeps presenting the frozen state — the staleness counter is the graph's own temporal-reuse metric, live in the HUD line |

| vfx | https://atolbat.github.io/rune/demo/vfx/ | The game-VFX study on `@rune/particles`: **24 demos in one carousel page** — every emitter shape, trails with floor collision, the texture sequencer (1500 particles seeking a text mask), PBR mesh particles, sub-emitters, the simplex noise field, alpha-tested falling petals, a custom SinWave behavior on the composable core, the billboard modes, soft particles with a color-encoded depth prepass, the blend equations, a follow-object emitter, a composed explosion, the sentry turret (tracers + beam volleys + reflection sparks), plus the rune originals (rocket, rainstorm, sword slash, vortex, fireflies, dust & haze, grass field, lightning storm, a cutting laser — a continuous lattice beam biting a visible sphere target, reflection sparks off the curvature — and the GPU compute tier: 160k embers advanced by WebGPU compute shaders over a storage-buffer state, the instance records packed GPU-side (WebGL2 runs the same demo on the CPU tier). Every sprite procedural (no image assets); exercises the whole library surface: the shape family, image seek targets, the burst schedule, prewarm, the live emitter origin `at()`/`orient()`, the atlas + FrameOverLife, trails, mesh particles with normals, collision planes, noise, the seek spring, SpeedOverLife, `onRetire` sub-emitters, custom blend equations, the `SOFT_PARTICLES` and `OUTPUT_DITHER` material features, and the GPU-static grass field. **Task 204 — the frame as a DECLARED GRAPH, at carousel scale**: every demo switch RE-DECLARES its own graph from the layer set it registered (`sim → prepass → bake:L → draw:L → labels → stats → present`), the sim's lane follows the tier (WG compute / GL transform-feedback / CPU — the occlusion tier's KERNEL law), the per-layer soup transients have disjoint lifetimes and the planner folds them into ONE aliasing slot (the Sentry Turret's 15 soups: −65% planned memory), and the OVERLAY LAW generalizes to every draw (each pipeline depth-tests → reads the target — a pure-write declaration let the graph cull the floor under the particles as a reader-less branch, caught by the probe and fixed); Pause gates the sim pass and the staleness counts in the HUD line |

| occlusion | https://atolbat.github.io/rune/demo/occlusion/ | **Hi-Z occlusion culling — the GPU-driven tier (Task 196)**: a z-prepass renders the occluder city into an r32float depth tile (a `createTarget` with a Task-196 pipeline **target-format variant**), a compute family builds the **max-reduced Hi-Z pyramid** (the `createCompute` **texture slots** — `textureLoad` on the tile through binding 6 — plus `reduceL1..L9` entry points with baked constants), the cull kernel projects every occludee AABB, picks the mip by the rect size and tests the box's NEAREST corner against the region's FARTHEST surface — the SOUND form of the test (the widely-copied min-reduce version is unsound; this demo's own pixel-parity gate caught it). The visible set compacts deterministically (no atomics) and the color pass draws it with **ONE `drawIndexedIndirect`** (the Task-196 facade contract, core WebGPU — no probe). The page's own gates: pixel parity ON vs OFF (sha256-identical over 3 cameras — culling occluded boxes cannot change a pixel), the accounting invariant (frustum + occluded + drawn = occludees), the live counters (51–71% culled at 16384 boxes). WebGPU only (compute); a software adapter (SwiftShader/llvmpipe) gets the honest **snapshot mode** — every frame renders into a surface and blits into a 2D canvas, zero canvas presents (the documented container present-death); the **WebGL2 tier (Task 197) is the same Hi-Z on the GL contracts**: an FBO pyramid over `r32f` data textures (the Task-197 GLTextureFormat growth), a transform-feedback cull pass (the library's GL compute substitute) writing per-instance verdict flags, and ONE instanced draw whose vertex shader collapses invisible instances — GPU-side visibility, zero CPU sync; the cross-tier gate proves both backends render the same scene (a bounded pixel compare: the measured cross-backend class is 0.001–0.65% of pixels off by 1–16 ULP of float rounding — structure-level equality, exact hash-exact only intra-tier). **Task 205 — the research harvest**: the niche papers measured on this page's own city — Greene's hierarchical tile tiers + the rawrunprotected coarse edge tests + the ryg/Dyrkorn incremental edge walk power the CPU occluder raster (1.9×), ryg's CSE corner transform cuts the query projection 96 mults → 24 (the hidden() sweep 1.3×), Sýkora–Jelínek plane-mask inheritance walks the octree/BVH with 4× fewer plane evaluations, and the picking ray is allocation-free — every technique benched against its legacy twin (`packages/core/bench/research205.bench.ts`), every parity gate held (`docs/graphics-research-205.md`). **Task 206 — the close-camera round**: the field report (near boxes covering the screen, thousands still drawn) reproduced headless (`scripts/task206-closecam.mjs`, the `?bare=1` direct-drive boot) and fixed twice — the frustum plane counts moved to CLIP SPACE (a box fully behind the camera landed in the straddle bucket, DRAWN: 6802 of 16407 at dist 12; now frustum-culled, the honest straddle ring is 1–3), and the cull kernel gained the budgeted Greene descent (the coarse tap's grid-rounding slop poisoned the region max on gappy small-box screens; the fine pass scans only the box's own texels within a 64-read budget — drawn 8134 → 428 at the guilty camera, 4388 → 2391 on the default view, the close-camera ON/OFF pixel hash 7/7 identical on BOTH backends; `docs/graphics-research-206.md`) **Task 207 — the same-frame feedback**: the second field report («the colored boxes still don't occlude the rear colored boxes») answered with the CURRENT-FRAME two-pass HZB — after the first cull's raw verdicts, the fresh visible set V1 re-renders depth-only into the pyramid tile, the pyramid rebuilds, and a SECOND cull lands: the colored city occludes ITSELF within the frame, for the survivors' depth (V1 ⊆ N — never the brute fill's 16407 instances). Declared as three new graph passes (`feedback-fill` / `pyramid-reduce-2` / `cull-verdicts-2`) that die with the culling gate like the shadows-off law; the version law's first SAME-FRAME consumer (`cull-verdicts→feedback-fill scene@v1` — the DAG's own two-phase chain, gated by the frame-graph leg). The report's cameras: drawn 2767 → 428 / 2804 → 155 / 3004 → 232 — exactly the brute all-N fill's numbers on BOTH backends (the cover-transfer law), pixel parity 6/6 identical; the default view 2402 → 1697. The citation audit killed two phantoms (the «Greedy Visibility» paper and Pettineo's «Incremental Hi-Z» series — neither exists) and replaced them with the real anchors (bevy's two-phase culling, VTK's WebGPU culler, devsh's no-reprojection polemic; `docs/graphics-research-207.md`) **Task 208 — the cross-frame seed** (the bevy two-phase delta, research round 207’s ranked candidate #1, `scripts/task208-closecam.mjs`): the pyramid CARRIES across the frame boundary as a persistent frame-graph resource — `pyramid-reduce-2` (the late downsample, after the phase-1 depth writers, bevy PR #18711’s own position) doubles as the writer of `hiz-seed`, and the next frame’s FIRST cull reads the imported version (the staleness channel counts the lag) — so the K-wall z-fill + the first reduce chain LEAVE the seeded frame (two fewer passes, gated like the shadows-off law) and the feedback fill’s pass set collapses from the whole K-wall-visible crowd to exactly the final set (2767 → 428 at the report’s camera, ×36.3 at yaw π — the tile only depends on its front layer, the fixed-point law tile(P(X)) ≡ tile(X)), while the final buckets land EXACTLY on the fresh warm-up’s on every camera on BOTH backends (drawn AND occluded, to the record). Sound under staleness by cull#2’s own law: the same-frame re-cull never wrongly culls a visible box, so the harshest test — a +0.30 rad cross-camera jump with the carry sampled along the new rays — still renders pixel-IDENTICAL (the promotion bill Δ+1352 measured, healed the next frame; the lag costs fill, never a pixel) **Task 209 — the parallel compact + the near-first order** (the research-208 A1+A2 pair, `scripts/task209-order.mjs`): the last serial N-loop in the frame is GONE — the flags-to-list compact now runs as ONE workgroup of 64 lanes walking 64-wide tiles (a Hillis-Steele inclusive scan per tile + a running base = the byte-identical ascending list, by construction; the JS-oracle gate proves it element-for-element on every camera), and the visible list sorts NEAR-FIRST for the early-Z harvest — the cull packs a byte-quantized NDC-z bucket into the verdict word's bits 16..23 (a near-straddling box rides bucket 0 — a straddling box IS the near field), the compact family's `order` entry bitonic-sorts the list by (bucket, record index) in workgroup shared memory (unique keys ⇒ a strict total order ⇒ no stability argument; ≤ 2048 records — HALF the default 16 KB workgroup-storage budget; above the cap the honest index order stays), the hysteresis fold CARRIES the bucket through the temporal policy, and every verdict decode masks with `& 0xFF` so the vocabulary is untouched — the drawn count and the pixels are order-invariant (the gate's parity law, IDENTICAL on both backends), the GL leg's collapse draw keeps its index order (the order is a WG-leg harvest, a documented no-op) **Task 211 — the unified data surface** (`scripts/task211-local.mjs` / `task211-live.mjs`): the scene's records region is an ADOPTED SoA store — @rune/core's `store.ts`, the Task-210 array laws applied as a system (schema-driven columns over ONE backing buffer, the measured growth ladder — RAB's in-place remap where the runtime wins, decided by a once-per-process probe; the MarkSet bitset with both iteration lanes and the documented crossover; packed u32 keys for the comparator-free order; the dirty-range surface) — and the Scene edit mode flies 48 drones through it every frame: CPU writes via the column view, coalesced 4-aligned dirty ranges, and the device's `updateRecords` brick pushes ONLY those bytes into the GPU mirror on BOTH backends (2304 B over 48 ranges vs the 961 KB whole-buffer write — a 427× cut, the HUD's upload line); the octree/BVH update on the same ids (the pick ray hits a MOVED box), the parity legs freeze the drones, and the gates prove the loop end to end — the record-mirror compare (the GPU's own copy ≡ the store's bytes, via the new `readRecords` readback) and the teleport probe (a visible record moved through the store flips its cull verdict 1→2) |

Overview of all demos: **https://atolbat.github.io/rune/demo/**

Deployment is automatic: Pages is configured to **deploy from the `dev`
branch** (repository root), so the demos work right after a push — the built
`dist/` bundle is committed together with the demos (`.nojekyll` disables
Jekyll processing). After changing `packages/*/src` do not forget to run
`bun run build` and commit the updated `dist/` — CI warns when the bundle in
the branch is stale.

## Running locally

```sh
bun install
bun run demo        # = build + a static server on :8080
```

Open: http://localhost:8080/demo/hello-cube/ (the overview lives at `/demo/`).

Any static server from the repository root works too, after `bun run build`
(the demos reference `dist/rune.esm.js` via a relative path).

## The demo standard (required for every new demo)

1. **Own folder**: `demo/<demo-name>/` with `index.html` + `main.js`.
2. **Shell**: include `../shared/demo-shell.css` and
   `../shared/demo-shell.js`, mark up only `<div id="app"></div>` — the
   header, stage, toggle and log are drawn by the shell
   (see `demo/hello-cube/main.js`).
3. **Mobile-first layout**: the canvas spans the full width, touch targets
   >= 44 px — the shell provides this, do not duplicate it.
4. **Backend toggle** Auto / WebGL2 / WebGPU (`onMode` → restart the scene
   via `showAny`/`showOn`; a forced backend refusal is a message in the log,
   not silence).
5. **Log panel with a Copy button**: intercepts `console.error/warn`,
   `window.onerror`, `unhandledrejection`, the WebGPU refusal and the
   "module did not load within 6 s" watchdog — all of it is already inside
   the shell. Log the key events (`shell.log.event/info/error`) so that the
   copied text explains what was happening.
6. **Bundle path**: from the demo folder — `../../dist/rune.esm.js`.
7. **Registration**: add a card to `demo/index.html` (the gallery) and a row
   to the table above (a link in the
   `https://atolbat.github.io/rune/demo/<name>/` format).
8. **Smoke test**: if the demo is graphical — add checks to
   `scripts/demo-smoke.mjs` (badge, live animation, toggle, log).

For an immersive fullscreen demo pass `layout: 'fullscreen'` to the shell —
the stage fills the whole viewport and the controls hide behind a compact
menu button (see `demo/model-viewer`).

**Long descriptions collapse** (Task 210): when `desc` exceeds ~240 chars or
`hint` exceeds ~320, the shell clamps the header to a two-line teaser and
puts the full description + the hint behind one "Read more" toggle — write
the complete research history into `desc`, the page stays compact. The
gallery cards follow the same law: a one-line summary + a `<details>` block
for the long notes (the click guard keeps the card link quiet).

## Files

```
demo/
├── index.html          — the gallery (the Pages landing: /rune/demo/)
├── README.md           — this file: links + the demo standard
├── shared/
│   ├── demo-shell.css  — shared styling (mobile-first, dark theme, fullscreen)
│   └── demo-shell.js   — the shell: backend toggle, log with copy, watchdog
├── hello-cube/         — the "cube in one line" demo
│   ├── index.html
│   └── main.js
├── model-viewer/       — the "scene with a loader" demo (three three.js models + the matcap cube)
│   ├── index.html
│   ├── main.js
│   └── assets/         — forest_house.glb, Nefertiti.glb, samba.fbx
│                         + draco_wasm_wrapper.js / draco_decoder.wasm
```
