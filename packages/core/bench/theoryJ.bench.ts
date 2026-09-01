import { createUploadQueue } from '../src/index.ts'
import type { UploadJob } from '../src/index.ts'

/**
 * Теория J: структура данных очереди стриминга.
 * Вариант 1: двоичная куча (push O(log n), pop O(log n)).
 * Вариант 2: сортировка-вставкой в массив (push O(n) memcpy, pop O(1)).
 * Вариант 3: FIFO без приоритетов (push O(1), pop O(1)) — базовая линия.
 * Гипотеза: куча выигрывает на перемешанных приоритетах при больших N;
 * при малых N (<64) различия в шуме.
 */

const N = 2000
const FRAMES = 50

function makeJobs(seed: number): { bytes: number; priority: number }[] {
  const jobs: { bytes: number; priority: number }[] = []
  let state = seed
  for (let i = 0; i < N; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    jobs.push({ bytes: 1024 + (state % 4096), priority: state % 997 })
  }
  return jobs
}

const noop = (): void => {}

function benchHeap(jobs: readonly { bytes: number; priority: number }[], frames: number): number {
  const queue = createUploadQueue()
  const startedAt = performance.now()
  for (const job of jobs) queue.push({ bytes: job.bytes, priority: job.priority, run: noop })
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N / frames; i++) queue.pop()
  }
  return performance.now() - startedAt
}

function benchSortedInsert(jobs: readonly { bytes: number; priority: number }[], frames: number): number {
  const sorted: UploadJob[] = []
  const startedAt = performance.now()
  for (const job of jobs) {
    const entry: UploadJob = { bytes: job.bytes, priority: job.priority, run: noop }
    let at = sorted.length
    while (at > 0 && sorted[at - 1].priority > entry.priority) at--
    sorted.splice(at, 0, entry)
  }
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N / frames; i++) sorted.shift()
  }
  return performance.now() - startedAt
}

function benchFifo(jobs: readonly { bytes: number; priority: number }[], frames: number): number {
  const fifo: UploadJob[] = []
  const startedAt = performance.now()
  for (const job of jobs) fifo.push({ bytes: job.bytes, priority: job.priority, run: noop })
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N / frames; i++) fifo.shift()
  }
  return performance.now() - startedAt
}

function bestOf(repeats: number, run: () => number): number {
  let best = Infinity
  for (let i = 0; i < repeats; i++) {
    const elapsed = run()
    if (elapsed < best) best = elapsed
  }
  return best
}

const jobs = makeJobs(42)
benchHeap(jobs, FRAMES); benchSortedInsert(jobs, FRAMES); benchFifo(jobs, FRAMES) // прогрев

const heapMs = bestOf(9, () => benchHeap(makeJobs(7), FRAMES))
const sortedMs = bestOf(9, () => benchSortedInsert(makeJobs(7), FRAMES))
const fifoMs = bestOf(9, () => benchFifo(makeJobs(7), FRAMES))

console.log('── Теория J: очередь стриминга, 2000 задач × 50 кадров ──')
console.log(`двоичная куча     : ${heapMs.toFixed(2)} мс`)
console.log(`сортировка-вставка: ${sortedMs.toFixed(2)} мс`)
console.log(`FIFO (без приоритетов): ${fifoMs.toFixed(2)} мс`)
console.log(`куча быстрее сортировки в ${(sortedMs / heapMs).toFixed(1)} раза; надбавка за приоритеты против FIFO — ×${(heapMs / fifoMs).toFixed(2)}`)
