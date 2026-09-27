/** Dataset editing (the op log, column types, import options) and dataset analyses. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import {
  columnId, retypeAddedColumn, type DatasetCellValue, type DatasetOp, type DatasetOpColumnType,
} from '@linkr/format'
import { coerceValue, fitsColumnType } from '@/lib/dataset-utils'
import { findColumn, resolveColumns, type DatasetColumn } from './lab.js'
import {
  COLUMN_TYPES, buildRowFilters, cellValue, columnOrderWith, formatRowPage, nextAddedRow, opBase, summarizeOps,
  undoStart, type PluginLanguage, type RowFilterInput,
} from './lab-extra.js'
import { DESTRUCTIVE, READ, WRITE, api, failure, guard, text, type Server } from './shared.js'
import {
  colList, columnsOf, ds, me, q, resolvePlugin, scriptLanguage, workspaceOfProject, type DatasetAnalysis,
  type DsNode,
} from './lab-rest.js'

export function registerLabDatasetTools(server: Server): void {
  server.registerTool('create_dataset', {
    description:
      'Create an empty dataset (a table in the project\'s lab) from a list of columns — the start of a manual '
      + 'collection, filled row by row with add_dataset_rows. Stored as a CSV holding just the header. '
      + 'For a dataset from a database query, use create_dataset_from_query instead.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; columns: { name: string; type?: string }[] }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        path: { type: 'string', description: 'e.g. "collection/sofa" (.csv is added), or inside a folder.' },
        columns: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, type: { type: 'string', enum: COLUMN_TYPES } },
            required: ['name'],
          },
        },
      },
      required: ['project_uid', 'path', 'columns'],
    }),
  }, guard(async ({ project_uid, path, columns }) => {
    const file = /\.[a-z0-9]+$/i.test(path) ? path : `${path}.csv`
    if (!file.toLowerCase().endsWith('.csv')) return failure('An empty dataset is a CSV: use a .csv path or no extension.')
    const ids = columns.map((c) => columnId(c.name))
    const dup = ids.find((id, i) => ids.indexOf(id) !== i)
    if (dup) return failure(`Two columns resolve to the same id ${dup}: names must differ.`)
    const node = await api.request<DsNode>('POST', '/dataset-files/create-empty', {
      projectUid: project_uid, path: file,
      columns: columns.map((c, i) => ({ id: ids[i], name: c.name.trim(), type: c.type ?? 'string', order: i })),
    })
    return text(`Created dataset ${node.path} — columns: ${columnsOf(node).map((c) => `${c.id} (${c.type})`).join(', ')}`)
  }))

  server.registerTool('create_dataset_folder', {
    description: 'Create a folder in the project\'s datasets, to group datasets (move_dataset moves one in).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string }>({
      type: 'object', properties: { project_uid: { type: 'string' }, path: { type: 'string' } }, required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path }) => {
    const node = await api.request<DsNode>('POST', '/dataset-files/folder', { projectUid: project_uid, path })
    return text(`Created folder ${node.path}.`)
  }))

  server.registerTool('find_dataset_rows', {
    description:
      'Rows of a dataset matching filters, sorted and paged, each with its row number — the handle '
      + 'set_dataset_cells and remove_dataset_rows take. Row-level (often patient-level) data: use only when '
      + 'the values are needed, and prefer describe_dataset with stats for summaries.',
    annotations: READ,
    inputSchema: fromJsonSchema<{
      project_uid: string; path: string; filters?: RowFilterInput[]; sort?: { column: string; desc?: boolean }
      offset?: number; limit?: number; columns?: string[]
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        path: { type: 'string' },
        filters: {
          type: 'array',
          description: 'All must match. Per filter, one test: equals / one_of (any column), contains (text), '
            + 'min / max (numbers), from / to (dates, YYYY-MM-DD), missing (true = only empty, false = exclude empty).',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: 'Name or id.' },
              equals: { type: ['string', 'number', 'boolean'] },
              one_of: { type: 'array', items: { type: ['string', 'number'] } },
              contains: { type: 'string' },
              min: { type: 'number' }, max: { type: 'number' },
              from: { type: 'string' }, to: { type: 'string' },
              missing: { type: 'boolean' },
            },
            required: ['column'],
          },
        },
        sort: { type: 'object', properties: { column: { type: 'string' }, desc: { type: 'boolean' } }, required: ['column'] },
        offset: { type: 'number' },
        limit: { type: 'number', description: 'Default 20, max 100.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Only show these columns (names or ids).' },
      },
      required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path, filters, sort, offset, limit, columns: pick }) => {
    const node = await ds.meta(project_uid, path)
    const cols = columnsOf(node)
    const built = buildRowFilters(filters ?? [], cols)
    const sortCol = sort ? findColumn(cols, sort.column) : undefined
    if (sort && !sortCol) built.errors.push(`No column "${sort.column}" to sort on.`)
    const shown = pick?.length ? pick.map((r) => findColumn(cols, r)) : cols
    if (shown.some((c) => !c)) built.errors.push(`Unknown column in columns (columns: ${colList(cols)}).`)
    if (built.errors.length) return failure(built.errors.join('\n'))
    const n = Math.min(limit ?? 20, 100)
    const start = Math.max(offset ?? 0, 0)
    const page = await ds.rows(project_uid, path, {
      offset: start, limit: n, filters: built.filters, na: built.na,
      ...(sortCol ? { sort: { colId: sortCol.id, dir: sort?.desc ? 'desc' : 'asc' } } : {}),
    })
    // An unedited dataset's cache has no row-number column: its rows are then the
    // raw file's, in order, which only holds for an unfiltered, unsorted page.
    const plain = !built.filters.length && !built.na.length && !sortCol
    const out = [`${page.total} matching row(s); showing ${start + 1}–${start + page.rows.length}.`,
      formatRowPage(page.rows, shown as DatasetColumn[], start, plain)]
    if (page.rows.length && !('__row_ord' in page.rows[0]) && !plain) {
      out.push('(Row numbers "?" are unknown here: the dataset has never been edited, so they are only reported '
        + 'for an unfiltered, unsorted listing.)')
    }
    return text(out.join('\n'))
  }))

  server.registerTool('list_column_values', {
    description: 'The distinct values of a dataset column, alphabetically (up to 1000), optionally matching a search '
      + 'term — to pick filter values or check codes. Aggregate, not row-level.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; column: string; search?: string; limit?: number }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' }, column: { type: 'string', description: 'Name or id.' },
        search: { type: 'string' }, limit: { type: 'number', description: 'Default 200, max 1000.' },
      },
      required: ['project_uid', 'path', 'column'],
    }),
  }, guard(async ({ project_uid, path, column, search, limit }) => {
    const cols = columnsOf(await ds.meta(project_uid, path))
    const col = findColumn(cols, column)
    if (!col) return failure(`No column "${column}" (columns: ${colList(cols)}).`)
    const res = await ds.distinct(project_uid, path, col.id, Math.min(limit ?? 200, 1000), search)
    const values = Array.isArray(res) ? res : ((res as { values?: unknown[] }).values ?? [])
    const body = JSON.stringify(values)
    return text(`${values.length} distinct value(s) of ${col.name}:\n${body.length > 8000 ? `${body.slice(0, 8000)}… (truncated)` : body}`)
  }))

  server.registerTool('add_dataset_column', {
    description:
      'Add an empty column to a dataset. Recorded in the dataset\'s edit history (undoable in Linkr); the raw file '
      + 'is never touched. Fill it with set_dataset_cells.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; name: string; type?: string; after?: string }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' }, name: { type: 'string' },
        type: { type: 'string', enum: COLUMN_TYPES, description: 'Default string.' },
        after: { type: 'string', description: 'Column (name or id) to insert after; "" for first. Default: last.' },
      },
      required: ['project_uid', 'path', 'name'],
    }),
  }, guard(async ({ project_uid, path, name, type, after }) => {
    const cols = columnsOf(await ds.meta(project_uid, path))
    const trimmed = name.trim()
    const id = columnId(trimmed)
    if (cols.some((c) => c.id === id)) return failure(`A column with id ${id} already exists.`)
    let index: number | undefined
    if (after !== undefined) {
      if (after === '') index = 0
      else {
        const prev = findColumn(cols, after)
        if (!prev) return failure(`No column "${after}" (columns: ${colList(cols)}).`)
        index = cols.findIndex((c) => c.id === prev.id) + 1
      }
    }
    const { by } = await me()
    await ds.ops(project_uid, path, [{
      ...opBase(randomUUID(), by, randomUUID()), type: 'addColumn', column: id, name: trimmed,
      colType: (type ?? 'string') as DatasetOpColumnType, ...(index !== undefined ? { index } : {}),
    }])
    return text(`Added column ${trimmed} (${id}, ${type ?? 'string'}).`)
  }))

  server.registerTool('set_dataset_column_type', {
    description:
      'Change the type of a dataset column (string, number, boolean, date) — the table\'s "Treat as…". Values that do '
      + 'not convert become empty in a parsed column, or are kept as typed in a column added by an edit; both are counted.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; column: string; type: string }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' }, column: { type: 'string', description: 'Name or id.' },
        type: { type: 'string', enum: COLUMN_TYPES },
      },
      required: ['project_uid', 'path', 'column', 'type'],
    }),
  }, guard(async ({ project_uid, path, column, type }) => {
    const node = await ds.meta(project_uid, path)
    const col = findColumn(columnsOf(node), column)
    if (!col) return failure(`No column "${column}" (columns: ${colList(columnsOf(node))}).`)
    const t = type as DatasetOpColumnType
    // A column the log added is rebuilt from its own op on every replay, so the
    // type lives there; a parsed column's lives in the parse options.
    const retyped = retypeAddedColumn(node.ops ?? [], col.id, t,
      (v) => (fitsColumnType(v, t) ? coerceValue(v, t) as DatasetCellValue : null))
    if (retyped.changed) {
      await ds.ops(project_uid, path, retyped.ops, true)
      return text(`${col.name} is now ${type}.${retyped.rejected.length ? ` ${retyped.rejected.length} value(s) do not fit and were kept as typed.` : ''}`)
    }
    const parseOptions = node.parseOptions ?? {}
    const columnTypes = { ...(parseOptions.columnTypes as Record<string, string> | undefined), [col.id]: type }
    const updated = await ds.reimport(project_uid, path, { ...parseOptions, columnTypes })
    const now = columnsOf(updated).find((c) => c.id === col.id)
    return text(`${col.name} is now ${now?.type ?? type}.`)
  }))

  server.registerTool('move_dataset_column', {
    description: 'Move a dataset column to another position (after a given column, or first). An edit-history entry.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; column: string; after?: string }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' }, column: { type: 'string', description: 'Name or id.' },
        after: { type: 'string', description: 'Column (name or id) to land after. Omit to move it first.' },
      },
      required: ['project_uid', 'path', 'column'],
    }),
  }, guard(async ({ project_uid, path, column, after }) => {
    const cols = columnsOf(await ds.meta(project_uid, path))
    const col = findColumn(cols, column)
    const prev = after ? findColumn(cols, after) : null
    if (!col || (after && !prev)) return failure(`No column "${!col ? column : after}" (columns: ${colList(cols)}).`)
    if (prev?.id === col.id) return failure('A column cannot move after itself.')
    const order = columnOrderWith(cols.map((c) => c.id), col.id, prev?.id ?? null)
    const { by } = await me()
    await ds.ops(project_uid, path, [{ ...opBase(randomUUID(), by, randomUUID()), type: 'reorderColumns', order }])
    return text(`Moved ${col.name}. Order: ${order.join(', ')}`)
  }))

  server.registerTool('set_dataset_cells', {
    description:
      'Write values into dataset cells, addressed by row number (from find_dataset_rows) and column. Each value is '
      + 'read into its column\'s type; a value that does not fit is refused. One undoable action in the edit history.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      project_uid: string; path: string; cells: { row: number; column: string; value: string | number | boolean | null }[]
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' },
        cells: {
          type: 'array', minItems: 1, maxItems: 500,
          items: {
            type: 'object',
            properties: {
              row: { type: 'number', description: 'Row number from find_dataset_rows.' },
              column: { type: 'string', description: 'Name or id.' },
              value: { type: ['string', 'number', 'boolean', 'null'], description: 'null or "" empties the cell.' },
            },
            required: ['row', 'column', 'value'],
          },
        },
      },
      required: ['project_uid', 'path', 'cells'],
    }),
  }, guard(async ({ project_uid, path, cells }) => {
    const cols = columnsOf(await ds.meta(project_uid, path))
    const errors: string[] = []
    const { by } = await me()
    const group = randomUUID()
    const ops: DatasetOp[] = []
    for (const c of cells) {
      const col = findColumn(cols, c.column)
      if (!col) { errors.push(`No column "${c.column}".`); continue }
      if (!Number.isInteger(c.row)) { errors.push(`Row ${c.row} is not a row number.`); continue }
      const v = cellValue(c.value, col.type)
      if ('error' in v) { errors.push(`row ${c.row}, ${col.name}: ${v.error}.`); continue }
      ops.push({ ...opBase(group, by, randomUUID()), type: 'setCell', row: c.row, column: col.id, value: v.value })
    }
    if (errors.length) return failure(`Nothing written:\n- ${errors.join('\n- ')}${errors.some((e) => e.startsWith('No column')) ? `\nColumns: ${colList(cols)}` : ''}`)
    await ds.ops(project_uid, path, ops)
    return text(`Wrote ${ops.length} cell(s). A row number that does not exist is ignored by the dataset; check with find_dataset_rows.`)
  }))

  server.registerTool('add_dataset_rows', {
    description:
      'Append rows to a dataset (a manual collection, a missing record…), values keyed by column name or id. '
      + 'Returns the new rows\' numbers. One undoable action in the edit history.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; rows: Record<string, string | number | boolean | null>[] }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' },
        rows: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', description: 'column → value' } },
      },
      required: ['project_uid', 'path', 'rows'],
    }),
  }, guard(async ({ project_uid, path, rows }) => {
    const node = await ds.meta(project_uid, path)
    const cols = columnsOf(node)
    const errors: string[] = []
    const { by } = await me()
    const group = randomUUID()
    let next = nextAddedRow(node.ops ?? [])
    const ops: DatasetOp[] = []
    rows.forEach((r, i) => {
      const values: Record<string, DatasetCellValue> = {}
      for (const [k, raw] of Object.entries(r)) {
        const col = findColumn(cols, k)
        if (!col) { errors.push(`row ${i + 1}: no column "${k}".`); continue }
        const v = cellValue(raw, col.type)
        if ('error' in v) errors.push(`row ${i + 1}, ${col.name}: ${v.error}.`)
        else values[col.id] = v.value
      }
      ops.push({ ...opBase(group, by, randomUUID()), type: 'addRow', row: next--, values })
    })
    if (errors.length) return failure(`Nothing added:\n- ${errors.join('\n- ')}\nColumns: ${colList(cols)}`)
    await ds.ops(project_uid, path, ops)
    return text(`Added ${ops.length} row(s): row numbers ${ops.map((o) => (o as { row: number }).row).join(', ')}.`)
  }))

  server.registerTool('remove_dataset_rows', {
    description: 'Remove rows from a dataset by row number (find_dataset_rows). The raw file is untouched and the '
      + 'removal is undoable in Linkr\'s edit history. Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; rows: number[] }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, path: { type: 'string' }, rows: { type: 'array', items: { type: 'number' }, minItems: 1 } },
      required: ['project_uid', 'path', 'rows'],
    }),
  }, guard(async ({ project_uid, path, rows }) => {
    const { by } = await me()
    const group = randomUUID()
    const res = await ds.ops(project_uid, path, rows.map((row) => ({ ...opBase(group, by, randomUUID()), type: 'removeRow' as const, row })))
    return text(`Removed ${rows.length} row(s); the dataset now has ${res.node.rowCount ?? '?'} rows.`)
  }))

  server.registerTool('get_dataset_edit_history', {
    description: 'A dataset\'s edit history: the actions recorded over its raw file (added columns, cell edits, '
      + 'removed rows…), newest first, with who made them.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string }>({
      type: 'object', properties: { project_uid: { type: 'string' }, path: { type: 'string' } }, required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path }) => text(summarizeOps((await ds.meta(project_uid, path)).ops ?? []))))

  server.registerTool('undo_dataset_edits', {
    description: 'Undo the last action(s) of a dataset\'s edit history (get_dataset_edit_history), like the Undo of '
      + 'Linkr\'s dataset table. The history is shared: check the last actions are the ones meant, and ask the user '
      + 'first when they are not yours.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; steps?: number }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, path: { type: 'string' }, steps: { type: 'number', description: 'Default 1.' } },
      required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path, steps }) => {
    const log = (await ds.meta(project_uid, path)).ops ?? []
    if (!log.length) return failure('This dataset has no edit to undo.')
    const start = undoStart(log, Math.max(1, Math.floor(steps ?? 1)))
    await ds.ops(project_uid, path, log.slice(0, start), true)
    return text(`Undid ${log.length - start} op(s). ${summarizeOps(log.slice(0, start), 5)}`)
  }))

  server.registerTool('set_dataset_import_options', {
    description:
      'Re-read a dataset\'s raw file (CSV / Excel) with other import options: delimiter, encoding, rows to skip, '
      + 'header, Excel sheet, tokens read as missing. With preview, shows the resulting columns and first rows '
      + 'without changing anything.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      project_uid: string; path: string; delimiter?: string; encoding?: string; skip_rows?: number; has_header?: boolean
      sheet?: string; na_values?: string[]; preview?: boolean
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' },
        delimiter: { type: 'string', description: 'e.g. ",", ";", "\\t".' },
        encoding: { type: 'string', description: 'e.g. "utf-8", "latin-1".' },
        skip_rows: { type: 'number' }, has_header: { type: 'boolean' },
        sheet: { type: 'string', description: 'Excel sheet name.' },
        na_values: { type: 'array', items: { type: 'string' }, description: 'Read as missing, e.g. ["NA", "N/A", "-"].' },
        preview: { type: 'boolean', description: 'Only show the result. Default false.' },
      },
      required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path, delimiter, encoding, skip_rows, has_header, sheet, na_values, preview }) => {
    const current = (await ds.meta(project_uid, path)).parseOptions ?? {}
    const changes = Object.fromEntries(Object.entries({
      delimiter, encoding, skipRows: skip_rows, hasHeader: has_header, sheet, naValues: na_values,
    }).filter(([, v]) => v !== undefined))
    if (Object.keys(changes).length === 0) return failure('Nothing to change: give at least one option.')
    const parseOptions = { ...current, ...changes }
    if (preview) {
      const p = await ds.previewPath(project_uid, path, parseOptions)
      return text([
        `${p.rowCount} rows; columns: ${p.columns.map((c) => `${c.name} (${c.type})`).join(', ')}`,
        ...(p.sheetNames?.length ? [`Sheets: ${p.sheetNames.join(', ')}`] : []),
        formatRowPage(p.preview.slice(0, 5), p.columns, 0, true),
      ].join('\n'))
    }
    const node = await ds.reimport(project_uid, path, parseOptions)
    return text(`Re-read ${path}: ${node.rowCount ?? '?'} rows; columns: ${columnsOf(node).map((c) => `${c.id} (${c.type})`).join(', ')}. `
      + 'Widgets or filters on columns whose id changed must be updated.')
  }))

  // --- Dataset analyses ----------------------------------------------------------

  server.registerTool('list_dataset_analyses', {
    description: 'The analyses attached to a dataset: tabs beside its table in Linkr, each a plugin (table 1, plot, '
      + 'regression…) or custom R/Python code run on the dataset.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string }>({
      type: 'object', properties: { project_uid: { type: 'string' }, path: { type: 'string' } }, required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path }) => {
    const list = await ds.analyses(project_uid, path)
    if (list.length === 0) return text('No analysis on this dataset.')
    return text(list.map((a) => `- "${a.name}" — analysis_id: ${a.id} · ${a.type} · config ${JSON.stringify(a.config).slice(0, 300)}`).join('\n'))
  }))

  server.registerTool('create_dataset_analysis', {
    description:
      'Attach an analysis to a dataset: a lab plugin (list_plugins / describe_plugin, or a workspace plugin from '
      + 'list_user_plugins) with its config — columns by name or id — or custom code (plugin_id "inline" with '
      + 'language and code; the dataset is injected as `dataset`).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      project_uid: string; path: string; name: string; plugin_id: string; config?: Record<string, unknown>
      language?: PluginLanguage; code?: string
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' },
        name: { type: 'string', description: 'Tab title; unique among the dataset\'s analyses.' },
        plugin_id: { type: 'string' },
        config: { type: 'object' },
        language: { type: 'string', enum: ['python', 'r'], description: 'Script plugins and inline code.' },
        code: { type: 'string', description: 'inline only.' },
      },
      required: ['project_uid', 'path', 'name', 'plugin_id'],
    }),
  }, guard(async ({ project_uid, path, name, plugin_id, config, language, code }) => {
    const existing = await ds.analyses(project_uid, path)
    if (existing.some((a) => a.name.toLowerCase() === name.trim().toLowerCase())) {
      return failure(`An analysis "${name}" already exists on this dataset.`)
    }
    let type = plugin_id
    let stored: Record<string, unknown>
    if (plugin_id === 'inline') {
      if (!language) return failure('inline needs a language (python or r).')
      stored = { language, code: code ?? `# ${language} code here\n` }
    } else {
      const plugin = await resolvePlugin(plugin_id, 'lab', await workspaceOfProject(project_uid))
      if (!plugin) return failure(`Unknown lab plugin "${plugin_id}" (see list_plugins, list_user_plugins).`)
      const lang = scriptLanguage(plugin.manifest, plugin.templates, language)
      if (lang.error) return failure(lang.error)
      const cols = columnsOf(await ds.meta(project_uid, path))
      const resolved = resolveColumns(config ?? {}, plugin.manifest, cols)
      if (resolved.errors.length) return failure(`Not created:\n- ${resolved.errors.join('\n- ')}`)
      type = plugin.manifest.id
      stored = { ...resolved.config, ...(lang.language ? { language: lang.language } : {}) }
    }
    const a = await api.request<DatasetAnalysis>('POST', '/dataset-files/analyses', {
      id: randomUUID(), projectUid: project_uid, datasetPath: path, name: name.trim(), type, config: stored,
    })
    return text(`Created analysis "${a.name}" — analysis_id: ${a.id}`)
  }))

  server.registerTool('update_dataset_analysis', {
    description: 'Rename a dataset analysis or change its config (fields merged; null clears one; columns by name or '
      + 'id). For inline code, config.code replaces the code.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; analysis_id: string; name?: string; config?: Record<string, unknown> }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' }, analysis_id: { type: 'string' },
        name: { type: 'string' }, config: { type: 'object' },
      },
      required: ['project_uid', 'path', 'analysis_id'],
    }),
  }, guard(async ({ project_uid, path, analysis_id, name, config }) => {
    const a = (await ds.analyses(project_uid, path)).find((x) => x.id === analysis_id)
    if (!a) return failure(`No analysis ${analysis_id} on ${path} (see list_dataset_analyses).`)
    const changes: Record<string, unknown> = {}
    if (name !== undefined) changes.name = name.trim()
    if (config) {
      const merged = Object.fromEntries(Object.entries({ ...a.config, ...config }).filter(([, v]) => v !== null))
      if (a.type !== 'inline') {
        const plugin = await resolvePlugin(a.type, 'lab', await workspaceOfProject(project_uid))
        if (plugin) {
          const { language, ...rest } = merged
          const resolved = resolveColumns(rest, plugin.manifest, columnsOf(await ds.meta(project_uid, path)))
          if (resolved.errors.length) return failure(`Not updated:\n- ${resolved.errors.join('\n- ')}`)
          changes.config = { ...resolved.config, ...(language ? { language } : {}) }
        } else changes.config = merged
      } else changes.config = merged
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change: give name or config.')
    await api.request('PATCH', `/dataset-files/analyses/${q(analysis_id)}`, changes)
    return text(`Updated analysis ${analysis_id}.`)
  }))

  server.registerTool('delete_dataset_analysis', {
    description: 'Delete an analysis from a dataset. Irreversible: ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ analysis_id: string }>({
      type: 'object', properties: { analysis_id: { type: 'string' } }, required: ['analysis_id'],
    }),
  }, guard(async ({ analysis_id }) => {
    await api.request('DELETE', `/dataset-files/analyses/${q(analysis_id)}`)
    return text(`Deleted analysis ${analysis_id}.`)
  }))
}
