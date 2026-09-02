# rune demos

Live examples of the renderer. Every demo lives **in its own folder** inside
`demo/`, references the **built bundle** of the library (`dist/rune.esm.js`)
and follows the shared shell standard: a mobile-first layout, a backend
toggle, a log panel.

## Demos online (GitHub Pages)

| Demo | Link | What it shows |
|------|------|---------------|
| hello-cube | https://atolbat.github.io/rune/demo/hello-cube/ | A cube in one line: `showAny()` / `showOn()`, an Auto/WebGL2/WebGPU toggle, a log with copy |
| model-viewer | https://atolbat.github.io/rune/demo/model-viewer/ | Three three.js example models: Forest House (glTF · AVIF · Draco), Samba Dancing (FBX), Nefertiti (glTF · object-space normal map). A fullscreen mobile-first viewer: a Load button with a progress bar (`AssetLoader`), model switching, drag rotation, dual-source GLSL+WGSL shaders |

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
└── model-viewer/       — the "scene with a loader" demo (three three.js models)
    ├── index.html
    ├── main.js
    └── assets/         — forest_house.glb, Nefertiti.glb, samba.fbx
                          + draco_wasm_wrapper.js / draco_decoder.wasm
```
