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

| occlusion | https://atolbat.github.io/rune/demo/occlusion/ | **Hi-Z occlusion culling — the GPU-driven tier (Task 196)**: a z-prepass renders the occluder city into an r32float depth tile (a `createTarget` with a Task-196 pipeline **target-format variant**), a compute family builds the **max-reduced Hi-Z pyramid** (the `createCompute` **texture slots** — `textureLoad` on the tile through binding 6 — plus `reduceL1..L9` entry points with baked constants), the cull kernel projects every occludee AABB, picks the mip by the rect size and tests the box's NEAREST corner against the region's FARTHEST surface — the SOUND form of the test (the widely-copied min-reduce version is unsound; this demo's own pixel-parity gate caught it). The visible set compacts deterministically (no atomics) and the color pass draws it with **ONE `drawIndexedIndirect`** (the Task-196 facade contract, core WebGPU — no probe). The page's own gates: pixel parity ON vs OFF (sha256-identical over 3 cameras — culling occluded boxes cannot change a pixel), the accounting invariant (frustum + occluded + drawn = occludees), the live counters (51–71% culled at 16384 boxes). WebGPU only (compute); a software adapter (SwiftShader/llvmpipe) gets the honest **snapshot mode** — every frame renders into a surface and blits into a 2D canvas, zero canvas presents (the documented container present-death); the **WebGL2 tier (Task 197) is the same Hi-Z on the GL contracts**: an FBO pyramid over `r32f` data textures (the Task-197 GLTextureFormat growth), a transform-feedback cull pass (the library's GL compute substitute) writing per-instance verdict flags, and ONE instanced draw whose vertex shader collapses invisible instances — GPU-side visibility, zero CPU sync; the cross-tier gate proves both backends render the same scene (a bounded pixel compare: the measured cross-backend class is 0.001–0.65% of pixels off by 1–16 ULP of float rounding — structure-level equality, exact hash-exact only intra-tier) |

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
