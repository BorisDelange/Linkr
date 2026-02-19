import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Upload, Check, Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEtlStore } from '@/stores/etl-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import * as engine from '@/lib/duckdb/engine'
import type { ConceptMapping } from '@/types'

interface Props {
  pipelineId: string
}

/**
 * Convert approved ConceptMapping objects into INSERT statements
 * for the OMOP source_to_concept_map table.
 */
function buildInsertSql(mappings: ConceptMapping[]): string {
  if (mappings.length === 0) return ''

  const rows = mappings.map((m) => {
    const sourceCode = m.sourceConceptCode.replace(/'/g, "''")
    const sourceDesc = m.sourceConceptName.replace(/'/g, "''")
    const targetVocab = m.targetVocabularyId.replace(/'/g, "''")
    const sourceVocab = m.sourceVocabularyId.replace(/'/g, "''")
    return `('${sourceCode}', ${m.sourceConceptId}, '${sourceVocab}', '${sourceDesc}', ${m.targetConceptId}, '${targetVocab}', DATE '1970-01-01', DATE '2099-12-31', NULL)`
  })

  // DuckDB supports multi-row VALUES
  return `INSERT INTO source_to_concept_map (source_code, source_concept_id, source_vocabulary_id, source_code_description, target_concept_id, target_vocabulary_id, valid_start_date, valid_end_date, invalid_reason)\nVALUES\n${rows.join(',\n')};\n`
}

/**
 * Parse a CSV string into rows matching source_to_concept_map columns.
 */
function parseCsv(csv: string): ConceptMapping[] {
  const lines = csv.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase())
  const sourceCodeIdx = header.indexOf('source_code')
  const sourceConceptIdIdx = header.indexOf('source_concept_id')
  const sourceVocabIdx = header.indexOf('source_vocabulary_id')
  const sourceDescIdx = header.indexOf('source_code_description')
  const targetConceptIdIdx = header.indexOf('target_concept_id')
  const targetVocabIdx = header.indexOf('target_vocabulary_id')

  if (sourceCodeIdx < 0 || targetConceptIdIdx < 0) return []

  return lines.slice(1).map((line, i) => {
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    return {
      id: `csv-import-${i}`,
      projectId: '',
      sourceConceptId: Number(cols[sourceConceptIdIdx]) || 0,
      sourceConceptName: cols[sourceDescIdx] ?? '',
      sourceVocabularyId: cols[sourceVocabIdx] ?? '',
      sourceDomainId: '',
      sourceConceptCode: cols[sourceCodeIdx] ?? '',
      targetConceptId: Number(cols[targetConceptIdIdx]) || 0,
      targetConceptName: '',
      targetVocabularyId: cols[targetVocabIdx] ?? '',
      targetDomainId: '',
      targetConceptCode: '',
      mappingType: 'maps_to' as const,
      equivalence: 'skos:exactMatch' as const,
      status: 'approved' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  })
}

export function EtlVocabularyTab({ pipelineId }: Props) {
  const { t } = useTranslation()
  const { etlPipelines } = useEtlStore()
  const { mappingProjects, mappingProjectsLoaded, loadMappingProjects, loadProjectMappings } = useConceptMappingStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)
  const targetDsId = pipeline?.targetDataSourceId

  // Ensure mapping projects are loaded
  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ success: boolean; count: number; error?: string } | null>(null)

  // Get mapping projects for this workspace
  const workspaceId = pipeline?.workspaceId
  const availableProjects = mappingProjects.filter((p) => !workspaceId || p.workspaceId === workspaceId)

  const handleImportFromProject = useCallback(async () => {
    if (!selectedProjectId || !targetDsId) return
    setImporting(true)
    setImportResult(null)

    try {
      // Load mappings for the selected project
      await loadProjectMappings(selectedProjectId)
      const projectMappings = useConceptMappingStore.getState().mappings
        .filter((m) => m.projectId === selectedProjectId && m.status === 'approved')

      if (projectMappings.length === 0) {
        setImportResult({ success: false, count: 0, error: t('etl.vocab_no_approved_mappings') })
        return
      }

      // Clear existing rows and insert new ones
      await engine.queryDataSource(targetDsId, 'DELETE FROM source_to_concept_map;')
      const insertSql = buildInsertSql(projectMappings)
      if (insertSql) {
        await engine.queryDataSource(targetDsId, insertSql)
      }

      setImportResult({ success: true, count: projectMappings.length })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setImportResult({ success: false, count: 0, error: msg })
    } finally {
      setImporting(false)
    }
  }, [selectedProjectId, targetDsId, loadProjectMappings, t])

  const handleImportFromFile = useCallback(async () => {
    if (!targetDsId) return

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return

      setImporting(true)
      setImportResult(null)

      try {
        const text = await file.text()
        const parsed = parseCsv(text)

        if (parsed.length === 0) {
          setImportResult({ success: false, count: 0, error: t('etl.vocab_invalid_csv') })
          return
        }

        // Create table if not exists
        const createSql = `CREATE TABLE IF NOT EXISTS source_to_concept_map (
  source_code VARCHAR(50) NOT NULL,
  source_concept_id INTEGER NOT NULL,
  source_vocabulary_id VARCHAR(20) NOT NULL,
  source_code_description VARCHAR(255),
  target_concept_id INTEGER NOT NULL,
  target_vocabulary_id VARCHAR(20) NOT NULL,
  valid_start_date DATE NOT NULL,
  valid_end_date DATE NOT NULL,
  invalid_reason VARCHAR(1)
);`
        await engine.queryDataSource(targetDsId, createSql)
        await engine.queryDataSource(targetDsId, 'DELETE FROM source_to_concept_map;')

        const insertSql = buildInsertSql(parsed)
        if (insertSql) {
          await engine.queryDataSource(targetDsId, insertSql)
        }

        setImportResult({ success: true, count: parsed.length })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setImportResult({ success: false, count: 0, error: msg })
      } finally {
        setImporting(false)
      }
    }
    input.click()
  }, [targetDsId, t])

  const targetDs = targetDsId ? dataSources.find((ds) => ds.id === targetDsId) : null

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 overflow-auto p-8">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <BookOpen size={32} className="mx-auto mb-2 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t('etl.vocab_title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('etl.vocab_description')}
          </p>
        </div>

        {!targetDsId && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-center text-xs text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950 dark:text-yellow-200">
            {t('etl.vocab_no_target')}
          </div>
        )}

        {targetDs && (
          <div className="rounded-md border bg-muted/30 p-3 text-center text-xs">
            {t('etl.vocab_target_db')}: <span className="font-medium">{targetDs.name}</span>
            {targetDs.alias && (
              <span className="ml-1 font-mono text-muted-foreground">
                (ds_{targetDs.alias})
              </span>
            )}
          </div>
        )}

        {/* Option 1: Import from mapping project */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">{t('etl.vocab_from_project')}</Label>
          <div className="flex gap-2">
            <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
              <SelectTrigger className="flex-1 text-xs">
                <SelectValue placeholder={t('etl.vocab_select_project')} />
              </SelectTrigger>
              <SelectContent>
                {availableProjects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={handleImportFromProject}
              disabled={!selectedProjectId || !targetDsId || importing}
            >
              {importing ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {t('etl.vocab_import')}
            </Button>
          </div>
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[10px] uppercase text-muted-foreground">{t('etl.vocab_or')}</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        {/* Option 2: Import from CSV file */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">{t('etl.vocab_from_file')}</Label>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleImportFromFile}
            disabled={!targetDsId || importing}
          >
            <Upload size={14} />
            {t('etl.vocab_upload_csv')}
          </Button>
          <p className="text-[10px] text-muted-foreground">{t('etl.vocab_csv_hint')}</p>
        </div>

        {/* Result */}
        {importResult && (
          <div className={`rounded-md border p-3 text-xs ${
            importResult.success
              ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200'
              : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200'
          }`}>
            {importResult.success ? (
              <span className="flex items-center gap-1.5">
                <Check size={14} />
                {t('etl.vocab_import_success', { count: importResult.count })}
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <AlertCircle size={14} />
                {importResult.error || t('etl.vocab_import_error')}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
