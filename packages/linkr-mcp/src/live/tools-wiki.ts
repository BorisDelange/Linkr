/** The workspace wiki, data catalogs, and the READMEs of workspace entities. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { computeCatalogBase, computePeriodBatch } from '@/lib/duckdb/catalog-batch'
import { buildCategoryLabelsQuery, buildServiceLabelsQuery } from '@/lib/duckdb/catalog-queries'
import { buildPointer } from '@/lib/import-identity'
import { localized, setLocalized } from '@/lib/localized'
import { slugifyId, uniqueEntityId } from '@/lib/slugify-id'
import { userDisplayName, userToAuthorDetails } from '@/lib/user-identity'
import { AGE_BRACKET_PRESETS, getDefaultDimensions } from '@/types/catalog'
import type { CatalogResultCache, DataCatalog, LocalizedString, User, WikiPage } from '@/types'
import {
  DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, text, type Server,
} from './shared.js'
import type { DataSource } from './api.js'
import {
  README_OWNERS, breadcrumbs, catalogClassColumns, catalogPatch, clip, describeCatalogConfig, describeCatalogStatus,
  planMove, readmeIn, renderCatalogResults, renderWikiTree, subtreeIds, wikiSlug, withReadme,
  type CatalogChanges, type ReadmeOwner, type ResultsView,
} from './wiki.js'

const MAX_CONTENT = 40_000

const SCOPE_PROPS = {
  workspace_id: { type: 'string', description: 'The workspace id.' },
  project_uid: { type: 'string', description: 'Alternatively, a project: its workspace is used.' },
} as const

interface Scope { workspace_id?: string; project_uid?: string }

async function workspaceOf({ workspace_id, project_uid }: Scope): Promise<string> {
  if (workspace_id) return workspace_id
  if (project_uid) {
    const project = await api.getProject(project_uid)
    if (!project.workspaceId) throw new Error(`Project ${project_uid} belongs to no workspace.`)
    return project.workspaceId
  }
  throw new Error('Give workspace_id or project_uid (list_projects lists the projects).')
}

interface WikiAttachmentMeta { id: string; fileName: string; mimeType: string; fileSize: number }
interface ReadmeAttachmentMeta { id: string; fileName: string; mimeType: string; fileSize: number }
interface StatsCacheWire { computedAt: string; payload: Record<string, unknown> }

const wiki = {
  list: (workspaceId: string) => api.request<WikiPage[]>('GET', `/wiki-pages?workspaceId=${encodeURIComponent(workspaceId)}`),
  get: (id: string) => api.request<WikiPage>('GET', `/wiki-pages/${encodeURIComponent(id)}`),
  search: (workspaceId: string, q: string) => api.request<{ id: string; title: LocalizedString; snippet: string }[]>(
    'GET', `/wiki-pages/search?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(q)}`),
  create: (body: Record<string, unknown>) => api.request<WikiPage>('POST', '/wiki-pages', body),
  update: (id: string, changes: Record<string, unknown>) => api.request<WikiPage>('PATCH', `/wiki-pages/${encodeURIComponent(id)}`, changes),
  delete: (id: string) => api.request<void>('DELETE', `/wiki-pages/${encodeURIComponent(id)}`),
  attachments: (pageId: string) => api.request<WikiAttachmentMeta[]>('GET', `/wiki-attachments?pageId=${encodeURIComponent(pageId)}`),
  deleteAttachments: (pageId: string) => api.request<void>('DELETE', `/wiki-attachments?pageId=${encodeURIComponent(pageId)}`),
}

const catalogs = {
  list: (workspaceId?: string) => api.request<DataCatalog[]>('GET', `/data-catalogs${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`),
  get: (id: string) => api.request<DataCatalog>('GET', `/data-catalogs/${encodeURIComponent(id)}`),
  create: (body: Record<string, unknown>) => api.request<DataCatalog>('POST', '/data-catalogs', body),
  update: (id: string, changes: Record<string, unknown>) => api.request<DataCatalog>('PATCH', `/data-catalogs/${encodeURIComponent(id)}`, changes),
  delete: (id: string) => api.request<void>('DELETE', `/data-catalogs/${encodeURIComponent(id)}`),
  getResults: async (id: string): Promise<CatalogResultCache | null> => {
    const wire = await api.request<StatsCacheWire | null>('GET', `/data-catalogs/${encodeURIComponent(id)}/results-cache`)
    return wire ? { ...(wire.payload as object), catalogId: id, computedAt: wire.computedAt } as CatalogResultCache : null
  },
  saveResults: (cache: CatalogResultCache) => {
    const { catalogId, computedAt, ...payload } = cache
    return api.request<unknown>('PUT', `/data-catalogs/${encodeURIComponent(catalogId)}/results-cache`, { computedAt, payload })
  },
  deleteResults: (id: string) => api.request<void>('DELETE', `/data-catalogs/${encodeURIComponent(id)}/results-cache`),
}

/** What the app stamps on a created entity (stampAuthored): the server does not. */
async function authored() {
  const me = await api.request<User>('GET', '/auth/me')
  return { createdById: me.id, createdBy: userDisplayName(me), createdByDetails: userToAuthorDetails(me) }
}

function describePage(page: WikiPage, pages: WikiPage[], lang: string, attachments: WikiAttachmentMeta[]): string {
  const content = localized(page.content, lang)
  const langs = Object.entries(page.content ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([l]) => l)
  const children = pages.filter((p) => p.parentId === page.id).sort((a, b) => a.sortOrder - b.sortOrder)
  const lines = [
    `# ${localized(page.title, lang) || '(untitled)'}`,
    `page_id: ${page.id} · path: ${breadcrumbs(pages, page.id, lang).join(' / ')} · parent_id: ${page.parentId ?? '(top level)'}`,
    `languages with content: ${langs.join(', ') || '(none)'}${page.icon ? ` · icon: ${page.icon}` : ''}`
      + `${page.verified ? ` · verified${page.verifiedAt ? ` ${page.verifiedAt}` : ''}` : ''}${page.owner ? ` · owner: ${page.owner}` : ''}`
      + `${page.reviewDueAt ? ` · review due ${page.reviewDueAt}` : ''} · updated ${page.updatedAt}`,
  ]
  if (children.length) lines.push(`sub-pages: ${children.map((c) => `${localized(c.title, lang)} (${c.id})`).join(', ')}`)
  if (attachments.length) {
    lines.push(`attachments (referenced in the Markdown as attachments/<file name>): ${attachments.map((a) => a.fileName).join(', ')}`)
  }
  lines.push('', '--- content (Markdown) ---', content ? clip(content, MAX_CONTENT) : '(empty)')
  return lines.join('\n')
}

function describeCatalog(c: DataCatalog, dbName: string): string {
  return [
    `${loc(c.name)} — catalog_id: ${c.id}${c.entityId ? ` (${c.entityId})` : ''} · version ${c.version ?? '0.1.0'}`,
    ...(loc(c.description) ? [`Description: ${loc(c.description)}`] : []),
    `Database: ${dbName} (database_id: ${c.dataSourceId || '(none)'})`,
    describeCatalogStatus(c),
    ...describeCatalogConfig(c),
    `README: ${c.readme && Object.values(c.readme).some((v) => v?.trim()) ? 'yes (get_readme)' : 'none'}`
      + ` · DCAT-AP metadata: ${c.dcatApMetadata && Object.keys(c.dcatApMetadata).length ? 'filled' : 'empty'}`,
  ].join('\n')
}

/** The portable pointer the app stamps next to a database id (survives export/import). */
const pointerTo = (all: DataSource[], id: string) =>
  buildPointer(all.map((d) => ({ id: d.id, name: d.name, lineageId: d.lineageId ?? undefined, entityId: d.entityId ?? undefined })), id)

/** Clearing a field takes an explicit null: the API reads a missing key as "no change". */
const clearedRunState = { lastError: null, lastComputedAt: null, lastComputeDurationMs: null, computedPeriods: null }

export function registerWikiTools(server: Server): void {
  // --- Wiki ------------------------------------------------------------------

  server.registerTool('list_wiki_pages', {
    description:
      'The workspace wiki: a tree of Markdown pages (procedures, data dictionaries, onboarding notes…) shared by '
      + 'everyone in a Linkr workspace. Lists every page as an indented tree with its page_id and the languages it has content in.',
    annotations: READ,
    inputSchema: fromJsonSchema<Scope>({ type: 'object', properties: SCOPE_PROPS }),
  }, guard(async (args) => {
    const ws = await workspaceOf(args)
    const pages = await wiki.list(ws)
    if (pages.length === 0) return text(`The wiki of workspace ${ws} is empty.`)
    return text(`Wiki of workspace ${ws} — ${pages.length} page(s):\n${renderWikiTree(pages)}`)
  }))

  server.registerTool('search_wiki_pages', {
    description: 'Search the workspace wiki\'s titles and contents (case-insensitive substring). Returns page ids with a snippet.',
    annotations: READ,
    inputSchema: fromJsonSchema<Scope & { query: string }>({
      type: 'object', properties: { ...SCOPE_PROPS, query: { type: 'string' } }, required: ['query'],
    }),
  }, guard(async ({ query, ...scope }) => {
    const ws = await workspaceOf(scope)
    const hits = await wiki.search(ws, query)
    if (hits.length === 0) return text(`No wiki page matches "${query}".`)
    return text(hits.slice(0, 50).map((h) => `- ${loc(h.title) || '(untitled)'} — page_id: ${h.id}\n  ${h.snippet}`).join('\n')
      + (hits.length > 50 ? `\n… ${hits.length - 50} more.` : ''))
  }))

  server.registerTool('get_wiki_page', {
    description:
      'Read one wiki page: its place in the tree, metadata, attachments, and its content as Markdown in one language '
      + '(default "en"; falls back to another language when that one is empty).',
    annotations: READ,
    inputSchema: fromJsonSchema<{ page_id: string; language?: string }>({
      type: 'object',
      properties: { page_id: { type: 'string' }, language: { type: 'string', description: 'e.g. "en", "fr".' } },
      required: ['page_id'],
    }),
  }, guard(async ({ page_id, language }) => {
    const page = await wiki.get(page_id).catch(() => null)
    if (!page) return failure(`No wiki page ${page_id} (list_wiki_pages lists them).`)
    const [pages, attachments] = await Promise.all([
      page.workspaceId ? wiki.list(page.workspaceId) : Promise.resolve([page]),
      wiki.attachments(page_id).catch(() => []),
    ])
    return text(describePage(page, pages, language ?? 'en', attachments))
  }))

  server.registerTool('create_wiki_page', {
    description:
      'Add a page to the workspace wiki, at the top level or under a parent page (added last among its siblings). '
      + 'Content is Markdown (GitHub-flavoured: headings, tables, lists, code). Title and content are written in `language` (default "en").',
    annotations: WRITE,
    inputSchema: fromJsonSchema<Scope & {
      title: string; content?: string; parent_id?: string; icon?: string; language?: string; entity_id?: string
    }>({
      type: 'object',
      properties: {
        ...SCOPE_PROPS,
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown body.' },
        parent_id: { type: 'string', description: 'The parent page; omit for a top-level page.' },
        icon: { type: 'string', description: 'A lucide-react icon name, e.g. "BookOpen".' },
        language: { type: 'string' },
        entity_id: { type: 'string', description: 'Readable id (a-z, 0-9, "-"), unique in the workspace; derived from the title when omitted.' },
      },
      required: ['title'],
    }),
  }, guard(async ({ title, content, parent_id, icon, language, entity_id, ...scope }) => {
    const lang = language ?? 'en'
    let ws: string | undefined
    if (parent_id) {
      const parent = await wiki.get(parent_id).catch(() => null)
      if (!parent?.workspaceId) return failure(`No wiki page ${parent_id} (list_wiki_pages lists them).`)
      ws = parent.workspaceId
    }
    ws ??= await workspaceOf(scope)
    const pages = await wiki.list(ws)
    const taken = pages.map((p) => p.entityId).filter((e): e is string => !!e)
    if (entity_id && (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(entity_id) || taken.includes(entity_id))) {
      return failure(`entity_id "${entity_id}" is invalid or already used (2–50 chars of a-z, 0-9, "-").`)
    }
    const siblings = pages.filter((p) => (p.parentId ?? null) === (parent_id ?? null))
    const titleL = setLocalized(undefined, lang, title.trim())
    const page = await wiki.create({
      id: randomUUID(),
      entityId: entity_id || uniqueEntityId(slugifyId(title), taken),
      workspaceId: ws,
      parentId: parent_id ?? null,
      title: titleL,
      slug: wikiSlug(localized(titleL, 'en')),
      ...(icon ? { icon } : {}),
      content: content ? setLocalized(undefined, lang, content) : {},
      template: 'blank',
      sortOrder: siblings.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1,
      ...await authored(),
    })
    return text(`Created wiki page "${title}" — page_id: ${page.id}`)
  }))

  server.registerTool('update_wiki_page', {
    description:
      'Change a wiki page: title and/or content in one language (other languages are kept; content REPLACES that '
      + 'language\'s whole Markdown — read it with get_wiki_page first to edit part of it), icon, owner, review date, verified flag.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      page_id: string; title?: string; content?: string; language?: string; icon?: string | null
      owner?: string | null; review_due_at?: string | null; verified?: boolean
    }>({
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string', description: 'The full Markdown body for `language`.' },
        language: { type: 'string', description: 'Default "en".' },
        icon: { type: ['string', 'null'], description: 'A lucide-react icon name; null removes it.' },
        owner: { type: ['string', 'null'], description: 'Who maintains the page (free text).' },
        review_due_at: { type: ['string', 'null'], description: 'ISO date the page should be reviewed by.' },
        verified: { type: 'boolean', description: 'Mark the page as verified (stamps the date) or not.' },
      },
      required: ['page_id'],
    }),
  }, guard(async ({ page_id, title, content, language, icon, owner, review_due_at, verified }) => {
    const lang = language ?? 'en'
    const page = await wiki.get(page_id).catch(() => null)
    if (!page) return failure(`No wiki page ${page_id} (list_wiki_pages lists them).`)
    const changes: Record<string, unknown> = {}
    if (title !== undefined) {
      changes.title = setLocalized(page.title, lang, title.trim())
      changes.slug = wikiSlug(localized(changes.title as LocalizedString, 'en'))
    }
    if (content !== undefined) changes.content = setLocalized(page.content, lang, content)
    if (icon !== undefined) changes.icon = icon
    if (owner !== undefined) changes.owner = owner
    if (review_due_at !== undefined) changes.reviewDueAt = review_due_at
    if (verified !== undefined) {
      changes.verified = verified
      changes.verifiedAt = verified ? new Date().toISOString() : null
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    await wiki.update(page_id, changes)
    return text(`Updated wiki page ${page_id}: ${Object.keys(changes).filter((k) => k !== 'slug').join(', ')}.`)
  }))

  server.registerTool('move_wiki_page', {
    description:
      'Move a wiki page (with its sub-pages) under another parent, or to the top level, at a position among its new siblings.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ page_id: string; parent_id: string | null; position?: number }>({
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        parent_id: { type: ['string', 'null'], description: 'New parent page; null for the top level.' },
        position: { type: 'number', description: '0-based position among the new siblings; last when omitted.' },
      },
      required: ['page_id', 'parent_id'],
    }),
  }, guard(async ({ page_id, parent_id, position }) => {
    const page = await wiki.get(page_id).catch(() => null)
    if (!page?.workspaceId) return failure(`No wiki page ${page_id} (list_wiki_pages lists them).`)
    const pages = await wiki.list(page.workspaceId)
    const plan = planMove(pages, page_id, parent_id, position)
    if ('error' in plan) return failure(plan.error)
    for (const u of plan.updates) {
      const { id, ...changes } = u
      await wiki.update(id, changes)
    }
    return text(`Moved: ${breadcrumbs(pages.map((p) => (p.id === page_id ? { ...p, parentId: parent_id } : p)), page_id).join(' / ')}.`)
  }))

  server.registerTool('delete_wiki_page', {
    description: 'Delete a wiki page AND all its sub-pages, with their attachments. Irreversible — ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ page_id: string }>({
      type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'],
    }),
  }, guard(async ({ page_id }) => {
    const page = await wiki.get(page_id).catch(() => null)
    if (!page) return failure(`No wiki page ${page_id} (list_wiki_pages lists them).`)
    const pages = page.workspaceId ? await wiki.list(page.workspaceId) : [page]
    const ids = subtreeIds(pages, page_id)
    for (const id of ids) {
      await wiki.deleteAttachments(id)
      await wiki.delete(id)
    }
    return text(`Deleted "${localized(page.title, 'en')}"${ids.length > 1 ? ` and ${ids.length - 1} sub-page(s)` : ''}.`)
  }))

  // --- Data catalogs ---------------------------------------------------------

  server.registerTool('list_data_catalogs', {
    description:
      'Data catalogs of a workspace (or of every workspace you can read when no scope is given). A data catalog '
      + 'publishes anonymized aggregate counts of one database — patients, visits and records per concept, per '
      + 'demographic dimension and per period, counts below a threshold masked — with DCAT-AP metadata, so others can '
      + 'see what the database holds without seeing patient rows.',
    annotations: READ,
    inputSchema: fromJsonSchema<Scope>({ type: 'object', properties: SCOPE_PROPS }),
  }, guard(async (args) => {
    const ws = args.workspace_id || args.project_uid ? await workspaceOf(args) : undefined
    const list = await catalogs.list(ws)
    if (list.length === 0) return text('No data catalog.')
    return text(list.map((c) => `- ${loc(c.name)} — catalog_id: ${c.id} · workspace ${c.workspaceId} · database ${c.dataSourceId || '(none)'} · ${describeCatalogStatus(c)}`).join('\n'))
  }))

  server.registerTool('get_data_catalog', {
    description:
      'A data catalog\'s configuration (database, dimensions, anonymization threshold, concept category columns, '
      + 'period table) and computation status. With `options`, also the values each setting can take on its database '
      + '(classification columns, category values, service labels), read with small aggregate queries.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ catalog_id: string; options?: boolean }>({
      type: 'object',
      properties: { catalog_id: { type: 'string' }, options: { type: 'boolean' } },
      required: ['catalog_id'],
    }),
  }, guard(async ({ catalog_id, options }) => {
    const c = await catalogs.get(catalog_id).catch(() => null)
    if (!c) return failure(`No data catalog ${catalog_id} (list_data_catalogs lists them).`)
    const ds = c.dataSourceId ? await api.getDataSource(c.dataSourceId).catch(() => null) : null
    const out = [describeCatalog(c, ds ? loc(ds.name) : '(not found)')]
    if (options && ds?.schemaMapping) {
      const mapping = ds.schemaMapping
      out.push(`Age bracket presets: ${Object.entries(AGE_BRACKET_PRESETS).map(([k, v]) => `${k} [${v.join(', ')}]`).join(' · ')}`)
      out.push(`Classification columns: ${catalogClassColumns(mapping).join(', ') || '(none)'}`)
      if (c.categoryColumn) {
        const sql = buildCategoryLabelsQuery(mapping, c.categoryColumn)
        const values = sql ? (await api.query(ds.id, sql).catch(() => [])).map((r) => String(r.cat_label)).filter(Boolean) : []
        out.push(`Values of ${c.categoryColumn}: ${values.slice(0, 100).join(', ') || '(none)'}`)
      }
      const svc = buildServiceLabelsQuery(mapping, 'visit_detail')
      const labels = svc ? (await api.query(ds.id, svc).catch(() => [])).map((r) => String(r.svc_label)).filter(Boolean) : []
      out.push(`Service labels (unit level): ${labels.slice(0, 100).join(', ') || '(none)'}${labels.length > 100 ? ` … ${labels.length - 100} more` : ''}`)
    }
    return text(out.join('\n'))
  }))

  server.registerTool('create_data_catalog', {
    description:
      'Create a data catalog on a database of the workspace, with the app\'s defaults (age groups by 10 years, sex, '
      + 'admission month; monthly period table; counts below 10 masked). Configure it with update_data_catalog, '
      + 'then compute it with compute_data_catalog.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<Scope & { name: string; database_id: string; description?: string; language?: string; entity_id?: string }>({
      type: 'object',
      properties: {
        ...SCOPE_PROPS,
        name: { type: 'string' },
        database_id: { type: 'string', description: 'The database to describe (describe_database / get_project_context).' },
        description: { type: 'string' },
        language: { type: 'string', description: 'Language of name and description, default "en".' },
        entity_id: { type: 'string', description: 'Readable id, unique in the workspace; derived from the name when omitted.' },
      },
      required: ['name', 'database_id'],
    }),
  }, guard(async ({ name, database_id, description, language, entity_id, ...scope }) => {
    const lang = language ?? 'en'
    const all = await api.listDataSources()
    const ds = all.find((d) => d.id === database_id)
    if (!ds) return failure(`No database ${database_id} you can read.`)
    const ws = scope.workspace_id || scope.project_uid ? await workspaceOf(scope) : ds.workspaceId
    if (!ws) return failure('Give workspace_id or project_uid.')
    const existing = await catalogs.list(ws)
    const taken = existing.map((c) => c.entityId).filter((e): e is string => !!e)
    if (entity_id && taken.includes(entity_id)) return failure(`entity_id "${entity_id}" is already used in this workspace.`)
    const now = new Date().toISOString()
    const catalog = await catalogs.create({
      id: randomUUID(),
      entityId: entity_id || uniqueEntityId(slugifyId(name), taken),
      workspaceId: ws,
      name: setLocalized(undefined, lang, name.trim()),
      description: setLocalized(undefined, lang, (description ?? '').trim()),
      dataSourceId: ds.id,
      ...(pointerTo(all, ds.id) ? { dataSourceRef: pointerTo(all, ds.id) } : {}),
      badges: [],
      dimensions: getDefaultDimensions(),
      periodConfig: { granularity: 'month', serviceLevel: 'visit_detail' },
      anonymization: { threshold: 10, mode: 'replace' },
      status: 'draft',
      version: '0.1.0',
      ...await authored(),
      lineageId: randomUUID(),
      createdAt: now,
    })
    return text(`Created data catalog "${name}" — catalog_id: ${catalog.id}\n${describeCatalogConfig(catalog).join('\n')}`)
  }))

  server.registerTool('update_data_catalog', {
    description:
      'Change a data catalog: name, description, database, version, and what it counts — dimensions (sex, age groups '
      + 'with their brackets, care site), anonymization threshold, the concept category / subcategory columns, and the '
      + 'period table (null turns it off). Results computed before a change are stale: recompute with compute_data_catalog restart.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<CatalogChanges & {
      catalog_id: string; name?: string; description?: string; language?: string; database_id?: string; version?: string
    }>({
      type: 'object',
      properties: {
        catalog_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        language: { type: 'string', description: 'Language of name/description, default "en".' },
        database_id: { type: 'string' },
        version: { type: 'string', description: 'Semantic version, e.g. "0.2.0".' },
        sex_enabled: { type: 'boolean' },
        age_group_enabled: { type: 'boolean' },
        age_brackets: {
          description: `Lower bounds of the age groups (e.g. [18, 65, 80]), or a preset: ${Object.keys(AGE_BRACKET_PRESETS).join(', ')}.`,
          anyOf: [{ type: 'array', items: { type: 'number' } }, { type: 'string' }],
        },
        care_site_enabled: { type: 'boolean' },
        care_site_level: { type: 'string', enum: ['visit', 'visit_detail'] },
        period: {
          description: 'The period table; null turns it off.',
          anyOf: [{ type: 'null' }, {
            type: 'object',
            properties: {
              granularity: { type: 'string', enum: ['month', 'quarter', 'year'] },
              service_labels: { type: ['array', 'null'], items: { type: 'string' }, description: 'Limit to these services; null or [] for all.' },
              concept_categories: { type: 'array', items: { type: 'string' }, description: 'Values of the category column counted per period.' },
            },
          }],
        },
        anonymization_threshold: { type: 'number', description: 'Counts below it are masked. Whole number ≥ 1.' },
        anonymization_mode: { type: 'string', enum: ['replace', 'suppress'] },
        category_column: { type: ['string', 'null'], description: 'get_data_catalog with options lists the columns.' },
        subcategory_column: { type: ['string', 'null'] },
      },
      required: ['catalog_id'],
    }),
  }, guard(async ({ catalog_id, name, description, language, database_id, version, ...changes }) => {
    const lang = language ?? 'en'
    const c = await catalogs.get(catalog_id).catch(() => null)
    if (!c) return failure(`No data catalog ${catalog_id} (list_data_catalogs lists them).`)
    const dbId = database_id ?? c.dataSourceId
    const all = await api.listDataSources()
    const ds = all.find((d) => d.id === dbId)
    if (database_id && !ds) return failure(`No database ${database_id} you can read.`)
    const planned = catalogPatch(c, changes, catalogClassColumns(ds?.schemaMapping))
    if ('error' in planned) return failure(planned.error)
    const patch = planned.patch
    if (name !== undefined) patch.name = setLocalized(c.name, lang, name.trim())
    if (description !== undefined) patch.description = setLocalized(c.description, lang, description.trim())
    if (version !== undefined) patch.version = version.trim() || '0.1.0'
    if (database_id !== undefined && database_id !== c.dataSourceId) {
      patch.dataSourceId = database_id
      patch.dataSourceRef = pointerTo(all, database_id) ?? null
    }
    if (Object.keys(patch).length === 0) return failure('Nothing to change.')
    const updated = await catalogs.update(catalog_id, patch)
    return text(`Updated (${Object.keys(patch).join(', ')}).\n${describeCatalogConfig(updated).join('\n')}`)
  }))

  server.registerTool('delete_data_catalog', {
    description: 'Delete a data catalog and its computed results. Irreversible — ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ catalog_id: string }>({
      type: 'object', properties: { catalog_id: { type: 'string' } }, required: ['catalog_id'],
    }),
  }, guard(async ({ catalog_id }) => {
    const c = await catalogs.get(catalog_id).catch(() => null)
    if (!c) return failure(`No data catalog ${catalog_id} (list_data_catalogs lists them).`)
    await catalogs.deleteResults(catalog_id).catch(() => {})
    await catalogs.delete(catalog_id)
    return text(`Deleted data catalog "${loc(c.name)}".`)
  }))

  server.registerTool('compute_data_catalog', {
    description:
      'Compute a data catalog the way the app does: aggregate queries on its database (concept counts, dimension '
      + 'counts, then the period table one period at a time), results stored on the server and shared with every user. '
      + 'Resumable: it works for up to `time_budget_seconds` then stops at a save point — call again to resume. '
      + 'An already computed catalog is recomputed only with restart: true. Only aggregate counts are produced.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ catalog_id: string; restart?: boolean; time_budget_seconds?: number; force?: boolean }>({
      type: 'object',
      properties: {
        catalog_id: { type: 'string' },
        restart: { type: 'boolean', description: 'Discard previous or partial results and start over.' },
        time_budget_seconds: { type: 'number', description: 'Default 50, max 600. The concept pass always completes.' },
        force: { type: 'boolean', description: 'Run even if the catalog looks like it is being computed in Linkr right now.' },
      },
      required: ['catalog_id'],
    }),
  }, guard(async ({ catalog_id, restart, time_budget_seconds, force }) => {
    const catalog = await catalogs.get(catalog_id).catch(() => null)
    if (!catalog) return failure(`No data catalog ${catalog_id} (list_data_catalogs lists them).`)
    const paused = catalog.computedPeriods != null
    if (!restart && !paused && catalog.status === 'success') {
      return text(`Already computed (${catalog.lastComputedAt}). Read it with get_data_catalog_results, or pass restart: true to recompute.`)
    }
    const sinceUpdate = Date.now() - new Date(catalog.updatedAt).getTime()
    if (!force && catalog.status === 'computing' && sinceUpdate < 120_000) {
      return failure(`The catalog was being computed ${Math.round(sinceUpdate / 1000)} s ago, probably in an open Linkr tab: two runs would interleave their writes. Wait, or pass force: true.`)
    }
    const ds = await api.getDataSource(catalog.dataSourceId).catch(() => null)
    if (!ds?.schemaMapping) return failure(`The catalog's database ${catalog.dataSourceId || '(none)'} is missing or has no schema mapping.`)
    const mapping = ds.schemaMapping
    const query = (sql: string) => api.query(ds.id, sql)
    const deadline = Date.now() + Math.min(Math.max(time_budget_seconds ?? 50, 5), 600) * 1000
    const startedAt = Date.now()

    const stored = restart ? null : await catalogs.getResults(catalog_id)
    if (restart) await catalogs.update(catalog_id, { computedPeriods: null })
    const resume = stored && paused ? { cache: stored, computed: catalog.computedPeriods! } : null

    const persist = async (cache: CatalogResultCache, done: boolean) => {
      await catalogs.saveResults(cache)
      await catalogs.update(catalog_id, {
        status: done ? 'success' : 'computing',
        lastError: null,
        lastComputedAt: cache.computedAt,
        lastComputeDurationMs: cache.durationMs,
        computedPeriods: done ? null : cache.periods?.length ?? 0,
      })
    }

    try {
      let cache = resume?.cache ?? await computeCatalogBase(catalog, mapping, query)
      let offset = resume?.computed ?? 0
      const plan = catalog.periodConfig ? await computePeriodBatch.plan(catalog, mapping, query) : null
      const total = plan?.intervals.length ?? 0
      const periods = [...(cache.periods ?? [])]
      if (periods.length < offset) offset = periods.length
      while (plan && offset < total) {
        const batch = await computePeriodBatch.run(plan, offset, Math.min(24, total - offset), query)
        if (batch.length === 0) break
        periods.push(...batch)
        offset += batch.length
        cache = { ...cache, periods, ...computePeriodBatch.summarize(periods) }
        await persist(cache, offset >= total)
        if (Date.now() > deadline && offset < total) {
          return text(`Paused at ${offset}/${total} period rows (time budget reached); progress is saved. Call compute_data_catalog again to resume.`)
        }
      }
      cache = {
        ...cache,
        periods: plan ? periods : undefined,
        ...(plan ? computePeriodBatch.summarize(periods) : {}),
        durationMs: Date.now() - startedAt,
        computedAt: new Date().toISOString(),
      }
      await persist(cache, true)
      return text(`Computed in ${Math.round((Date.now() - startedAt) / 1000)} s.\n${renderCatalogResults(cache, catalog.anonymization.threshold, 'summary')}`)
    } catch (e) {
      const message = (e as Error).message
      await catalogs.update(catalog_id, { status: 'error', lastError: message }).catch(() => {})
      return failure(`Computation failed: ${message}`)
    }
  }))

  server.registerTool('get_data_catalog_results', {
    description:
      'A computed data catalog\'s results, counts below the anonymization threshold shown masked ("< 10"). '
      + 'view: summary (totals, concepts per category, top concepts), concepts (filter by search / category), '
      + 'dimensions (counts per sex, age group, admission month, care site), periods (the period table).',
    annotations: READ,
    inputSchema: fromJsonSchema<{ catalog_id: string; view?: ResultsView; search?: string; category?: string; limit?: number }>({
      type: 'object',
      properties: {
        catalog_id: { type: 'string' },
        view: { type: 'string', enum: ['summary', 'concepts', 'dimensions', 'periods'] },
        search: { type: 'string', description: 'concepts view: name or id substring.' },
        category: { type: 'string', description: 'concepts view: one category value.' },
        limit: { type: 'number', description: 'Rows to show, default 50, max 500.' },
      },
      required: ['catalog_id'],
    }),
  }, guard(async ({ catalog_id, view, search, category, limit }) => {
    const c = await catalogs.get(catalog_id).catch(() => null)
    if (!c) return failure(`No data catalog ${catalog_id} (list_data_catalogs lists them).`)
    const cache = await catalogs.getResults(catalog_id)
    if (!cache) return text(`Not computed yet (${describeCatalogStatus(c)}). Run compute_data_catalog.`)
    const note = c.computedPeriods != null ? `\n(Partial: computation paused after ${c.computedPeriods} period rows.)` : ''
    return text(renderCatalogResults(cache, c.anonymization.threshold, view ?? 'summary', {
      search, category, limit: Math.min(Math.max(limit ?? 50, 1), 500),
    }) + note)
  }))

  server.registerTool('reset_data_catalog_results', {
    description: 'Discard a data catalog\'s computed (or partially computed) results for every user, back to draft. Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ catalog_id: string }>({
      type: 'object', properties: { catalog_id: { type: 'string' } }, required: ['catalog_id'],
    }),
  }, guard(async ({ catalog_id }) => {
    const c = await catalogs.get(catalog_id).catch(() => null)
    if (!c) return failure(`No data catalog ${catalog_id} (list_data_catalogs lists them).`)
    await catalogs.deleteResults(catalog_id).catch(() => {})
    await catalogs.update(catalog_id, { status: 'draft', ...clearedRunState })
    return text(`Results of "${loc(c.name)}" discarded; the catalog is back to draft.`)
  }))

  // --- READMEs ---------------------------------------------------------------

  const ownerEnum = Object.keys(README_OWNERS) as ReadmeOwner[]
  const ownerDoc = ownerEnum.map((k) => `${k} = ${README_OWNERS[k].what}`).join('; ')

  server.registerTool('get_readme', {
    description:
      'Read the Markdown README of a workspace entity — the documentation shown on its page and exported with it. '
      + `entity_type: ${ownerDoc}. (A project\'s README is read with get_project_context.)`,
    annotations: READ,
    inputSchema: fromJsonSchema<{ entity_type: ReadmeOwner; entity_id: string; language?: string }>({
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ownerEnum },
        entity_id: { type: 'string', description: 'The entity\'s id (uuid), as the list tools return it.' },
        language: { type: 'string', description: 'Default "en".' },
      },
      required: ['entity_type', 'entity_id'],
    }),
  }, guard(async ({ entity_type, entity_id, language }) => {
    const owner = README_OWNERS[entity_type]
    if (!owner) return failure(`Unknown entity_type. One of: ${ownerEnum.join(', ')}.`)
    const entity = await api.request<{ name?: LocalizedString | string; readme?: LocalizedString | string | null }>(
      'GET', `${owner.path}/${encodeURIComponent(entity_id)}`)
    const { text: body, languages } = readmeIn(entity.readme, language ?? 'en')
    const attachments = await api.request<ReadmeAttachmentMeta[]>(
      'GET', `/readme-attachments?ownerType=${owner.ownerType}&ownerId=${encodeURIComponent(entity_id)}`).catch(() => [])
    return text([
      `README of ${entity_type} "${loc(entity.name as LocalizedString)}" — languages: ${languages.join(', ') || '(none)'}`,
      ...(attachments.length ? [`attachments (referenced as attachments/<file name>): ${attachments.map((a) => a.fileName).join(', ')}`] : []),
      '', body ? clip(body, MAX_CONTENT) : '(empty)',
    ].join('\n'))
  }))

  server.registerTool('set_readme', {
    description:
      'Write the Markdown README of a workspace entity in one language (other languages kept). REPLACES that '
      + `language\'s whole README — read it with get_readme first to edit part of it. entity_type: ${ownerDoc}.`,
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ entity_type: ReadmeOwner; entity_id: string; content: string; language?: string }>({
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ownerEnum },
        entity_id: { type: 'string' },
        content: { type: 'string', description: 'The full Markdown README.' },
        language: { type: 'string', description: 'Default "en".' },
      },
      required: ['entity_type', 'entity_id', 'content'],
    }),
  }, guard(async ({ entity_type, entity_id, content, language }) => {
    const owner = README_OWNERS[entity_type]
    if (!owner) return failure(`Unknown entity_type. One of: ${ownerEnum.join(', ')}.`)
    const path = `${owner.path}/${encodeURIComponent(entity_id)}`
    const entity = await api.request<{ readme?: LocalizedString | string | null }>('GET', path)
    await api.request<unknown>('PATCH', path, { readme: withReadme(entity.readme, language ?? 'en', content) })
    return text(`README of ${entity_type} ${entity_id} saved (${language ?? 'en'}, ${content.length} characters).`)
  }))
}
