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

| vfx | https://atolbat.github.io/rune/demo/vfx/ | The game-VFX study on `@rune/particles`: **23 demos in one carousel page** — every emitter shape, trails with floor collision, the texture sequencer (1500 particles seeking a text mask), PBR mesh particles, sub-emitters, the simplex noise field, alpha-tested falling petals, a custom SinWave behavior on the composable core, the billboard modes, soft particles with a color-encoded depth prepass, the blend equations, a follow-object emitter, a composed explosion, the sentry turret (tracers + beam volleys + reflection sparks), plus the rune originals (rocket, rainstorm, sword slash, vortex, fireflies, dust & haze, grass field, lightning storm, and a cutting laser — a continuous lattice beam biting a visible sphere target, reflection sparks off the curvature). Every sprite procedural (no image assets); exercises the whole library surface: the shape family, image seek targets, the burst schedule, prewarm, the live emitter origin `at()`/`orient()`, the atlas + FrameOverLife, trails, mesh particles with normals, collision planes, noise, the seek spring, SpeedOverLife, `onRetire` sub-emitters, custom blend equations, the `SOFT_PARTICLES` and `OUTPUT_DITHER` material features, and the GPU-static grass field |

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
└── model-viewer/       — the "scene with a loader" demo (three three.js models + the matcap cube)
    ├── index.html
    ├── main.js
    └── assets/         — forest_house.glb, Nefertiti.glb, samba.fbx
                          + draco_wasm_wrapper.js / draco_decoder.wasm
```
