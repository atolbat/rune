/**
 * Priority task queue on a binary heap.
 * Extraction is O(log n); changing priority is not supported (MVP).
 */

/** Streaming task: bytes, priority (lower = earlier) and the work. */
export interface UploadJob {
  readonly bytes: number
  readonly priority: number
  run(): void
}

/** Priority task queue. */
export interface UploadQueue {
  readonly size: number
  push(job: UploadJob): void
  /** Takes the task with the minimal priority. */
  pop(): UploadJob | null
  clear(): void
}

/** Creates a priority queue on a binary heap. */
export function createUploadQueue(): UploadQueue {
  const heap: UploadJob[] = []
  return {
    get size() { return heap.length },
    push: job => {
      heap.push(job)
      siftUp(heap, heap.length - 1)
    },
    pop: () => {
      if (heap.length === 0) return null
      swap(heap, 0, heap.length - 1)
      const top = heap.pop() as UploadJob
      if (heap.length > 0) siftDown(heap, 0)
      return top
    },
    clear: () => { heap.length = 0 },
  }
}

function less(a: UploadJob, b: UploadJob): boolean {
  return a.priority < b.priority
}

function swap(heap: UploadJob[], i: number, j: number): void {
  const tmp = heap[i]
  heap[i] = heap[j]
  heap[j] = tmp
}

function siftUp(heap: UploadJob[], at: number): void {
  while (at > 0) {
    const parent = (at - 1) >> 1
    if (!less(heap[at], heap[parent])) return
    swap(heap, at, parent)
    at = parent
  }
}

function siftDown(heap: UploadJob[], at: number): void {
  for (;;) {
    const left = at * 2 + 1
    const right = left + 1
    let smallest = at
    if (left < heap.length && less(heap[left], heap[smallest])) smallest = left
    if (right < heap.length && less(heap[right], heap[smallest])) smallest = right
    if (smallest === at) return
    swap(heap, at, smallest)
    at = smallest
  }
}
