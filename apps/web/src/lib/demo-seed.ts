/**
 * Auto-seed the MIMIC-IV Demo OMOP database on first launch.
 *
 * Fetches Parquet files from public/data/mimic-iv-demo-omop/,
 * stores them in IndexedDB, creates a DataSource, mounts it in DuckDB,
 * and links it to the demo project.
 */

import { getStorage } from '@/lib/storage'
import * as engine from '@/lib/duckdb/engine'
import { getSchemaPreset } from '@/lib/schema-presets'
import { getDefaultDimensions } from '@/types/catalog'
import type { DataSource, StoredFile, DatabaseConnectionConfig, Dashboard, DashboardTab, DashboardWidget, SchemaMapping, SchemaPresetId, MappingProject, DqRuleSet, ConceptMapping, EtlPipeline, EtlFile, DataCatalog } from '@/types'

const SEED_KEY = 'linkr-demo-db-seeded'
const DEMO_DASHBOARD_SEED_KEY = 'linkr-demo-dashboard-seeded'
const DEMO_PROJECT_UID = '00000000-0000-0000-0000-000000000001'
const DEMO_DATASOURCE_ID = '00000000-0000-0000-0000-000000000002'

const PARQUET_BASE = '/data/mimic-iv-demo-omop'

const PARQUET_FILES = [
  'care_site',
  'concept',
  'concept_ancestor',
  'concept_class',
  'concept_relationship',
  'concept_synonym',
  'condition_era',
  'condition_occurrence',
  'cost',
  'death',
  'device_exposure',
  'domain',
  'dose_era',
  'drug_era',
  'drug_exposure',
  'drug_strength',
  'fact_relationship',
  'location',
  'measurement',
  'note',
  'observation',
  'observation_period',
  'payer_plan_period',
  'person',
  'procedure_occurrence',
  'provider',
  'relationship',
  'specimen',
  'visit_detail',
  'visit_occurrence',
  'vocabulary',
]

export async function seedDemoDatabase(): Promise<void> {
  if (localStorage.getItem(SEED_KEY)) return

  try {
    const storage = getStorage()

    // Check if the datasource already exists in IndexedDB (guard against localStorage/IDB desync)
    const existing = await storage.dataSources.getById(DEMO_DATASOURCE_ID)
    if (existing) {
      localStorage.setItem(SEED_KEY, '1')
      console.info('[demo-seed] MIMIC-IV demo database already exists, skipping seed')
      return
    }

    const now = new Date().toISOString()

    // Fetch all parquet files in parallel
    const fetched = await Promise.all(
      PARQUET_FILES.map(async (name) => {
        const res = await fetch(`${PARQUET_BASE}/${name}.parquet`)
        if (!res.ok) throw new Error(`Failed to fetch ${name}.parquet: ${res.status}`)
        const data = await res.arrayBuffer()
        return { name, data }
      }),
    )

    // Store files in IndexedDB
    const storedFiles: StoredFile[] = []
    for (const { name, data } of fetched) {
      const stored: StoredFile = {
        id: crypto.randomUUID(),
        dataSourceId: DEMO_DATASOURCE_ID,
        fileName: `${name}.parquet`,
        fileSize: data.byteLength,
        data,
        createdAt: now,
      }
      storedFiles.push(stored)
      await storage.files.create(stored)
    }

    // Create DataSource record
    const schemaMapping = getSchemaPreset('omop-5.4')
    const connectionConfig: DatabaseConnectionConfig = {
      engine: 'duckdb',
      fileIds: storedFiles.map((f) => f.id),
      fileNames: storedFiles.map((f) => f.fileName),
    }

    const dataSource: DataSource = {
      id: DEMO_DATASOURCE_ID,
      alias: 'mimic_iv_omop',
      name: 'MIMIC-IV Demo (OMOP)',
      description: 'Bundled demo dataset — 100 patients from MIMIC-IV in OMOP CDM format.',
      sourceType: 'database',
      connectionConfig,
      schemaMapping,
      status: 'configuring',
      createdAt: now,
      updatedAt: now,
    }

    await storage.dataSources.create(dataSource)

    // Mount in DuckDB and compute stats
    await engine.mountDataSource(dataSource, storedFiles)
    const stats = await engine.computeStats(DEMO_DATASOURCE_ID, schemaMapping)

    await storage.dataSources.update(DEMO_DATASOURCE_ID, {
      status: 'connected',
      stats,
    })

    // Link to demo project
    const project = await storage.projects.getById(DEMO_PROJECT_UID)
    if (project) {
      const linkedIds = project.linkedDataSourceIds ?? []
      if (!linkedIds.includes(DEMO_DATASOURCE_ID)) {
        await storage.projects.update(DEMO_PROJECT_UID, {
          linkedDataSourceIds: [...linkedIds, DEMO_DATASOURCE_ID],
        })
      }
    }

    localStorage.setItem(SEED_KEY, '1')
    console.info('[demo-seed] MIMIC-IV demo database seeded successfully')
  } catch (err) {
    console.error('[demo-seed] Failed to seed demo database:', err)
    // Don't set the flag — will retry on next launch
  }
}

// ---------------------------------------------------------------------------
// MIMIC-IV raw (non-OMOP) demo database
// ---------------------------------------------------------------------------

const SEED_KEY_RAW = 'linkr-demo-mimic-iv-seeded'
const DEMO_RAW_DATASOURCE_ID = '00000000-0000-0000-0000-000000000003'
const PARQUET_BASE_RAW = '/data/mimic-iv-demo'

const PARQUET_FILES_RAW = [
  'admissions',
  'caregiver',
  'chartevents',
  'd_hcpcs',
  'd_icd_diagnoses',
  'd_icd_procedures',
  'd_items',
  'd_labitems',
  'datetimeevents',
  'demo_subject_id',
  'discharge',
  'diagnoses_icd',
  'drgcodes',
  'emar',
  'emar_detail',
  'hcpcsevents',
  'icustays',
  'ingredientevents',
  'inputevents',
  'labevents',
  'microbiologyevents',
  'omr',
  'outputevents',
  'patients',
  'pharmacy',
  'poe',
  'poe_detail',
  'prescriptions',
  'procedureevents',
  'procedures_icd',
  'provider',
  'services',
  'transfers',
]

export async function seedMimicIVRawDatabase(): Promise<void> {
  if (localStorage.getItem(SEED_KEY_RAW)) return

  try {
    const storage = getStorage()

    // Check if the datasource already exists in IndexedDB (guard against localStorage/IDB desync)
    const existing = await storage.dataSources.getById(DEMO_RAW_DATASOURCE_ID)
    if (existing) {
      localStorage.setItem(SEED_KEY_RAW, '1')
      console.info('[demo-seed] MIMIC-IV raw demo database already exists, skipping seed')
      return
    }

    const now = new Date().toISOString()

    // Fetch all parquet files in parallel
    const fetched = await Promise.all(
      PARQUET_FILES_RAW.map(async (name) => {
        const res = await fetch(`${PARQUET_BASE_RAW}/${name}.parquet`)
        if (!res.ok) throw new Error(`Failed to fetch ${name}.parquet: ${res.status}`)
        const data = await res.arrayBuffer()
        return { name, data }
      }),
    )

    // Store files in IndexedDB
    const storedFiles: StoredFile[] = []
    for (const { name, data } of fetched) {
      const stored: StoredFile = {
        id: crypto.randomUUID(),
        dataSourceId: DEMO_RAW_DATASOURCE_ID,
        fileName: `${name}.parquet`,
        fileSize: data.byteLength,
        data,
        createdAt: now,
      }
      storedFiles.push(stored)
      await storage.files.create(stored)
    }

    // Create DataSource record
    const schemaMapping = getSchemaPreset('mimic-iv')
    const connectionConfig: DatabaseConnectionConfig = {
      engine: 'duckdb',
      fileIds: storedFiles.map((f) => f.id),
      fileNames: storedFiles.map((f) => f.fileName),
    }

    const dataSource: DataSource = {
      id: DEMO_RAW_DATASOURCE_ID,
      alias: 'mimic_iv_raw',
      name: 'MIMIC-IV Demo',
      description: 'Bundled demo dataset — 100 patients from MIMIC-IV v2.2 in native format.',
      sourceType: 'database',
      connectionConfig,
      schemaMapping,
      status: 'configuring',
      createdAt: now,
      updatedAt: now,
    }

    await storage.dataSources.create(dataSource)

    // Mount in DuckDB and compute stats
    await engine.mountDataSource(dataSource, storedFiles)
    const stats = await engine.computeStats(DEMO_RAW_DATASOURCE_ID, schemaMapping)

    await storage.dataSources.update(DEMO_RAW_DATASOURCE_ID, {
      status: 'connected',
      stats,
    })

    // Link to demo project
    const project = await storage.projects.getById(DEMO_PROJECT_UID)
    if (project) {
      const linkedIds = project.linkedDataSourceIds ?? []
      if (!linkedIds.includes(DEMO_RAW_DATASOURCE_ID)) {
        await storage.projects.update(DEMO_PROJECT_UID, {
          linkedDataSourceIds: [...linkedIds, DEMO_RAW_DATASOURCE_ID],
        })
      }
    }

    localStorage.setItem(SEED_KEY_RAW, '1')
    console.info('[demo-seed] MIMIC-IV raw demo database seeded successfully')
  } catch (err) {
    console.error('[demo-seed] Failed to seed MIMIC-IV raw demo database:', err)
  }
}

// ---------------------------------------------------------------------------
// OMOP Vocabulary reference (standalone, for concept mapping)
// ---------------------------------------------------------------------------

const SEED_KEY_VOCAB = 'linkr-demo-omop-vocab-seeded'
/** Bump this version whenever omop-vocabulary Parquet files are updated to force re-seed. */
const VOCAB_VERSION = 2
const DEMO_VOCAB_DATASOURCE_ID = '00000000-0000-0000-0000-000000000004'
const PARQUET_BASE_VOCAB = '/data/omop-vocabulary'

const PARQUET_FILES_VOCAB = [
  'concept',
  'concept_ancestor',
  'concept_class',
  'concept_relationship',
  'concept_synonym',
  'domain',
  'drug_strength',
  'relationship',
  'vocabulary',
]

/** ATHENA vocabulary schema mapping — must match ConceptSetsTab.tsx */
const ATHENA_SCHEMA_MAPPING: SchemaMapping = {
  presetId: 'omop-cdm-5.4' as SchemaPresetId,
  presetLabel: 'ATHENA Vocabulary',
  conceptTables: [{
    key: 'concept',
    table: 'concept',
    idColumn: 'concept_id',
    nameColumn: 'concept_name',
    codeColumn: 'concept_code',
    vocabularyColumn: 'vocabulary_id',
    extraColumns: {
      domain_id: 'domain_id',
      concept_class_id: 'concept_class_id',
      standard_concept: 'standard_concept',
    },
  }],
  knownTables: PARQUET_FILES_VOCAB,
}

/**
 * Seed a bundled OMOP vocabulary reference for concept mapping.
 *
 * Creates a DataSource with `isVocabularyReference: true` from the
 * Parquet files in public/data/omop-vocabulary/. This vocabulary
 * contains ~3 249 standard OMOP concepts (subset used by MIMIC-IV Demo)
 * and can be used as the vocabulary reference in any MappingProject.
 */
export async function seedOmopVocabulary(): Promise<void> {
  const seededVersion = Number(localStorage.getItem(SEED_KEY_VOCAB) || '0')
  if (seededVersion >= VOCAB_VERSION) return

  try {
    const storage = getStorage()

    // Remove old vocabulary data source if upgrading from a previous version
    if (seededVersion > 0) {
      try {
        await engine.unmountDataSource(DEMO_VOCAB_DATASOURCE_ID)
      } catch { /* may not be mounted */ }
      await storage.files.deleteByDataSource(DEMO_VOCAB_DATASOURCE_ID)
      await storage.databaseStatsCache.delete(DEMO_VOCAB_DATASOURCE_ID)
      await storage.dataSources.delete(DEMO_VOCAB_DATASOURCE_ID)
      console.info(`[demo-seed] Removed old OMOP vocabulary (v${seededVersion} → v${VOCAB_VERSION})`)
    } else {
      // First-time guard: skip if datasource already exists in IndexedDB (localStorage/IDB desync)
      const existing = await storage.dataSources.getById(DEMO_VOCAB_DATASOURCE_ID)
      if (existing) {
        localStorage.setItem(SEED_KEY_VOCAB, String(VOCAB_VERSION))
        console.info('[demo-seed] OMOP vocabulary already exists, skipping seed')
        return
      }
    }

    const now = new Date().toISOString()

    // Fetch all parquet files in parallel
    const fetched = await Promise.all(
      PARQUET_FILES_VOCAB.map(async (name) => {
        const res = await fetch(`${PARQUET_BASE_VOCAB}/${name}.parquet`)
        if (!res.ok) throw new Error(`Failed to fetch ${name}.parquet: ${res.status}`)
        const data = await res.arrayBuffer()
        return { name, data }
      }),
    )

    // Store files in IndexedDB
    const storedFiles: StoredFile[] = []
    for (const { name, data } of fetched) {
      const stored: StoredFile = {
        id: crypto.randomUUID(),
        dataSourceId: DEMO_VOCAB_DATASOURCE_ID,
        fileName: `${name}.parquet`,
        fileSize: data.byteLength,
        data,
        createdAt: now,
      }
      storedFiles.push(stored)
      await storage.files.create(stored)
    }

    // Create DataSource record
    const connectionConfig: DatabaseConnectionConfig = {
      engine: 'duckdb',
      fileIds: storedFiles.map((f) => f.id),
      fileNames: storedFiles.map((f) => f.fileName),
    }

    const dataSource: DataSource = {
      id: DEMO_VOCAB_DATASOURCE_ID,
      alias: 'omop_vocab',
      name: 'OMOP Vocabulary (MIMIC-IV Demo)',
      description: 'Bundled OMOP vocabulary reference — 6 234 concepts from ATHENA. Use as vocabulary reference in concept mapping.',
      sourceType: 'database',
      connectionConfig,
      schemaMapping: ATHENA_SCHEMA_MAPPING,
      isVocabularyReference: true,
      status: 'configuring',
      createdAt: now,
      updatedAt: now,
    }

    await storage.dataSources.create(dataSource)

    // Mount in DuckDB and compute stats
    await engine.mountDataSource(dataSource, storedFiles)
    const stats = await engine.computeStats(DEMO_VOCAB_DATASOURCE_ID, ATHENA_SCHEMA_MAPPING)

    await storage.dataSources.update(DEMO_VOCAB_DATASOURCE_ID, {
      status: 'connected',
      stats,
    })

    localStorage.setItem(SEED_KEY_VOCAB, String(VOCAB_VERSION))
    console.info('[demo-seed] OMOP vocabulary reference seeded successfully')
  } catch (err) {
    console.error('[demo-seed] Failed to seed OMOP vocabulary:', err)
  }
}

// ---------------------------------------------------------------------------
// Empty OMOP ETL target database (no data, just schema)
// ---------------------------------------------------------------------------

const SEED_KEY_ETL_DB = 'linkr-demo-etl-db-seeded'
const DEMO_ETL_DATASOURCE_ID = '00000000-0000-0000-0000-000000000009'

/**
 * Seed an empty OMOP CDM database to serve as the ETL target.
 *
 * Creates a DataSource with the OMOP 5.4 schema preset but no data files.
 * The ETL pipeline will populate this database when run.
 */
export async function seedEtlTargetDatabase(): Promise<void> {
  const storage = getStorage()

  // Check if the datasource already exists in IndexedDB (guard against localStorage/IDB desync)
  const existing = await storage.dataSources.getById(DEMO_ETL_DATASOURCE_ID)
  if (existing) {
    // Also set the localStorage flag if it was missing
    if (!localStorage.getItem(SEED_KEY_ETL_DB)) {
      localStorage.setItem(SEED_KEY_ETL_DB, '1')
    }
    console.info('[demo-seed] ETL target database already exists, skipping seed')
    return
  }

  // Check if already flagged as seeded but DB doesn't exist (shouldn't happen with above check)
  if (localStorage.getItem(SEED_KEY_ETL_DB)) {
    // Clear the flag since the DB doesn't exist
    localStorage.removeItem(SEED_KEY_ETL_DB)
  }

  const now = new Date().toISOString()
  const baseMapping = getSchemaPreset('omop-5.4')!

  try {
    const schemaMapping: SchemaMapping = {
      ...baseMapping,
    }
    const connectionConfig: DatabaseConnectionConfig = {
      engine: 'duckdb',
      fileIds: [],
      fileNames: [],
      inMemory: true,
    }

    const dataSource: DataSource = {
      id: DEMO_ETL_DATASOURCE_ID,
      alias: 'mimic_iv_etl',
      name: 'MIMIC-IV ETL (OMOP)',
      description: 'Empty OMOP CDM 5.4 target database for the MIMIC-IV ETL pipeline. Will be populated when the ETL is run.',
      sourceType: 'database',
      connectionConfig,
      schemaMapping,
      status: 'connected',
      createdAt: now,
      updatedAt: now,
    }

    await storage.dataSources.create(dataSource)

    // Create the DuckDB schema with full OMOP DDL tables
    await engine.mountEmptyFromDDL(DEMO_ETL_DATASOURCE_ID, schemaMapping.ddl!, 'mimic_iv_etl')

    localStorage.setItem(SEED_KEY_ETL_DB, '1')
    console.info('[demo-seed] ETL target database seeded successfully')
  } catch (err) {
    console.error('[demo-seed] Failed to seed ETL target database:', err)
  }
}

// ---------------------------------------------------------------------------
// Demo Concept Mapping project (MIMIC-IV source → OMOP)
// ---------------------------------------------------------------------------

const SEED_KEY_MAPPING = 'linkr-demo-mapping-project-seeded'
const DEMO_MAPPING_PROJECT_ID = '00000000-0000-0000-0000-000000000005'
const DEMO_WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'

/**
 * Seed a demo concept mapping project: MIMIC-IV (source) → OMOP,
 * with the bundled vocabulary reference already linked.
 *
 * Must run after seedMimicIVRawDatabase() and seedOmopVocabulary().
 */
export async function seedDemoMappingProject(): Promise<void> {
  if (localStorage.getItem(SEED_KEY_MAPPING)) return

  try {
    const storage = getStorage()

    // Check if the project already exists in IndexedDB (guard against localStorage/IDB desync)
    const existing = await storage.mappingProjects.getById(DEMO_MAPPING_PROJECT_ID)
    if (existing) {
      localStorage.setItem(SEED_KEY_MAPPING, '1')
      console.info('[demo-seed] Demo mapping project already exists, skipping seed')
      return
    }

    const now = new Date().toISOString()

    const project: MappingProject = {
      id: DEMO_MAPPING_PROJECT_ID,
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'MIMIC-IV → OMOP CDM',
      description: 'Concept mapping from MIMIC-IV native source data to OMOP CDM standard concepts using the bundled OMOP vocabulary.',
      dataSourceId: DEMO_RAW_DATASOURCE_ID,
      vocabularyDataSourceId: DEMO_VOCAB_DATASOURCE_ID,
      conceptSetIds: [],
      createdAt: now,
      updatedAt: now,
    }

    await storage.mappingProjects.create(project)

    localStorage.setItem(SEED_KEY_MAPPING, '1')
    console.info('[demo-seed] Demo concept mapping project seeded successfully')
  } catch (err) {
    console.error('[demo-seed] Failed to seed demo mapping project:', err)
  }
}

// ---------------------------------------------------------------------------
// Demo Data Quality rule set for MIMIC-IV Demo (source, non-OMOP)
// ---------------------------------------------------------------------------

const SEED_KEY_DQ = 'linkr-demo-dq-ruleset-seeded'
const DEMO_DQ_RULESET_ID = '00000000-0000-0000-0000-000000000006'

/**
 * Seed a data quality rule set for the MIMIC-IV Demo (source) database.
 *
 * Must run after seedMimicIVRawDatabase().
 */
export async function seedDemoDqRuleSet(): Promise<void> {
  if (localStorage.getItem(SEED_KEY_DQ)) return

  try {
    const storage = getStorage()

    // Check if the rule set already exists in IndexedDB (guard against localStorage/IDB desync)
    const existing = await storage.dqRuleSets.getById(DEMO_DQ_RULESET_ID)
    if (existing) {
      localStorage.setItem(SEED_KEY_DQ, '1')
      console.info('[demo-seed] Demo DQ rule set already exists, skipping seed')
      return
    }

    const now = new Date().toISOString()

    const ruleSet: DqRuleSet = {
      id: DEMO_DQ_RULESET_ID,
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'MIMIC-IV Demo — Data Quality',
      description: 'Built-in and schema-aware quality checks for the MIMIC-IV Demo source dataset (100 patients, native format).',
      dataSourceId: DEMO_RAW_DATASOURCE_ID,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    }

    await storage.dqRuleSets.create(ruleSet)

    localStorage.setItem(SEED_KEY_DQ, '1')
    console.info('[demo-seed] Demo DQ rule set seeded successfully')
  } catch (err) {
    console.error('[demo-seed] Failed to seed demo DQ rule set:', err)
  }
}

// ---------------------------------------------------------------------------
// Demo ETL Pipeline (MIMIC-IV source → OMOP CDM)
// ---------------------------------------------------------------------------

const SEED_KEY_ETL = 'linkr-demo-etl-pipeline-seeded'
const DEMO_ETL_PIPELINE_ID = '00000000-0000-0000-0000-000000000007'

/**
 * Seed a demo ETL pipeline: MIMIC-IV (source) → MIMIC-IV Demo (OMOP).
 *
 * Creates an EtlPipeline record linking the raw MIMIC-IV source database
 * to the OMOP target. ETL scripts can be added later via the ETL editor.
 *
 * Must run after seedDemoDatabase() and seedMimicIVRawDatabase().
 */
export async function seedDemoEtlPipeline(): Promise<void> {
  if (localStorage.getItem(SEED_KEY_ETL)) return

  try {
    const storage = getStorage()

    // Check if the pipeline already exists in IndexedDB (guard against localStorage/IDB desync)
    const existing = await storage.etlPipelines.getById(DEMO_ETL_PIPELINE_ID)
    if (existing) {
      localStorage.setItem(SEED_KEY_ETL, '1')
      console.info('[demo-seed] Demo ETL pipeline already exists, skipping seed')
      return
    }

    const now = new Date().toISOString()

    const pipeline: EtlPipeline = {
      id: DEMO_ETL_PIPELINE_ID,
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'MIMIC-IV → OMOP CDM',
      description: 'ETL pipeline transforming MIMIC-IV native source data into OMOP CDM 5.4 format. Based on OHDSI mimic-iv-demo-omop ETL scripts (Apache 2.0).',
      sourceDataSourceId: DEMO_RAW_DATASOURCE_ID,
      targetDataSourceId: DEMO_ETL_DATASOURCE_ID,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }

    await storage.etlPipelines.create(pipeline)

    localStorage.setItem(SEED_KEY_ETL, '1')
    console.info('[demo-seed] Demo ETL pipeline seeded successfully')
  } catch (err) {
    console.error('[demo-seed] Failed to seed demo ETL pipeline:', err)
  }
}

// ---------------------------------------------------------------------------
// Demo ETL Files (15 DuckDB SQL scripts adapted from OHDSI mimic-iv-demo-omop)
// ---------------------------------------------------------------------------

const SEED_KEY_ETL_FILES = 'linkr-demo-etl-files-seeded'

/** Row from mimic-iv-etl-scripts.json */
interface EtlScriptRow {
  folder: string
  name: string
  order: number
  content: string
}

/**
 * Seed 17 ETL SQL scripts as EtlFile records in the demo ETL pipeline.
 *
 * Each script runs against the ETL target database (search_path = target schema)
 * and uses fully qualified names to read from the source and vocabulary schemas.
 * Adapted from OHDSI mimic-iv-demo-omop BigQuery scripts (Apache 2.0).
 *
 * Must run after seedDemoEtlPipeline().
 */
export async function seedDemoEtlFiles(): Promise<void> {
  if (localStorage.getItem(SEED_KEY_ETL_FILES)) return

  try {
    const storage = getStorage()

    // Check if ETL files already exist in IndexedDB (guard against localStorage/IDB desync)
    const existingFiles = await storage.etlFiles.getByPipeline(DEMO_ETL_PIPELINE_ID)
    if (existingFiles.length > 0) {
      localStorage.setItem(SEED_KEY_ETL_FILES, '1')
      console.info('[demo-seed] Demo ETL files already exist, skipping seed')
      return
    }

    const now = new Date().toISOString()

    const res = await fetch('/data/mimic-iv-etl-scripts.json')
    if (!res.ok) throw new Error(`Failed to fetch ETL scripts: ${res.status}`)
    const scripts: EtlScriptRow[] = await res.json()

    for (const script of scripts) {
      const file: EtlFile = {
        id: `demo-etl-${script.name.replace('.sql', '')}`,
        pipelineId: DEMO_ETL_PIPELINE_ID,
        name: script.name,
        type: 'file',
        parentId: null,
        content: script.content,
        language: 'sql',
        order: script.order,
        dataSourceId: DEMO_ETL_DATASOURCE_ID,
        createdAt: now,
      }
      await storage.etlFiles.create(file)
    }

    localStorage.setItem(SEED_KEY_ETL_FILES, '1')
    console.info(`[demo-seed] ${scripts.length} ETL scripts seeded successfully`)
  } catch (err) {
    console.error('[demo-seed] Failed to seed ETL files:', err)
  }
}

// ---------------------------------------------------------------------------
// Demo Concept Mappings (MIMIC-IV source → OMOP standard concepts)
// ---------------------------------------------------------------------------

const SEED_KEY_CONCEPT_MAPPINGS = 'linkr-demo-concept-mappings-seeded'
/** Bump this version whenever mimic-iv-concept-mappings.json is updated to force re-seed. */
const CONCEPT_MAPPINGS_VERSION = 3

/** Compact mapping row from mimic-iv-concept-mappings.json */
interface CompactMapping {
  sn: string; sc: string; sv: string
  ti: number; tn: string; tv: string; td: string; tc: string
}

/**
 * Seed 1 786 concept mappings from OHDSI's MIMIC-IV custom mapping CSVs.
 *
 * Only includes mappings whose source concept (itemid) exists in the bundled
 * MIMIC-IV Demo d_items or d_labitems tables. The sv field contains the source
 * table name (d_items or d_labitems) used as sourceVocabularyId for STCM generation.
 *
 * Must run after seedDemoMappingProject().
 */
export async function seedDemoConceptMappings(): Promise<void> {
  const seededVersion = Number(localStorage.getItem(SEED_KEY_CONCEPT_MAPPINGS) || '0')
  if (seededVersion >= CONCEPT_MAPPINGS_VERSION) return

  try {
    const storage = getStorage()

    // Delete old mappings if upgrading from a previous version
    if (seededVersion > 0) {
      const old = await storage.conceptMappings.getByProject(DEMO_MAPPING_PROJECT_ID)
      if (old.length > 0) {
        await Promise.all(old.map((m) => storage.conceptMappings.delete(m.id)))
        console.info(`[demo-seed] Removed ${old.length} old concept mappings (v${seededVersion} → v${CONCEPT_MAPPINGS_VERSION})`)
      }
    } else {
      // First-time guard: skip if mappings already exist in IndexedDB (localStorage/IDB desync)
      const existingMappings = await storage.conceptMappings.getByProject(DEMO_MAPPING_PROJECT_ID)
      if (existingMappings.length > 0) {
        localStorage.setItem(SEED_KEY_CONCEPT_MAPPINGS, String(CONCEPT_MAPPINGS_VERSION))
        console.info('[demo-seed] Demo concept mappings already exist, skipping seed')
        return
      }
    }

    const now = new Date().toISOString()

    const res = await fetch('/data/mimic-iv-concept-mappings.json')
    if (!res.ok) throw new Error(`Failed to fetch concept mappings: ${res.status}`)
    const raw: CompactMapping[] = await res.json()

    const mappings: ConceptMapping[] = raw.map((m, i) => ({
      id: `demo-mapping-${String(i).padStart(4, '0')}`,
      projectId: DEMO_MAPPING_PROJECT_ID,
      sourceConceptId: Number(m.sc),
      sourceConceptName: m.sn,
      sourceVocabularyId: m.sv,
      sourceDomainId: '',
      sourceConceptCode: m.sc,
      targetConceptId: m.ti,
      targetConceptName: m.tn,
      targetVocabularyId: m.tv,
      targetDomainId: m.td,
      targetConceptCode: m.tc,
      mappingType: 'maps_to' as const,
      equivalence: 'skos:exactMatch' as const,
      status: 'approved' as const,
      mappedBy: 'OHDSI ETL',
      mappedOn: now,
      createdAt: now,
      updatedAt: now,
    }))

    await storage.conceptMappings.createBatch(mappings)

    localStorage.setItem(SEED_KEY_CONCEPT_MAPPINGS, String(CONCEPT_MAPPINGS_VERSION))
    console.info(`[demo-seed] ${mappings.length} concept mappings seeded successfully (v${CONCEPT_MAPPINGS_VERSION})`)
  } catch (err) {
    console.error('[demo-seed] Failed to seed concept mappings:', err)
  }
}

/**
 * Seed a demo dashboard for the demo project on first launch.
 * Uses legacy builtin widgets (hardcoded mock data) since the demo
 * project has OMOP warehouse data, not Lab datasets.
 */
export async function seedDemoDashboard(): Promise<void> {
  if (localStorage.getItem(DEMO_DASHBOARD_SEED_KEY)) return

  try {
    const storage = getStorage()

    const dashboardId = 'dashboard-demo-1'

    // Check if the dashboard already exists in IndexedDB (guard against localStorage/IDB desync)
    const existing = await storage.dashboards.getById(dashboardId)
    if (existing) {
      localStorage.setItem(DEMO_DASHBOARD_SEED_KEY, '1')
      console.info('[demo-seed] Demo dashboard already exists, skipping seed')
      return
    }

    const now = new Date().toISOString()
    const tabId = 'dtab-demo-1'

    const dashboard: Dashboard = {
      id: dashboardId,
      projectUid: DEMO_PROJECT_UID,
      name: 'Overview',
      datasetFileId: null,
      filterConfig: [],
      createdAt: now,
      updatedAt: now,
    }

    const tab: DashboardTab = {
      id: tabId,
      dashboardId,
      name: 'Main',
      displayOrder: 0,
    }

    const widgets: DashboardWidget[] = []

    await storage.dashboards.create(dashboard)
    await storage.dashboardTabs.create(tab)
    for (const w of widgets) {
      await storage.dashboardWidgets.create(w)
    }

    localStorage.setItem(DEMO_DASHBOARD_SEED_KEY, '1')
    console.info('[demo-seed] Demo dashboard seeded successfully')
  } catch (err) {
    console.error('[demo-seed] Failed to seed demo dashboard:', err)
  }
}

// ---------------------------------------------------------------------------
// Demo Data Catalog (MIMIC-IV Demo)
// ---------------------------------------------------------------------------

const SEED_KEY_CATALOG = 'linkr-demo-catalog-seeded'
const DEMO_CATALOG_ID = '00000000-0000-0000-0000-000000000008'

/**
 * Seed a default data catalog for the MIMIC-IV Demo database.
 *
 * Creates a DataCatalog with default dimensions (age group + sex enabled),
 * and pre-filled Health-DCAT-AP metadata.
 * The catalog is in 'draft' status — the user must click "Compute" to populate results.
 *
 * Must run after seedMimicIVRawDatabase().
 */
export async function seedDemoCatalog(): Promise<void> {
  if (localStorage.getItem(SEED_KEY_CATALOG)) return

  try {
    const storage = getStorage()

    // Check if the catalog already exists in IndexedDB (guard against localStorage/IDB desync)
    const existing = await storage.dataCatalogs.getById(DEMO_CATALOG_ID)
    if (existing) {
      localStorage.setItem(SEED_KEY_CATALOG, '1')
      console.info('[demo-seed] Demo data catalog already exists, skipping seed')
      return
    }

    const now = new Date().toISOString()

    const catalog: DataCatalog = {
      id: DEMO_CATALOG_ID,
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'MIMIC-IV Demo',
      description: 'Concept catalog for the MIMIC-IV Demo database (100 patients).',
      dataSourceId: DEMO_RAW_DATASOURCE_ID,
      dimensions: getDefaultDimensions(),
      periodConfig: { granularity: 'year', serviceLevel: 'visit_detail' },
      anonymization: { threshold: 10, mode: 'replace' },
      status: 'draft',
      dcatApMetadata: {
        'catalog.title': 'MIMIC-IV Demo — Concept Catalog',
        'catalog.description': 'Aggregated clinical concepts catalog from the MIMIC-IV Demo database.',
        'dataset.title': 'MIMIC-IV Demo — Concepts Dictionary',
        'dataset.description': 'Aggregated clinical concepts catalog with demographic breakdowns (age, sex). Generated from the MIMIC-IV Demo clinical data warehouse (100 patients).',
        'dataset.identifier': DEMO_CATALOG_ID,
        'dataset.accessRights': 'http://publications.europa.eu/resource/authority/access-right/NON_PUBLIC',
        'dataset.personalData': 'false',
      },
      createdAt: now,
      updatedAt: now,
    }

    await storage.dataCatalogs.create(catalog)

    localStorage.setItem(SEED_KEY_CATALOG, '1')
    console.info('[demo-seed] Demo data catalog seeded successfully')
  } catch (err) {
    console.error('[demo-seed] Failed to seed demo data catalog:', err)
  }
}
