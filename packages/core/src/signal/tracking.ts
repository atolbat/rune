// Dependency tracking stack: signal.value on read registers the cell
// in the derive's active collector. A tiny reactive runtime without
// allocations on the hot path (registration is a push into a reused array).

const collectors: unknown[][] = []

export function pushCollector(sink: unknown[]): void {
  collectors.push(sink)
}

export function popCollector(): void {
  collectors.pop()
}

export function reportRead(cell: unknown): void {
  const top = collectors[collectors.length - 1]
  if (top !== undefined) top.push(cell)
}
