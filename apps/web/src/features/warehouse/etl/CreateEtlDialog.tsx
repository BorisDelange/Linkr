import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useEtlStore } from '@/stores/etl-store'
import type { EtlPipeline } from '@/types'

const TARGET_PRESETS = [
  { id: 'omop-5.4', label: 'OMOP CDM 5.4' },
  { id: 'omop-5.3', label: 'OMOP CDM 5.3' },
  { id: 'none', label: 'Custom (no preset)' },
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (pipelineId: string) => void
}

export function CreateEtlDialog({ open, onOpenChange, onCreated }: Props) {
  const { t } = useTranslation()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { activeWorkspaceId } = useWorkspaceStore()
  const { createPipeline } = useEtlStore()

  const [name, setName] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [targetPresetId, setTargetPresetId] = useState('omop-5.4')
  const [creating, setCreating] = useState(false)

  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database')

  const handleCreate = async () => {
    if (!name.trim() || !sourceId || !activeWorkspaceId) return
    setCreating(true)
    try {
      const now = new Date().toISOString()
      const pipeline: EtlPipeline = {
        id: crypto.randomUUID(),
        workspaceId: activeWorkspaceId,
        name: name.trim(),
        description: '',
        sourceDataSourceId: sourceId,
        targetSchemaPresetId: targetPresetId,
        targetConfig: { mode: 'parquet-local' },
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      }
      await createPipeline(pipeline)
      onOpenChange(false)
      setName('')
      setSourceId('')
      setTargetPresetId('omop-5.4')
      onCreated?.(pipeline.id)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('etl.create_title')}</DialogTitle>
          <DialogDescription>{t('etl.create_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>{t('etl.pipeline_name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('etl.pipeline_name_placeholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && sourceId) handleCreate()
              }}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('etl.source_database')}</Label>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger>
                <SelectValue placeholder={t('etl.select_source')} />
              </SelectTrigger>
              <SelectContent>
                {dbSources.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id}>
                    {ds.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {dbSources.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('etl.no_databases_available')}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>{t('etl.target_schema')}</Label>
            <Select value={targetPresetId} onValueChange={setTargetPresetId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TARGET_PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || !sourceId || creating}
          >
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
