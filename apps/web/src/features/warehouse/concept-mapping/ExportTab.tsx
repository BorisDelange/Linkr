import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileText, FileSpreadsheet, FileCode, FileJson } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import {
  exportToUsagiCsv,
  exportToSourceToConceptMap,
  exportToSssomTsv,
  exportToJson,
  downloadFile,
} from '@/lib/concept-mapping/export'
import type { MappingProject, MappingStatus } from '@/types'

interface ExportTabProps {
  project: MappingProject
}

type ApprovalRule = 'at_least_one' | 'majority' | 'no_rejections'

const STATUSES: MappingStatus[] = ['approved', 'rejected', 'flagged', 'unchecked', 'invalid', 'ignored']

export function ExportTab({ project }: ExportTabProps) {
  const { t } = useTranslation()
  const { mappings, conceptSets } = useConceptMappingStore()

  // Status checkboxes (approved checked by default)
  const [includedStatuses, setIncludedStatuses] = useState<Set<MappingStatus>>(
    new Set(['approved']),
  )
  const [approvalRule, setApprovalRule] = useState<ApprovalRule>('at_least_one')

  const toggleStatus = (status: MappingStatus) => {
    setIncludedStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  // Count per status
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const m of mappings) {
      counts[m.status] = (counts[m.status] ?? 0) + 1
    }
    return counts
  }, [mappings])

  const filteredMappings = useMemo(() => {
    // First filter: status checkboxes
    let result = mappings.filter((m) => {
      if (m.status === 'approved') {
        // "Approved" checkbox must be on
        if (!includedStatuses.has('approved')) return false
        return true
      }
      return includedStatuses.has(m.status)
    })

    // Then apply approval sub-rule for approved mappings
    if (includedStatuses.has('approved') && approvalRule !== 'at_least_one') {
      // Group all mappings by sourceConceptId to check cross-mapping status
      const sourceConceptStatuses = new Map<number, MappingStatus[]>()
      for (const m of mappings) {
        const arr = sourceConceptStatuses.get(m.sourceConceptId) ?? []
        arr.push(m.status)
        sourceConceptStatuses.set(m.sourceConceptId, arr)
      }

      result = result.filter((m) => {
        if (m.status !== 'approved') return true // only filter approved ones
        const statuses = sourceConceptStatuses.get(m.sourceConceptId) ?? []
        const approvedCount = statuses.filter((s) => s === 'approved').length
        const rejectedCount = statuses.filter((s) => s === 'rejected').length

        if (approvalRule === 'majority') {
          return approvedCount > rejectedCount
        }
        if (approvalRule === 'no_rejections') {
          return rejectedCount === 0
        }
        return true
      })
    }

    return result
  }, [mappings, includedStatuses, approvalRule])

  const linkedSets = useMemo(
    () => conceptSets.filter((cs) => project.conceptSetIds.includes(cs.id)),
    [conceptSets, project.conceptSetIds],
  )

  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  const formats = [
    {
      id: 'usagi',
      icon: FileSpreadsheet,
      name: t('concept_mapping.export_usagi'),
      description: t('concept_mapping.export_usagi_desc'),
      ext: 'csv',
      mime: 'text/csv',
      generate: () => exportToUsagiCsv(filteredMappings),
    },
    {
      id: 'source_to_concept_map',
      icon: FileText,
      name: t('concept_mapping.export_stcm'),
      description: t('concept_mapping.export_stcm_desc'),
      ext: 'csv',
      mime: 'text/csv',
      generate: () => exportToSourceToConceptMap(filteredMappings),
    },
    {
      id: 'sssom',
      icon: FileCode,
      name: t('concept_mapping.export_sssom'),
      description: t('concept_mapping.export_sssom_desc'),
      ext: 'tsv',
      mime: 'text/tab-separated-values',
      generate: () => exportToSssomTsv(filteredMappings, project),
    },
    {
      id: 'json',
      icon: FileJson,
      name: t('concept_mapping.export_json'),
      description: t('concept_mapping.export_json_desc'),
      ext: 'json',
      mime: 'application/json',
      generate: () => exportToJson(filteredMappings, project, linkedSets),
    },
  ]

  const handleDownload = (format: (typeof formats)[number]) => {
    const content = format.generate()
    const filename = `${slug}-${format.id}.${format.ext}`
    downloadFile(content, filename, format.mime)
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Status filter section */}
        <Card className="p-4">
          <p className="mb-3 text-sm font-medium">{t('concept_mapping.export_filter_title')}</p>

          {/* Status checkboxes */}
          <div className="space-y-2">
            {STATUSES.map((status) => {
              const count = statusCounts[status] ?? 0
              const checked = includedStatuses.has(status)
              return (
                <div key={status}>
                  <label className="flex cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleStatus(status)}
                      className="size-3.5 rounded border-gray-300 accent-primary"
                    />
                    <span className="text-xs">{t(`concept_mapping.status_${status}`)}</span>
                    <Badge variant="secondary" className="text-[10px]">{count}</Badge>
                  </label>

                  {/* Approval sub-rules (only shown when approved is checked) */}
                  {status === 'approved' && checked && (
                    <div className="ml-6 mt-1.5 space-y-1">
                      {(['at_least_one', 'majority', 'no_rejections'] as ApprovalRule[]).map((rule) => (
                        <label key={rule} className="flex cursor-pointer items-center gap-2">
                          <input
                            type="radio"
                            name="approval-rule"
                            checked={approvalRule === rule}
                            onChange={() => setApprovalRule(rule)}
                            className="size-3 accent-primary"
                          />
                          <span className="text-[11px] text-muted-foreground">
                            {t(`concept_mapping.export_rule_${rule}`)}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-3 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              {t('concept_mapping.export_total')}: <strong>{filteredMappings.length}</strong> {t('concept_mapping.export_mappings_count')}
            </p>
          </div>
        </Card>

        {/* Format cards */}
        <div className="grid gap-3 sm:grid-cols-2">
          {formats.map((format) => (
            <Card key={format.id} className="flex flex-col justify-between p-4">
              <div>
                <div className="flex items-center gap-2">
                  <format.icon size={18} className="shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium">{format.name}</span>
                  <Badge variant="outline" className="text-[10px]">.{format.ext}</Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{format.description}</p>
              </div>
              <Button
                className="mt-4 w-full"
                variant="outline"
                size="sm"
                onClick={() => handleDownload(format)}
                disabled={filteredMappings.length === 0}
              >
                <Download size={14} />
                {t('concept_mapping.export_download')}
              </Button>
            </Card>
          ))}
        </div>

        {/* Empty state */}
        {mappings.length === 0 && (
          <Card>
            <div className="flex flex-col items-center py-10">
              <Download size={32} className="text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">
                {t('concept_mapping.export_empty')}
              </p>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
