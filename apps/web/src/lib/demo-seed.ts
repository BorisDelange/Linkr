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
import type { DataSource, StoredFile, DatabaseConnectionConfig, Dashboard, DashboardTab, DashboardWidget } from '@/types'

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
