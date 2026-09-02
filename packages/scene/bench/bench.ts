/**
 * bench.ts — @rune/scene benchmarks (Task 81).
 *
 * Answers the project's questions (the user: "we need benchmarks,
 * check yourself what makes sense"):
 *   1. Dirt stamps vs a full recompute — at what share of animation
 *      does the gain disappear?
 *   2. Hierarchical culling vs brute — at what "visibility percentage"
 *      does the hierarchy pay off (and when is it harmful)?
 *   3. What does instance compaction cost per frame?
 *   4. The worker: at what scene size does moving the pipeline into a
 *      thread pay for the synchronization (break-even)?
 *   5. The price of pack() after structural edits.
 *
 * Run: cd rune && bun packages/scene/bench/bench.ts [section…]
 * Sections: transforms, cull, instances, pack, worker, all (default).
 */
import { Worker } from 'node:worker_threads'
import {
  createCamera,
  createScene,
  createSceneWorkerBridge,
  cullViewsBrute,
  cullViewsHierarchical,
  runScenePipeline,
  updateWorldForcedViews,
  writeCameraPlanes,
} from '../src/index.ts'
import type { Scene } from '../src/index.ts'

// ─── Measurement plumbing ────────────────────────────────────────────────────────

interface Sample {
  readonly name: string
  readonly medianMs: number
  readonly p95Ms: number
  readonly runs: number
}

function bench(name: string, runs: number, fn: () => void): Sample {
  // JIT warmup.
  for (let i = 0; i < Math.max(3, Math.floor(runs / 10)); i++) fn()
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return {
    name,
    medianMs: times[Math.floor(times.length / 2)],
    p95Ms: times[Math.min(times.length - 1, Math.ceil(times.length * 0.95))],
    runs,
  }
}

async function benchAsync(name: string, runs: number, fn: () => Promise<void>): Promise<Sample> {
  for (let i = 0; i < Math.max(3, Math.floor(runs / 10)); i++) await fn()
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return { name, medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.min(times.length - 1, Math.ceil(times.length * 0.95))], runs }
}

function print(samples: readonly Sample[]): void {
  const nameW = Math.max(...samples.map((s) => s.name.length), 20)
  console.log(`  ${'benchmark'.padEnd(nameW)}  ${'median'.padStart(10)}  ${'p95'.padStart(10)}  ${'runs'.padStart(8)}`)
  for (const s of samples) {
    console.log(`  ${s.name.padEnd(nameW)}  ${s.medianMs.toFixed(4).padStart(10)}  ${s.p95Ms.toFixed(4).padStart(10)}  ${String(s.runs).padStart(8)}`)
  }
}

// ─── Scene generators ────────────────────────────────────────────────────────

/** A clustered field: clusterCount roots, each with subtreeSize leaves
 *  (depth 2: root → leaf children). Spatial coherence —
 *  clusters on a grid, leaves within the cluster's radius. */
function buildClusterField(
  totalNodes: number,
  clusterSize: number,
  seed = 7,
): { scene: Scene; clusterCount: number } {
  const clusterCount = Math.floor(totalNodes / (clusterSize + 1))
  const scene = createScene({
    capacity: clusterCount * (clusterSize + 1) + 16,
    cameraMax: 1,
    groupMax: 4,
    maxInstances: totalNodes,
  })
  let rng = seed
  const rand = () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff
    return rng / 0x7fffffff
  }
  const side = Math.ceil(Math.sqrt(clusterCount))
  for (let c = 0; c < clusterCount; c++) {
    const cx = (c % side) * 60
    const cz = Math.floor(c / side) * 60
    const root = scene.create({
      position: [cx, 0, cz],
      sphere: [0, 0, 0, 26], // the cluster's extent
    })
    for (let k = 0; k < clusterSize; k++) {
      const a = rand() * Math.PI * 2
      const d = rand() * 22
      scene.create({
        parent: root,
        position: [Math.cos(a) * d, (rand() - 0.5) * 6, Math.sin(a) * d],
        sphere: [0, 0, 0, 0.8],
        group: 0,
      })
    }
  }
  return { scene, clusterCount }
}

/** A camera with a target "visibility percentage" (by distance fitting). */
function cameraFor(scene: Scene, targetVisible: number, clusterCount: number, side: number): { cam: ReturnType<typeof createCamera>; actual: number } {
  const cam = createCamera()
  const centerX = (side - 1) * 30
  const centerZ = centerX
  // We fit the distance with a binary search over the actual brute visibility.
  let lo = 50
  let hi = 4000
  let best = cam
  let bestActual = 0
  for (let iter = 0; iter < 14; iter++) {
    const dist = (lo + hi) / 2
    cam.setPerspective(Math.PI / 3, 1, 1, 8000)
    cam.setViewLookAt(centerX, 400, dist, centerX, 0, centerZ, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    // A quick on-the-spot count (brute — the visibility reference).
    const stats = cullViewsBrute(scene.views, 0, 0)
    const fraction = stats.visible / scene.count
    if (Math.abs(fraction - targetVisible) < 0.02) {
      return { cam, actual: fraction }
    }
    if (fraction > targetVisible) lo = dist
    else hi = dist
    best = cam
    bestActual = fraction
  }
  return { cam: best, actual: bestActual }
}

// ─── Section 1: transforms ───────────────────────────────────────────────────

function sectionTransforms(): void {
  console.log('\n━━━ Transforms: dirt vs a full recompute ━━━')
  const samples: Sample[] = []
  for (const total of [1_000, 10_000, 100_000]) {
    const { scene } = buildClusterField(total, 9)
    scene.updateWorld()
    scene.refitGroupBounds()
    const n = scene.count
    const slots: number[] = []
    for (let r = 0; r < n; r++) slots.push(scene.views.order[r])
    for (const animFrac of [0, 0.01, 0.1, 1]) {
      const animCount = Math.floor(n * animFrac)
      samples.push(bench(
        `dirty  ${String(total).padStart(7)} nodes, anim ${String(Math.round(animFrac * 100)).padStart(3)}%`,
        30,
        () => {
          for (let i = 0; i < animCount; i++) {
            const s = slots[(i * 7919) % n]
            scene.setLocalTR(s, i, 0, 0, 0, 0, 0, 1, 1, 1, 1)
          }
          scene.updateWorld()
          scene.refitGroupBounds()
        },
      ))
    }
    samples.push(bench(`forced ${String(total).padStart(7)} nodes (100%)`, 20, () => {
      updateWorldForcedViews(scene.views)
    }))
  }
  print(samples)
}

// ─── Section 2: culling ────────────────────────────────────────────────────

function sectionCull(): void {
  console.log('\n━━━ Culling: hierarchy vs brute ━━━')
  const samples: Sample[] = []
  for (const total of [10_000, 100_000, 1_000_000]) {
    const clusterSize = total >= 1_000_000 ? 99 : 9
    const { scene, clusterCount } = buildClusterField(total, clusterSize)
    scene.updateWorld()
    scene.refitGroupBounds()
    const side = Math.ceil(Math.sqrt(clusterCount))
    for (const target of [0.1, 0.5, 0.9]) {
      const { cam, actual } = cameraFor(scene, target, clusterCount, side)
      writeCameraPlanes(scene.views, 0, cam.planes)
      const brute = bench(`brute  ${String(total).padStart(7)} vis ${String(Math.round(actual * 100)).padStart(3)}%`, 30, () => {
        cullViewsBrute(scene.views, 0, 0)
      })
      const hier = bench(`hier   ${String(total).padStart(7)} vis ${String(Math.round(actual * 100)).padStart(3)}%`, 30, () => {
        cullViewsHierarchical(scene.views, 0, 0)
      })
      samples.push(brute, hier)
    }
  }
  print(samples)
}

// ─── Section 3: instances ─────────────────────────────────────────────────────

function sectionInstances(): void {
  console.log('\n━━━ Instance compaction (group 0) ━━━')
  const samples: Sample[] = []
  for (const total of [10_000, 100_000]) {
    const { scene, clusterCount } = buildClusterField(total, 9)
    scene.updateWorld()
    scene.refitGroupBounds()
    const side = Math.ceil(Math.sqrt(clusterCount))
    const { cam } = cameraFor(scene, 0.5, clusterCount, side)
    scene.cull([cam])
    samples.push(bench(`collect ${String(total).padStart(7)} nodes (~50% vis)`, 30, () => {
      scene.collectInstances(0)
    }))
  }
  print(samples)
}

// ─── Section 4: pack ─────────────────────────────────────────────────────────

function sectionPack(): void {
  console.log('\n━━━ Order rebuild (pack) after structural edits ━━━')
  const samples: Sample[] = []
  for (const total of [10_000, 100_000]) {
    const { scene } = buildClusterField(total, 9)
    scene.pack()
    // Simulating a structural edit: detach/attach one node.
    const someNode = scene.views.order[5]
    const parent = scene.parentOf(someNode)
    samples.push(bench(`pack   ${String(total).padStart(7)} nodes`, 30, () => {
      scene.setParent(someNode, parent)
      scene.pack()
    }))
  }
  print(samples)
}

// ─── Section 5: worker ───────────────────────────────────────────────────────

async function sectionWorker(): Promise<void> {
  console.log('\n━━━ Worker: the local pipeline vs moving it into a thread ━━━')
  const worker = new Worker(new URL('../tests/sceneWorkerEntry.ts', import.meta.url))
  const samples: Sample[] = []
  try {
    for (const total of [10_000, 100_000, 1_000_000]) {
      const clusterSize = total >= 1_000_000 ? 99 : 9
      const clusterCount = Math.floor(total / (clusterSize + 1))
      const side = Math.ceil(Math.sqrt(clusterCount))
      // A SAB scene with the same generation as the local one.
      const sabScene = createScene({
        capacity: clusterCount * (clusterSize + 1) + 16,
        cameraMax: 1,
        groupMax: 4,
        maxInstances: total,
        shared: true,
      })
      {
        let rng = 7
        const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff }
        for (let c = 0; c < clusterCount; c++) {
          const cx = (c % side) * 60
          const cz = Math.floor(c / side) * 60
          const root = sabScene.create({ position: [cx, 0, cz], sphere: [0, 0, 0, 26] })
          for (let k = 0; k < clusterSize; k++) {
            const a = rand() * Math.PI * 2
            const d = rand() * 22
            sabScene.create({
              parent: root,
              position: [Math.cos(a) * d, (rand() - 0.5) * 6, Math.sin(a) * d],
              sphere: [0, 0, 0, 0.8],
              group: 0,
            })
          }
        }
      }
      const cam = createCamera()
      cam.setPerspective(Math.PI / 3, 1, 1, 8000)
      const centerX = (side - 1) * 30
      cam.setViewLookAt(centerX, 400, 3000, centerX, 0, centerX, 0, 1, 0)

      // The local pipeline (T0).
      const local = bench(`local  ${String(total).padStart(7)} (main time)`, 15, () => {
        runScenePipeline(sabScene.views, 0)
      })

      // The worker: the main thread pays only publish + take.
      const bridge = createSceneWorkerBridge({
        scene: sabScene,
        worker: {
          postMessage: (m) => worker.postMessage(m),
          onMessage: (h) => { worker.on('message', h) },
        },
      })
      await bridge.ready
      bridge.publish([cam])
      await bridge.waitFresh(10_000)
      // 1) The pure price of publish+take for main (microseconds, no waiting).
      const mainCost = await benchAsync(`worker ${String(total).padStart(7)} (main cost p+t)`, 30, async () => {
        bridge.publish([cam])
        bridge.take()
      })
      // 2) The full publish→fresh latency (wakeup+pipeline+polling).
      const latency = await benchAsync(`worker ${String(total).padStart(7)} (publish→fresh)`, 15, async () => {
        bridge.publish([cam])
        await bridge.waitFresh(10_000)
      })
      // 3) Overlap: main works for 3 ms in parallel — did the worker make it.
      let freshHits = 0
      const overlapRuns = 20
      for (let i = 0; i < overlapRuns; i++) {
        bridge.publish([cam])
        const t0 = performance.now()
        // Synthetic main work of ~3 ms (compiling a busy loop).
        let acc = 0
        while (performance.now() - t0 < 3) acc += Math.sqrt(i + 1)
        const snap = bridge.take()
        if (snap !== null && snap.epoch === bridge.stats().published) freshHits++
        void acc
      }
      samples.push(local, mainCost, latency)
      console.log(`  overlap ${String(total).padStart(7)}: a fresh snapshot within 3 ms of main work — ${freshHits}/${overlapRuns} (${Math.round(100 * freshHits / overlapRuns)}%)`)
      await bridge.dispose()
    }
  } finally {
    await Promise.race([worker.terminate(), new Promise((r) => setTimeout(r, 200))])
  }
  print(samples)
}

// ─── main ───────────────────────────────────────────────────────────────────

const sections = process.argv.slice(2)
const want = (name: string): boolean => sections.length === 0 || sections.includes(name) || sections.includes('all')

if (want('transforms')) sectionTransforms()
if (want('cull')) sectionCull()
if (want('instances')) sectionInstances()
if (want('pack')) sectionPack()
if (want('worker')) await sectionWorker()
console.log('\n(median/p95 in ms; bun ' + Bun.version + ')')
