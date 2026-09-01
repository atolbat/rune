/**
 * Лёгкий статический линтер WGSL: ловит пропущенные ';' в телах функций —
 * класс ошибки, который Tint репортит только на устройстве.
 * (Инцидент: «expected ';' for variable declaration (строка 21)».)
 */

/** Проблема линтера: строка и описание. */
export interface WgslLintProblem {
  readonly line: number
  readonly text: string
}

/** Проверяет WGSL: каждая строка-оператор должна заканчиваться корректно. */
export function lintWgsl(source: string): WgslLintProblem[] {
  const problems: WgslLintProblem[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const problem = lintLine(lines[i], i + 1)
    if (problem !== null) problems.push(problem)
  }
  return problems
}

function lintLine(raw: string, line: number): WgslLintProblem | null {
  const text = raw.trim()
  if (isSkippable(text)) return null
  if (endsWithTerminator(text)) return null
  return { line, text: `нет ';' в конце оператора: "${text}"` }
}

function isSkippable(text: string): boolean {
  if (text === '' || text.startsWith('//')) return true
  if (text.startsWith('@')) return true // атрибут
  if (text.startsWith('fn ') || text.startsWith('struct ')) return true
  if (text.startsWith(')')) return true // закрытие сигнатуры функции
  if (text.startsWith('}')) return true // закрытие блока
  return false
}

function endsWithTerminator(text: string): boolean {
  return (
    text.endsWith(';') || // оператор
    text.endsWith('{') || // открытие блока
    text.endsWith('}') || // закрытие блока
    text.endsWith(',') || // член структуры / параметр
    text.endsWith('(') || // перенос вызова
    text.endsWith('->') // сигнатура без типа
  )
}
