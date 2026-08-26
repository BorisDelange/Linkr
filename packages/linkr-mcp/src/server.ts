#!/usr/bin/env -S npx tsx
/**
 * `@linkr/mcp` — author Linkr content outside Linkr.
 *
 * A stdio MCP server exposing the format package as tools, so any MCP client
 * (Claude Code, OpenCode, Cursor, Codex…) can write a project tree and have it
 * validated. It contains **no format knowledge**: every tool parses its
 * arguments, calls into `@linkr/format`, and reports what came back. A tool that
 * starts building a JSON shape by hand has broken the layering — see
 * docs/planning/mcp-authoring-plan.md §2.
 *
 * The server writes FILES, not to a running Linkr instance: that is what makes
 * authoring work offline, and it produces exactly the tree shape the
 * linkr-public-content repos already use, so the normal import path reads it
 * with no special-casing.
 *
 * stdout is the JSON-RPC channel — never write to it. Diagnostics go to stderr.
 */
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import {
  MemoryTree, detectTreeKind, formatIssues, manifestList, serializeDatabase, serializeEntity, serializeProject,
  validateEntity, validateProject,
  type DatabaseSpec, type ProjectSpec, type SerializableEntityKind,
} from '@linkr/format'
import { FsTree } from '@linkr/format/node/fs-tree'
import {
  DEFAULT_GITIGNORE,
  addDashboardTab,
  addScript,
  addWidget,
  copyFiles,
  describeEntitySchema,
  describeTree,
  formatBytes,
  writeTree,
  writeZip,
} from './tools.js'

const server = new McpServer({ name: 'linkr', version: '0.1.0' })

/** Plain-text tool result. */
const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] })

/**
 * Failure the model is meant to read and correct, as opposed to a thrown error,
 * which the protocol reports as a server fault.
 */
const failure = (body: string) => ({ isError: true, content: [{ type: 'text' as const, text: body }] })

const LOCALIZED = {
  type: 'object',
  description: 'Localized text, e.g. {"en": "Overview", "fr": "Vue d\'ensemble"}.',
  properties: { en: { type: 'string' }, fr: { type: 'string' } },
  additionalProperties: { type: 'string' },
}

server.registerTool(
  'validate_entity',
  {
    description:
      'Validate any Linkr entity tree on disk — project, SQL collection, ETL pipeline, '
      + 'schema preset, DQ rule set, data catalog, concept-mapping project or database. '
      + 'The kind is detected from the tree. Reports missing files, broken references, '
      + 'unknown columns and legacy formats. Run this after any change.',
    inputSchema: fromJsonSchema<{ path: string }>({
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the entity directory.' } },
      required: ['path'],
    }),
  },
  async ({ path }) => {
    const tree = new FsTree(path)
    // A project is identified by project.json; the standalone entities each carry
    // their own metadata file, so the caller never has to say which is which.
    const kind = detectTreeKind(tree)
    if (kind == null) {
      return failure(
        `Not a Linkr entity tree: ${path} has no ${manifestList()} at its root.`,
      )
    }

    const issues = kind === 'project' ? validateProject(tree) : validateEntity(tree, kind)
    const errors = issues.filter((i) => i.severity === 'error').length
    const warnings = issues.length - errors
    if (issues.length === 0) return text(`Valid ${kind}: no issues found.`)
    return text(`${kind}: ${errors} error(s), ${warnings} warning(s).\n\n${formatIssues(issues)}`)
  },
)

server.registerTool(
  'write_project',
  {
    description:
      'Create a complete Linkr project tree from a spec: metadata, datasets (from CSV text), '
      + 'dashboards with tabs and widgets, and IDE scripts. Validates what it wrote and reports '
      + 'any issue. Use describe_entity_schema first if unsure about a field.',
    inputSchema: fromJsonSchema<{ path: string; spec: ProjectSpec; format?: 'folder' | 'zip' }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to write the tree into. Created if absent.' },
        spec: {
          type: 'object',
          description: 'The project spec. Call describe_entity_schema("project") for the fields.',
        },
        format: {
          type: 'string',
          enum: ['folder', 'zip'],
          description:
            'folder (default) — git-friendly, what the portal and content repos consume. '
            + 'zip — what the app\'s "Import a project" dialog takes; `path` is then the .zip file.',
        },
      },
      required: ['path', 'spec'],
    }),
  },
  async ({ path, spec, format }) => {
    try {
      const files = serializeProject(spec)
      if (format === 'zip') {
        // Validate the tree before bundling: once zipped there is nothing on
        // disk to point issues at, and a ZIP is usually handed straight to a user.
        const issues = validateProject(new MemoryTree(
          Object.fromEntries(files.map((f) => [f.path, f.content])),
        ))
        if (issues.some((i) => i.severity === 'error')) {
          return failure(`Not written — the spec produces an invalid project:\n${formatIssues(issues)}`)
        }
        const count = await writeZip(path, files)
        return text(`Wrote ${count} file(s) into ${path}. Valid.`)
      }

      const written = writeTree(path, [...files, { path: '.gitignore', content: DEFAULT_GITIGNORE }])
      const issues = validateProject(new FsTree(path))
      const errors = issues.filter((i) => i.severity === 'error').length
      const summary = `Wrote ${written.length} file(s) to ${path}.`
      if (issues.length === 0) return text(`${summary} Valid.`)
      // Report rather than throw: the tree is on disk and the issues say what to fix.
      return text(`${summary}\n\n${errors} error(s):\n${formatIssues(issues)}`)
    } catch (e) {
      return failure(`Could not write the project: ${(e as Error).message}`)
    }
  },
)

server.registerTool(
  'write_entity',
  {
    description:
      'Create a standalone Linkr entity tree — a SQL collection, ETL pipeline, DQ rule set, '
      + 'data catalog, concept-mapping project or database schema preset. These live in their '
      + 'own repo/folder, not inside a project. Validates what it wrote. Call '
      + 'describe_entity_schema(kind) first.',
    inputSchema: fromJsonSchema<{
      path: string
      kind: SerializableEntityKind
      spec: Record<string, unknown>
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to write into. Created if absent.' },
        kind: {
          type: 'string',
          enum: [
            'sql-collection', 'etl-pipeline', 'dq-rule-set', 'data-catalog',
            'mapping-project', 'schema-preset',
          ],
          description: 'Which entity to write.',
        },
        spec: {
          type: 'object',
          description: 'The entity spec. Call describe_entity_schema(kind) for its fields.',
        },
      },
      required: ['path', 'kind', 'spec'],
    }),
  },
  async ({ path, kind, spec }) => {
    try {
      const files = serializeEntity(kind, spec as never)
      const written = writeTree(path, files)
      const issues = validateEntity(new FsTree(path), kind)
      const errors = issues.filter((i) => i.severity === 'error').length
      const summary = `Wrote ${written.length} file(s) to ${path} (${kind}).`
      if (issues.length === 0) return text(`${summary} Valid.`)
      return text(`${summary}\n\n${errors} error(s):\n${formatIssues(issues)}`)
    } catch (e) {
      return failure(`Could not write the ${kind}: ${(e as Error).message}`)
    }
  },
)

server.registerTool(
  'write_database',
  {
    description:
      'Create a database tree: _database.json + data/<table>.parquet + LFS .gitattributes. '
      + 'The Parquet files are COPIED from paths you give. '
      + 'ONLY for synthetic or public open data (MIMIC-IV demo, generated data) — never '
      + 'from a connected database or a hospital extract. The app itself never exports data; '
      + 'this is allowed because it runs outside that context.',
    inputSchema: fromJsonSchema<{ path: string; spec: DatabaseSpec }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to write into. Created if absent.' },
        spec: {
          type: 'object',
          description: 'The database spec. Call describe_entity_schema("database") for its fields.',
        },
      },
      required: ['path', 'spec'],
    }),
  },
  async ({ path, spec }) => {
    try {
      const { files, copies } = serializeDatabase(spec)
      const written = writeTree(path, files)
      const copied = copyFiles(path, copies)
      const issues = validateEntity(new FsTree(path), 'database')
      const errors = issues.filter((i) => i.severity === 'error').length
      const summary = copied.paths.length > 0
        ? `Wrote ${written.length} file(s) and copied ${copied.paths.length} table(s) `
          + `(${formatBytes(copied.bytes)}) to ${path}.`
        : `Wrote ${written.length} file(s) to ${path} (in-memory database, no data).`
      if (issues.length === 0) return text(`${summary} Valid.`)
      return text(`${summary}\n\n${errors} error(s):\n${formatIssues(issues)}`)
    } catch (e) {
      return failure(`Could not write the database: ${(e as Error).message}`)
    }
  },
)

server.registerTool(
  'describe_tree',
  {
    description:
      'List what a project tree contains — datasets with their column ids, dashboards with their '
      + 'tab and widget keys, scripts. Call this before editing an existing project so you use '
      + 'real ids rather than guessing.',
    inputSchema: fromJsonSchema<{ path: string }>({
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the project directory.' } },
      required: ['path'],
    }),
  },
  async ({ path }) => {
    try {
      return text(describeTree(path))
    } catch (e) {
      return failure(`Could not read the tree: ${(e as Error).message}`)
    }
  },
)

server.registerTool(
  'describe_entity_schema',
  {
    description:
      'Fields of a Linkr entity spec, with their types and an example. Authoritative — it comes '
      + 'from the code, so prefer it over any remembered shape.',
    inputSchema: fromJsonSchema<{ kind: string }>({
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Entity kind.',
          enum: [
            'project', 'dataset', 'dashboard', 'widget', 'tab', 'script',
            'sql-collection', 'etl-pipeline', 'dq-rule-set', 'data-catalog',
            'mapping-project', 'schema-preset', 'database',
          ],
        },
      },
      required: ['kind'],
    }),
  },
  async ({ kind }) => {
    const doc = describeEntitySchema(kind)
    return doc ? text(doc) : failure(`Unknown entity kind "${kind}".`)
  },
)

server.registerTool(
  'add_dashboard_tab',
  {
    description: 'Add a tab to a dashboard in an existing project tree.',
    inputSchema: fromJsonSchema<{
      path: string
      dashboard: string
      name: Record<string, string>
      parent?: string
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        dashboard: { type: 'string', description: 'Dashboard file name, without .json.' },
        name: LOCALIZED,
        parent: { type: 'string', description: 'Parent tab key, to nest one level.' },
      },
      required: ['path', 'dashboard', 'name'],
    }),
  },
  async ({ path, dashboard, name, parent }) => {
    try {
      return text(addDashboardTab(path, dashboard, name, parent))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'add_widget',
  {
    description:
      'Add a widget to a tab in an existing project tree. Column names in the config are resolved '
      + 'to column ids automatically.',
    inputSchema: fromJsonSchema<{
      path: string
      dashboard: string
      tabKey: string
      name: Record<string, string>
      pluginId: string
      dataset?: string
      config?: Record<string, unknown>
      layout: { x: number; y: number; w: number; h: number }
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        dashboard: { type: 'string', description: 'Dashboard file name, without .json.' },
        tabKey: { type: 'string', description: 'Tab key, from describe_tree.' },
        name: LOCALIZED,
        pluginId: { type: 'string', description: 'e.g. linkr-analysis-plot-builder.' },
        dataset: { type: 'string', description: 'Dataset file id, e.g. stays.csv.' },
        config: { type: 'object', description: 'Plugin config. Column NAMES are accepted.' },
        layout: {
          type: 'object',
          description: 'Grid placement. The grid is 48 columns wide (gridV 2).',
          properties: {
            x: { type: 'integer' }, y: { type: 'integer' },
            w: { type: 'integer' }, h: { type: 'integer' },
          },
          required: ['x', 'y', 'w', 'h'],
        },
      },
      required: ['path', 'dashboard', 'tabKey', 'name', 'pluginId', 'layout'],
    }),
  },
  async (args) => {
    try {
      return text(addWidget(args))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'add_script',
  {
    description: 'Add an IDE script (.py/.r/.sql/.md) to an existing project tree.',
    inputSchema: fromJsonSchema<{ path: string; file: string; content: string }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        file: { type: 'string', description: 'Path under scripts/, e.g. 01_extract.sql.' },
        content: { type: 'string', description: 'File contents.' },
      },
      required: ['path', 'file', 'content'],
    }),
  },
  async ({ path, file, content }) => {
    try {
      return text(addScript(path, file, content))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

await server.connect(new StdioServerTransport())
