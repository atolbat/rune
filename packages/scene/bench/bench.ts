/**
 * bench.ts — бенчмарки @rune/scene (Task 81).
 *
 * Отвечает на вопросы проекта (юзер: «нужны бенчмарки, сам проверяй,
 * что имеет смысл»):
 *   1. Грязевые штампы против полного пересчёта — при какой доле анимации
 *      выигрыш исчезает?
 *   2. Иерархический culling против brute — при каком «проценте видимости»
 *      иерархия окупается (и когда вредна)?
 *   3. Сколько стоит компакция инстансов на кадр?
 *   4. Воркер: при каком размере сцены вынос конвейера в поток окупает
 *      синхронизацию (break-even)?
 *   5. Цена pack() после структурных правок.
 *
 * Запуск: cd rune && bun packages/scene/bench/bench.ts [section…]
 * Секции: transforms, cull, instances, pack, worker, all (default).
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

// ─── Хвост измерений ────────────────────────────────────────────────────────

interface Sample {
  readonly name: string
  readonly medianMs: number
  readonly p95Ms: number
  readonly runs: number
}

function bench(name: string, runs: number, fn: () => void): Sample {
  // Прогрев JIT.
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
  console.log(`  ${'бенчмарк'.padEnd(nameW)}  ${'медиана'.padStart(10)}  ${'p95'.padStart(10)}  ${'прогонов'.padStart(8)}`)
  for (const s of samples) {
    console.log(`  ${s.name.padEnd(nameW)}  ${s.medianMs.toFixed(4).padStart(10)}  ${s.p95Ms.toFixed(4).padStart(10)}  ${String(s.runs).padStart(8)}`)
  }
}

// ─── Генераторы сцен ────────────────────────────────────────────────────────

/** Кластерное поле: clusters корней, в каждом — subtreeSize листьев
 *  (глубина 2: корень → дети-листья). Пространственная когерентность —
 *  кластеры сеткой, листья внутри радиуса кластера. */
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
      sphere: [0, 0, 0, 26], // охват кластера
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

/** Камера с целевым «процентом видимости» (подбором дистанции). */
function cameraFor(scene: Scene, targetVisible: number, clusterCount: number, side: number): { cam: ReturnType<typeof createCamera>; actual: number } {
  const cam = createCamera()
  const centerX = (side - 1) * 30
  const centerZ = centerX
  // Подбираем дистанцию бинарным поиском по фактической видимости brute.
  let lo = 50
  let hi = 4000
  let best = cam
  let bestActual = 0
  for (let iter = 0; iter < 14; iter++) {
    const dist = (lo + hi) / 2
    cam.setPerspective(Math.PI / 3, 1, 1, 8000)
    cam.setViewLookAt(centerX, 400, dist, centerX, 0, centerZ, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    // Быстрый подсчёт по факту (brute — эталон видимости).
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

// ─── Секция 1: трансформы ───────────────────────────────────────────────────

function sectionTransforms(): void {
  console.log('\n━━━ Трансформы: грязь против полного пересчёта ━━━')
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
        `dirty  ${String(total).padStart(7)} узлов, аним ${String(Math.round(animFrac * 100)).padStart(3)}%`,
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
    samples.push(bench(`forced ${String(total).padStart(7)} узлов (100%)`, 20, () => {
      updateWorldForcedViews(scene.views)
    }))
  }
  print(samples)
}

// ─── Секция 2: отсечение ────────────────────────────────────────────────────

function sectionCull(): void {
  console.log('\n━━━ Отсечение: иерархия против brute ━━━')
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
      const brute = bench(`brute  ${String(total).padStart(7)} вид ${String(Math.round(actual * 100)).padStart(3)}%`, 30, () => {
        cullViewsBrute(scene.views, 0, 0)
      })
      const hier = bench(`иерарх ${String(total).padStart(7)} вид ${String(Math.round(actual * 100)).padStart(3)}%`, 30, () => {
        cullViewsHierarchical(scene.views, 0, 0)
      })
      samples.push(brute, hier)
    }
  }
  print(samples)
}

// ─── Секция 3: инстансы ─────────────────────────────────────────────────────

function sectionInstances(): void {
  console.log('\n━━━ Компакция инстансов (группа 0) ━━━')
  const samples: Sample[] = []
  for (const total of [10_000, 100_000]) {
    const { scene, clusterCount } = buildClusterField(total, 9)
    scene.updateWorld()
    scene.refitGroupBounds()
    const side = Math.ceil(Math.sqrt(clusterCount))
    const { cam } = cameraFor(scene, 0.5, clusterCount, side)
    scene.cull([cam])
    samples.push(bench(`collect ${String(total).padStart(7)} узлов (~50% вид)`, 30, () => {
      scene.collectInstances(0)
    }))
  }
  print(samples)
}

// ─── Секция 4: pack ─────────────────────────────────────────────────────────

function sectionPack(): void {
  console.log('\n━━━ Перестройка порядка (pack) после структурных правок ━━━')
  const samples: Sample[] = []
  for (const total of [10_000, 100_000]) {
    const { scene } = buildClusterField(total, 9)
    scene.pack()
    // Имитация структурной правки: отсоединить/присоединить один узел.
    const someNode = scene.views.order[5]
    const parent = scene.parentOf(someNode)
    samples.push(bench(`pack   ${String(total).padStart(7)} узлов`, 30, () => {
      scene.setParent(someNode, parent)
      scene.pack()
    }))
  }
  print(samples)
}

// ─── Секция 5: воркер ───────────────────────────────────────────────────────

async function sectionWorker(): Promise<void> {
  console.log('\n━━━ Воркер: локальный конвейер против выноса в поток ━━━')
  const worker = new Worker(new URL('../tests/sceneWorkerEntry.ts', import.meta.url))
  const samples: Sample[] = []
  try {
    for (const total of [10_000, 100_000, 1_000_000]) {
      const clusterSize = total >= 1_000_000 ? 99 : 9
      const clusterCount = Math.floor(total / (clusterSize + 1))
      const side = Math.ceil(Math.sqrt(clusterCount))
      // SAB-сцена той же генерацией, что и локальная.
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

      // Локальный конвейер (T0).
      const local = bench(`local  ${String(total).padStart(7)} (main-время)`, 15, () => {
        runScenePipeline(sabScene.views, 0)
      })

      // Воркер: главный поток платит только publish + take.
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
      // 1) Чистая цена publish+take для main (микросекунды, без ожидания).
      const mainCost = await benchAsync(`worker ${String(total).padStart(7)} (main-цена p+t)`, 30, async () => {
        bridge.publish([cam])
        bridge.take()
      })
      // 2) Полная латентность publish→fresh (пробуждение+конвейер+опрос).
      const latency = await benchAsync(`worker ${String(total).padStart(7)} (publish→fresh)`, 15, async () => {
        bridge.publish([cam])
        await bridge.waitFresh(10_000)
      })
      // 3) Оверлап: main параллельно работает 3 мс — успел ли воркер.
      let freshHits = 0
      const overlapRuns = 20
      for (let i = 0; i < overlapRuns; i++) {
        bridge.publish([cam])
        const t0 = performance.now()
        // Синтетическая main-работа ~3 мс (компиляция занятого цикла).
        let acc = 0
        while (performance.now() - t0 < 3) acc += Math.sqrt(i + 1)
        const snap = bridge.take()
        if (snap !== null && snap.epoch === bridge.stats().published) freshHits++
        void acc
      }
      samples.push(local, mainCost, latency)
      console.log(`  overlap ${String(total).padStart(7)}: свежий снимок за 3 мс main-работы — ${freshHits}/${overlapRuns} (${Math.round(100 * freshHits / overlapRuns)}%)`)
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
console.log('\n(медиана/p95 в мс; bun ' + Bun.version + ')')
