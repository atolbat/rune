# rune demos

Live examples of the renderer. Every demo lives **in its own folder** inside
`demo/`, references the **built bundle** of the library (`dist/rune.esm.js`)
and follows the shared shell standard: a mobile-first layout, a backend
toggle, a log panel.

## Demos online (GitHub Pages)

| Demo | Link | What it shows |
|------|------|---------------|
| hello-cube | https://atolbat.github.io/rune/demo/hello-cube/ | A cube in one line: `showAny()` / `showOn()`, an Auto/WebGL2/WebGPU toggle, a log with copy |
| model-viewer | https://atolbat.github.io/rune/demo/model-viewer/ | Three three.js example models: Forest House (glTF · AVIF · Draco — Cook-Torrance PBR from its glTF factors), Samba Dancing (FBX — skeleton, skinning, a looping clip), Nefertiti (glTF · object-space normal map), plus a procedural Matcap Cube. A fullscreen mobile-first viewer: a Load button with a progress bar (`AssetLoader`), model switching, drag rotation + pinch zoom; every shader is assembled by `@rune/materials` (a feature mask per mesh — no hand-written GLSL/WGSL) |
| particles | https://atolbat.github.io/rune/demo/particles/ | `@rune/particles` live: eight presets (fountain, fireworks, galaxy, embers, drift, snow, orbit, meteor) built from the `createParticles` facade (the galaxy preset: 3 spiral arms, Keplerian shear, color-by-radius; orbit: a point attractor (the gravity behavior); drift: standing dust motes) — a CPU-simulated SoA store with deterministic hash spawning and over-life ramps, baked each frame into a camera-facing billboard soup (one interleaved buffer, one blended draw call, dynamic vertex count, zero allocations per frame); orbit + pinch zoom |

| vfx | https://atolbat.github.io/rune/demo/vfx/ | The game-VFX study on `@rune/particles`: **24 demos in one carousel page** — every emitter shape, trails with floor collision, the texture sequencer (1500 particles seeking a text mask), PBR mesh particles, sub-emitters, the simplex noise field, alpha-tested falling petals, a custom SinWave behavior on the composable core, the billboard modes, soft particles with a color-encoded depth prepass, the blend equations, a follow-object emitter, a composed explosion, the sentry turret (tracers + beam volleys + reflection sparks), plus the rune originals (rocket, rainstorm, sword slash, vortex, fireflies, dust & haze, grass field, lightning storm, a cutting laser — a continuous lattice beam biting a visible sphere target, reflection sparks off the curvature — and the GPU compute tier: 160k embers advanced by WebGPU compute shaders over a storage-buffer state, the instance records packed GPU-side (WebGL2 runs the same demo on the CPU tier). Every sprite procedural (no image assets); exercises the whole library surface: the shape family, image seek targets, the burst schedule, prewarm, the live emitter origin `at()`/`orient()`, the atlas + FrameOverLife, trails, mesh particles with normals, collision planes, noise, the seek spring, SpeedOverLife, `onRetire` sub-emitters, custom blend equations, the `SOFT_PARTICLES` and `OUTPUT_DITHER` material features, and the GPU-static grass field |

| astral | https://atolbat.github.io/rune/demo/astral/ | A mini 4X strategy sandbox built directly on the renderer (no particle library — plain dual-source commands), now a REAL 3D PERSPECTIVE SCENE: a tilted orbit camera over the galaxy plane (yaw via the two-finger twist, tilt easing between the galaxy overview and the system view), a seeded spiral galaxy of 72 star systems joined by a connected hyperlane graph, planets orbiting their stars (four types, per-type build slots), colony ships and corvettes that fly BFS routes over the lanes, an economy of Deep Mines / Solar Farms / Orbital Labs with a four-step tech tree, and a rival power (the Hegemony) expanding across the map — settle 60% of the colonizable systems before they do (a parked corvette denies their claims). THE STELLARIS LOOK: the ESO Milky Way panorama as the deep-space sky (via the three.js examples, swapped in async over a procedural starfield — now fixed on BOTH backends: the WebGPU texture wrapper gained uploadImage/uploadSubImage), EMPIRE TERRITORY BORDERS (a CPU-baked 256² metaball field — R = the player, G = the Hegemony — rebaked only when a claim flips an owner, shaded into a translucent fill, a soft contour sheen and a warm contested-frontier glow), thin teal hyperlanes, tight star points with diffraction streaks, EXOTIC SYSTEMS (black holes with an opaque occluding horizon + a tilted doppler-boosted accretion disc + photon ring in their own alpha-blend pass; neutron stars with rotating lighthouse beams), planets as SPHERE-SHADED equirect billboards (a planet ATLAS: procedural rock/gas/ice/lava tiles + the NASA moon and earth bitmaps swapped into their tiles, lava emissive fissures, atmosphere rim, orbit-tracking day/night terminator), ringed gas giants (in-plane annuli split near/far), 14 GLSL+WGSL twin commands, the feed-path dynamic vertex buffers on both backends, world-projected DOM labels with the Stellaris declutter, a mobile-first game UI (tap/pan/pinch/twist/wheel on a touch-action:none canvas; slate panels, gold trims, the self-hosted Oxanium variable font), and a `?seed=` URL for replayable galaxies. Texture credits: ESO/S. Brunier (Milky Way panorama, CC BY), NASA (moon, earth imagery) — both via the three.js examples; Oxanium by Severin Meyer (OFL, self-hosted woff2) |

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
   If the demo carries hand-written WGSL twins — its sources must pass
   `scripts/task169-wgsl-gate.mjs` (a real WebGPU device compiles every
   WGSL source; the gate caught the shipped `{ discard }` class that
   only surfaced on field hardware).

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
└── astral/             — the mini-4X demo (the Stellaris-look galaxy sandbox)
    ├── index.html      — the page + the game UI stylesheet (Oxanium font)
    ├── main.js         — the shell wiring, the camera, the input, the boot
    ├── galaxy.js       — the world: generation, economy, ships, the rival AI
    │                      + the exotic star classes (black hole, neutron)
    ├── render.js       — the commands: records, soups, the territory bake
    ├── shaders.js      — the GLSL + WGSL twin shaders (12 passes)
    ├── textures.js     — the procedural texture kitchen
    ├── ui.js           — the DOM UI: top bar, panel, labels, outcome
    └── assets/         — milkyway_1024.jpg, moon_512.jpg, earth_512.jpg
                           + fonts/oxanium-var.woff2
```
