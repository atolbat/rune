// Стек трекинга зависимостей: signal.value при чтении регистрирует ячейку
// в активном сборщике derive. Крошечный реактивный рантайм без аллокаций
// на горячем пути (регистрация — push в переиспользуемый массив).

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
