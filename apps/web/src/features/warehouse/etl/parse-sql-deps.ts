import type { EtlFile } from '@/types'

/**
 * Parse SQL files to detect inter-script dependencies.
 *
 * For each file, we detect:
 * - Tables CREATED by the script (via CREATE TABLE / CREATE OR REPLACE TABLE / INSERT INTO)
 * - Tables REFERENCED by the script (via FROM / JOIN clauses)
 *
 * A dependency exists when file B references a table that file A creates.
 * Files that only reference external (source) tables have no inter-script dependencies.
 */

interface ScriptTableInfo {
  fileId: string
  creates: string[]
  references: string[]
}

/**
 * Extract table names created by a SQL script.
 * Handles: CREATE TABLE x, CREATE OR REPLACE TABLE x, CREATE TABLE IF NOT EXISTS x
 */
function extractCreatedTables(sql: string): string[] {
  const tables: string[] = []
  // Remove comments
  const cleaned = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  // CREATE [OR REPLACE] TABLE [IF NOT EXISTS] "tablename" / tablename
  const createRe = /\bCREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_]\w*))/gi
  let match
  while ((match = createRe.exec(cleaned)) !== null) {
    tables.push((match[1] || match[2]).toLowerCase())
  }

  // INSERT INTO "tablename" / tablename (only the table name, not source tables)
  const insertRe = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:"([^"]+)"|([a-zA-Z_]\w*))/gi
  while ((match = insertRe.exec(cleaned)) !== null) {
    const t = (match[1] || match[2]).toLowerCase()
    if (!tables.includes(t)) tables.push(t)
  }

  return tables
}

/**
 * Extract table names referenced by a SQL script (FROM / JOIN).
 * Does not include tables in CREATE TABLE or INSERT INTO target positions.
 */
function extractReferencedTables(sql: string): string[] {
  const tables: string[] = []
  // Remove comments
  const cleaned = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  // FROM "tablename" / tablename — also catches JOIN tablename
  const fromRe = /\b(?:FROM|JOIN)\s+(?:"([^"]+)"|([a-zA-Z_]\w*))/gi
  let match
  while ((match = fromRe.exec(cleaned)) !== null) {
    const t = (match[1] || match[2]).toLowerCase()
    // Skip common SQL keywords that aren't table names
    if (!['select', 'where', 'set', 'values', 'as', 'on', 'and', 'or', 'not', 'null', 'true', 'false'].includes(t)) {
      if (!tables.includes(t)) tables.push(t)
    }
  }

  return tables
}

/**
 * Analyze all ETL files and compute dependencies between scripts.
 *
 * Returns:
 * - `scriptInfo`: per-file analysis (creates, references)
 * - `edges`: dependency edges (fromFileId → toFileId)
 * - `sourceTableReferences`: tables referenced that are not created by any script (= external/source tables)
 */
export function analyzeDependencies(files: EtlFile[]) {
  const sqlFiles = files.filter((f) => f.type === 'file' && f.language === 'sql' && f.content)

  // Analyze each file
  const infos: ScriptTableInfo[] = sqlFiles.map((f) => ({
    fileId: f.id,
    creates: extractCreatedTables(f.content ?? ''),
    references: extractReferencedTables(f.content ?? ''),
  }))

  // Build table → creator file map
  const tableToCreator = new Map<string, string>()
  for (const info of infos) {
    for (const table of info.creates) {
      tableToCreator.set(table, info.fileId)
    }
  }

  // Compute edges: if file B references table T, and file A creates T → A → B
  const edges: { from: string; to: string }[] = []
  const edgeSet = new Set<string>()
  const sourceTableRefs = new Set<string>()

  for (const info of infos) {
    for (const ref of info.references) {
      const creator = tableToCreator.get(ref)
      if (creator && creator !== info.fileId) {
        const key = `${creator}->${info.fileId}`
        if (!edgeSet.has(key)) {
          edgeSet.add(key)
          edges.push({ from: creator, to: info.fileId })
        }
      } else if (!creator) {
        sourceTableRefs.add(ref)
      }
    }
  }

  return {
    scriptInfo: infos,
    edges,
    sourceTableReferences: [...sourceTableRefs],
  }
}
