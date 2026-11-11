// Claude Desktop writes session records as compact JSON and its settings stores indented with
// tabs. A file we change keeps the indentation it had, so it still looks like the app wrote it.
export function indentOf(text) {
  const match = /^\{\r?\n([ \t]+)/.exec(text)
  return match ? match[1] : undefined
}

export function stringifyLike(original, value) {
  return JSON.stringify(value, null, indentOf(original)) + (original.endsWith('\n') ? '\n' : '')
}

// A record's bytes with isArchived set; the same bytes when it already has that value.
export function withArchived(bytes, isArchived) {
  const text = bytes.toString('utf8')
  const data = JSON.parse(text)
  if (data.isArchived === isArchived) return bytes
  data.isArchived = isArchived
  return Buffer.from(stringifyLike(text, data))
}
