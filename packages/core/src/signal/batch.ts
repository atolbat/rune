/** Отложенная работа: внутри batch копится, снаружи исполняется сразу. */
type Job = () => void

let depth = 0
let pending: Job[] = []

/** Группирует записи: подписчики уведомляются один раз, на выходе. */
export function batch<T>(run: () => T): T {
  enterBatch()
  try {
    return run()
  } finally {
    exitBatch()
  }
}

function enterBatch(): void {
  depth++
}

function exitBatch(): void {
  depth--
  if (depth === 0) {
    // Флэш держит batch-контекст (depth=1): работа, запланированная самими
    // уведомлениями (effect rerun, derive revalidate), копится в следующий
    // виток флэша, а не исполняется мгновенно. Иначе «один перевыпуск на
    // batch» ломается: первый rerun сбрасывает дедупликацию до того, как
    // дошла вторая запись (репорт effect.test: runs=3 вместо 2).
    depth++
    try {
      flushPending()
    } finally {
      depth--
    }
  }
}

function flushPending(): void {
  // Каскад: колбэк может планировать новую работу — крутим до опустошения.
  while (pending.length > 0) {
    const jobs = pending
    pending = []
    for (const job of jobs) job()
  }
}

/** Планирует работу: немедленно вне batch, в конец очереди внутри. */
export function schedule(job: Job): void {
  if (depth === 0) job()
  else pending.push(job)
}
