// Parsers for the agents' file contract: a header of `KEY: value` lines (or a
// bare verdict line), a blank line, then `## Section` blocks.

export function firstLine(text: string): string {
  return (text.split('\n', 1)[0] ?? '').trim()
}

/** `KEY: value` lines at the top of a file, up to the first blank line. */
export function header(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (!line.trim()) break
    const at = line.indexOf(':')
    if (at < 0) continue
    fields[line.slice(0, at).trim().toUpperCase()] = line.slice(at + 1).trim()
  }
  return fields
}

/** Everything after the header block, trimmed. */
export function body(text: string): string {
  const at = text.indexOf('\n\n')
  return at < 0 ? '' : text.slice(at + 2).trim()
}

/** Body of a `## heading` section, or null. */
export function section(text: string, heading: string): string | null {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trimEnd() === `## ${heading}`)
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => l.startsWith('## '))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}
