import type * as Monaco from 'monaco-editor'
import { isServerMode } from '@/lib/api-client'
import { completeOnServer } from '@/lib/api/execution'
import { completePython } from '@/lib/runtimes/pyodide-engine'
import { completeR } from '@/lib/runtimes/webr-engine'
import type { CodeCompletionItem } from '@/lib/runtimes/types'
import { loadSqlCatalog } from '@/lib/sql-catalog'
import { sqlCompletions, type SqlCompletionKind } from '@/lib/sql-completion'

/** What an editor completes against: a database's schema, or the project's kernel. */
export type EditorCompletion =
  | { kind: 'sql'; dataSourceId: string | null | undefined }
  | { kind: 'kernel'; projectUid: string | null | undefined }

// Monaco providers are global per language, while the context is per editor:
// each editor binds its model to a getter, and the provider looks it up.
const bound = new Map<string, () => EditorCompletion | undefined>()
let registered = false

/** Binds `model` to its editor's completion context; returns the unbind. */
export function bindEditorCompletion(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  get: () => EditorCompletion | undefined,
): () => void {
  registerProviders(monaco)
  const key = model.uri.toString()
  bound.set(key, get)
  return () => { if (bound.get(key) === get) bound.delete(key) }
}

const contextOf = (model: Monaco.editor.ITextModel) => bound.get(model.uri.toString())?.()

function registerProviders(monaco: typeof Monaco) {
  if (registered) return
  registered = true
  const K = monaco.languages.CompletionItemKind

  const sqlKind: Record<SqlCompletionKind, Monaco.languages.CompletionItemKind> = {
    schema: K.Module,
    table: K.Struct,
    column: K.Field,
    keyword: K.Keyword,
    function: K.Function,
  }

  monaco.languages.registerCompletionItemProvider('sql', {
    // Space opens the list only where a table is expected (`FROM ⎵`): the list is
    // short and wanted there. After `SELECT ⎵` it would pop on every space while the
    // user types `*` or `COUNT(` — the first letter, or Ctrl+Space, opens it.
    triggerCharacters: ['.', ' '],
    async provideCompletionItems(model, position, context) {
      const ctx = contextOf(model)
      if (ctx?.kind !== 'sql' || !ctx.dataSourceId) return { suggestions: [] }
      let catalog
      try {
        catalog = await loadSqlCatalog(ctx.dataSourceId)
      } catch {
        return { suggestions: [] }
      }
      const offset = model.getOffsetAt(position)
      const { items, wordStart, slot } = sqlCompletions(model.getValue(), offset, catalog)
      if (context.triggerCharacter === ' ' && slot !== 'table') return { suggestions: [] }
      const start = model.getPositionAt(wordStart)
      const range = new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column)
      return {
        suggestions: items.map((it) => ({
          label: { label: it.label, description: it.detail },
          kind: sqlKind[it.kind],
          insertText: it.insertText,
          filterText: it.label,
          sortText: `${it.rank}_${it.label.toLowerCase()}`,
          range,
        })),
      }
    },
  })

  // jedi's types and R's suffixes (`fn(`, `arg=`) → Monaco icons.
  const kernelKind = (kind: string): Monaco.languages.CompletionItemKind => {
    switch (kind) {
      case 'function': return K.Function
      case 'class': return K.Class
      case 'module': return K.Module
      case 'keyword': return K.Keyword
      case 'property': return K.Property
      case 'path': return K.File
      case 'param':
      case 'argument': return K.Variable
      default: return K.Variable
    }
  }

  const complete = (language: 'python' | 'r', projectUid: string | null | undefined, code: string, cursor: number) => {
    if (isServerMode()) return projectUid ? completeOnServer(language, code, cursor, projectUid) : Promise.resolve([])
    return language === 'python' ? completePython(code, cursor) : completeR(code, cursor)
  }

  for (const language of ['python', 'r'] as const) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: language === 'python' ? ['.'] : ['$', '@', ':'],
      async provideCompletionItems(model, position, _context, token) {
        const ctx = contextOf(model)
        if (ctx?.kind !== 'kernel') return { suggestions: [] }
        let items: CodeCompletionItem[]
        try {
          items = await complete(language, ctx.projectUid, model.getValue(), model.getOffsetAt(position))
        } catch {
          return { suggestions: [] }
        }
        if (token.isCancellationRequested) return { suggestions: [] }
        return {
          suggestions: items.map((it, i) => {
            const start = model.getPositionAt(Math.max(0, model.getOffsetAt(position) - it.typed))
            return {
              label: it.label,
              kind: kernelKind(it.kind),
              insertText: it.insert,
              // R replaces the whole `df$co` token: filter on it, not on the label.
              filterText: it.insert,
              sortText: String(i).padStart(4, '0'),
              range: new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column),
            }
          }),
        }
      },
    })
  }
}
