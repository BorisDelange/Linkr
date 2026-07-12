/** Map an export-tree file path to a Monaco language id for syntax highlighting. */

const BY_EXTENSION: Record<string, string> = {
  json: 'json',
  md: 'markdown',
  py: 'python',
  r: 'r',
  sql: 'sql',
  sh: 'shell',
  csv: 'plaintext',
  txt: 'plaintext',
  yaml: 'yaml',
  yml: 'yaml',
  html: 'html',
  css: 'css',
  js: 'javascript',
  ts: 'typescript',
  gitignore: 'plaintext',
}

export function monacoLanguageFor(path: string): string {
  const name = path.split('/').pop() ?? path
  // Dotfiles like ".gitignore" have no extension after the dot split.
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : name.toLowerCase()
  return BY_EXTENSION[ext] ?? 'plaintext'
}
