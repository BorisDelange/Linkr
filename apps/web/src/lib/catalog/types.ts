/**
 * Community catalog — the contract with the `linkr-catalog` index repo.
 *
 * Not to be confused with `@/types/catalog` (`DataCatalog`), the DCAT-AP data catalog:
 * unrelated feature, similar name.
 *
 * Source of truth for these shapes is `schema/entry.schema.json` in the catalog repo;
 * `scripts/build.mjs` there produces the two files read here.
 */

import type { LocalizedString } from '@/types'
import type { GitLinkedEntity } from '@/lib/entity-io'

/**
 * Entity kinds the catalog can list: everything the app can clone, plus `workspace`.
 *
 * Deliberately NOT `GitLinkedEntity['type'] | 'workspace'` as a single union on the
 * clone side: `GitLinkedEntity` describes an entity found INSIDE a workspace, and a
 * workspace is never inside another one. Keeping `workspace` out of that union is what
 * makes the nesting impossible by construction rather than by a runtime guard —
 * `collectGitLinkedEntities` cannot emit it, so the clone loop cannot recurse.
 */
export type CatalogEntryType = GitLinkedEntity['type'] | 'workspace'

/**
 * The entry types, in the order they appear in the type filter. Lives here (not in
 * entry-meta, which pulls in icon components) so pure data code — the remote
 * fetch's type validation — can use it without dragging React into that module.
 */
export const ENTRY_TYPES: CatalogEntryType[] = [
  'workspace',
  'project',
  'mapping-project',
  'sql-collection',
  'etl-pipeline',
  'data-catalog',
  'dq-rule-set',
  'schema-preset',
  'database',
]

/** Maturity signal shown on the card. Absent = a normal, usable entry. */
export type CatalogEntryStatus = 'wip' | 'deprecated' | 'unreachable'

export interface CatalogEntryAuthor {
  name?: string
  orcid?: string
  affiliation?: LocalizedString | string
}

export interface CatalogEntryOrganization {
  /** Stable cross-instance organization UUID, as exported by Linkr. */
  id?: string
  name?: LocalizedString | string
  country?: LocalizedString | string
  website?: string
  /** ROR ID or institutional code. */
  referenceId?: string
}

export interface CatalogEntry {
  id: string
  type: CatalogEntryType
  git: { url: string; branch: string; subdir?: string }
  name: LocalizedString
  description: LocalizedString
  author?: CatalogEntryAuthor
  organization?: CatalogEntryOrganization
  badges?: string[]
  license?: string
  linkrVersion?: string
  status?: CatalogEntryStatus
  homepage?: string
  createdAt?: string
  updatedAt?: string
  /**
   * Cross-instance identity of the published entity, copied from its `lineageId`.
   * How an installed copy is recognized locally — the local PK may differ (a
   * duplicate mints a fresh one), the lineage does not.
   */
  lineageId?: string
  /**
   * Author-declared version ("1.2.0"), shown on the card and compared against the
   * installed copy's own `version` to offer an update. Absent = unversioned: no badge,
   * and an installed copy reads as up to date (there is no second staleness signal —
   * see `installed.ts`).
   */
  version?: string
  /**
   * Download size in bytes, declared by the entry.
   *
   * Most entities are a few kilobytes of JSON and need no warning. A database
   * ships its Parquet — MIMIC-IV demo is 18 MB — and installing that without
   * saying so first is a surprise on a metered or slow connection, so the card
   * shows it and the install dialog repeats it. Absent = not declared, show
   * nothing rather than guess.
   */
  sizeBytes?: number
}

/** `catalog.json` — every entry in full. */
export interface CatalogFile {
  schemaVersion: number
  /** Date of the last commit touching `entries/` in the catalog repo. */
  generatedAt: string
  contentHash: string
  entries: CatalogEntry[]
}

/** `catalog-index.json` — hashes only (~2 KB), polled to detect updates. */
export interface CatalogIndexFile {
  schemaVersion: number
  generatedAt: string
  contentHash: string
  count: number
  /** Per-entry content hash, keyed by entry id. */
  hashes: Record<string, string>
}

/** What the app persists between sessions. */
export interface CatalogCache {
  /** When we last successfully downloaded the full catalog (ISO). */
  fetchedAt: string
  /** `contentHash` of the downloaded catalog — compared against a fresh index. */
  contentHash: string
  generatedAt: string
  entries: CatalogEntry[]
  hashes: Record<string, string>
}

export type CatalogChangeType = 'added' | 'modified' | 'removed'

export interface CatalogChange {
  id: string
  type: CatalogChangeType
}

/** Result of comparing the cached hashes against a freshly fetched index. */
export interface CatalogDiff {
  changed: boolean
  added: string[]
  modified: string[]
  removed: string[]
}
