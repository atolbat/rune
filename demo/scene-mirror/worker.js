// scene-mirror/worker.js — Task 215: the scene pipeline's OWN THREAD.
// The protocol is @rune/scene's own (mirror.ts): the main thread posts
// {type:'scene-init', sab} — the worker answers 'scene-ready' BEFORE the
// blocking loop (Atomics.wait holds the thread between publishes), then
// runSceneWorker drives the hot passes (updateWorld → refit → cull →
// collect) whenever H_INPUT_EPOCH advances, bumping H_OUTPUT_EPOCH and the
// H_CLOCK stamps the store mirror's dirty ranges read.
//
// The import is the dist bundle (the same bytes the main thread loads) —
// one library, two threads, zero copies: the SAB regions ARE the store.
import { runSceneWorker } from '../../dist/rune-scene.esm.js?v=222'

self.onmessage = (e) => {
  const m = e.data
  if (m?.type === 'scene-init' && m.sab !== undefined) {
    self.postMessage({ type: 'scene-ready' })
    // the frame hook rides the worker's own protocol (the demo's honest ms)
    runSceneWorker(m.sab, {
      onFrame(epoch, frameMs) {
        self.postMessage({ type: 'frame', epoch, ms: frameMs })
      },
    })
  }
}
