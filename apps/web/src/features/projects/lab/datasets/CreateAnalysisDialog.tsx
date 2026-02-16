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
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetAnalysisType } from '@/types'

interface CreateAnalysisDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  datasetFileId: string
}

const ANALYSIS_TYPES: { value: DatasetAnalysisType; labelKey: string }[] = [
  { value: 'table1', labelKey: 'datasets.analysis_type_table1' },
  { value: 'distribution', labelKey: 'datasets.analysis_type_distribution' },
  { value: 'summary', labelKey: 'datasets.analysis_type_summary' },
]

export function CreateAnalysisDialog({ open, onOpenChange, datasetFileId }: CreateAnalysisDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [type, setType] = useState<DatasetAnalysisType>('table1')
  const { createAnalysis } = useDatasetStore()

  const handleCreate = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    createAnalysis(datasetFileId, trimmed, type)
    setName('')
    setType('table1')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t('datasets.new_analysis')}</DialogTitle>
          <DialogDescription>{t('datasets.new_analysis_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="analysis-name">{t('datasets.name')}</Label>
            <Input
              id="analysis-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Table 1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
              }}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('datasets.analysis_type')}</Label>
            <Select value={type} onValueChange={(v) => setType(v as DatasetAnalysisType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANALYSIS_TYPES.map((at) => (
                  <SelectItem key={at.value} value={at.value}>
                    {t(at.labelKey)}
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
          <Button onClick={handleCreate} disabled={!name.trim()}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
