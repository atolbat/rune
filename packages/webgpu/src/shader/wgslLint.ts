/**
 * A lightweight static WGSL linter: catches missing ';' in function bodies —
 * a class of error that Tint reports only on device.
 * (Incident: "expected ';' for variable declaration (line 21)".)
 */

/** Linter problem: line and description. */
export interface WgslLintProblem {
  readonly line: number
  readonly text: string
}

/** Checks WGSL: every statement line must end correctly. */
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
  return { line, text: `no ';' at end of statement: "${text}"` }
}

function isSkippable(text: string): boolean {
  if (text === '' || text.startsWith('//')) return true
  if (text.startsWith('@')) return true // attribute
  if (text.startsWith('fn ') || text.startsWith('struct ')) return true
  if (text.startsWith(')')) return true // closing a function signature
  if (text.startsWith('}')) return true // closing a block
  return false
}

function endsWithTerminator(text: string): boolean {
  return (
    text.endsWith(';') || // statement
    text.endsWith('{') || // opening a block
    text.endsWith('}') || // closing a block
    text.endsWith(',') || // struct member / parameter
    text.endsWith('(') || // call continuation
    text.endsWith('->') // signature without type
  )
}
