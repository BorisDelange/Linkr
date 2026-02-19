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
import type { DataSource, StoredFile, DatabaseConnectionConfig, Dashboard, DashboardTab, DashboardWidget, SchemaMapping, SchemaPresetId, MappingProject, DqRuleSet, ConceptMapping } from '@/types'

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
  if (localStorage.getItem(SEED_KEY_VOCAB)) return

  try {
    const storage = getStorage()
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
      name: 'OMOP Vocabulary (MIMIC-IV Demo)',
      description: 'Bundled OMOP vocabulary reference — 3 249 concepts from MIMIC-IV Demo OMOP. Use as vocabulary reference in concept mapping.',
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

    localStorage.setItem(SEED_KEY_VOCAB, '1')
    console.info('[demo-seed] OMOP vocabulary reference seeded successfully')
  } catch (err) {
    console.error('[demo-seed] Failed to seed OMOP vocabulary:', err)
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
// Demo Concept Mappings (MIMIC-IV source → OMOP standard concepts)
// ---------------------------------------------------------------------------

const SEED_KEY_CONCEPT_MAPPINGS = 'linkr-demo-concept-mappings-seeded'

/** Compact mapping row from mimic-iv-concept-mappings.json */
interface CompactMapping {
  sn: string; si: number; sv: string; sd: string; sc: string
  ti: number; tn: string; tv: string; td: string; tc: string
}

/**
 * Seed 1 064 concept mappings from OHDSI's MIMIC-IV custom mapping CSVs.
 *
 * Fetches a compact JSON file produced from the 21 custom_mapping_csv files
 * in the mimic-iv-demo-omop repository (Apache 2.0 / OHDSI).
 * Only mappings whose target concept exists in our bundled OMOP vocabulary
 * are included.
 *
 * Must run after seedDemoMappingProject().
 */
export async function seedDemoConceptMappings(): Promise<void> {
  if (localStorage.getItem(SEED_KEY_CONCEPT_MAPPINGS)) return

  try {
    const storage = getStorage()
    const now = new Date().toISOString()

    const res = await fetch('/data/mimic-iv-concept-mappings.json')
    if (!res.ok) throw new Error(`Failed to fetch concept mappings: ${res.status}`)
    const raw: CompactMapping[] = await res.json()

    const mappings: ConceptMapping[] = raw.map((m, i) => ({
      id: `demo-mapping-${String(i).padStart(4, '0')}`,
      projectId: DEMO_MAPPING_PROJECT_ID,
      sourceConceptId: m.si,
      sourceConceptName: m.sn,
      sourceVocabularyId: m.sv,
      sourceDomainId: m.sd,
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

    localStorage.setItem(SEED_KEY_CONCEPT_MAPPINGS, '1')
    console.info(`[demo-seed] ${mappings.length} concept mappings seeded successfully`)
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
    const now = new Date().toISOString()

    const dashboardId = 'dashboard-demo-1'
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
