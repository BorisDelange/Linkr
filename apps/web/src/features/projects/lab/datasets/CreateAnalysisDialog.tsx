import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TableIcon, BarChart3, FileText } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetAnalysisType } from '@/types'

interface CreateAnalysisDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  datasetFileId: string
}

interface AnalysisTypeCard {
  value: DatasetAnalysisType
  nameKey: string
  descriptionKey: string
  icon: React.ReactNode
  preview: React.ReactNode
}

// Mini preview illustrations
function Table1Preview() {
  return (
    <div className="w-full text-[8px] leading-tight">
      <div className="grid grid-cols-3 gap-px">
        <div className="bg-muted px-1 py-0.5 font-medium">Variable</div>
        <div className="bg-muted px-1 py-0.5 font-medium text-center">n (%)</div>
        <div className="bg-muted px-1 py-0.5 font-medium text-center">Mean ± SD</div>
        <div className="px-1 py-0.5 text-muted-foreground">Age</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">—</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">63.2 ± 15.1</div>
        <div className="px-1 py-0.5 text-muted-foreground">Sex (M)</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">54 (62%)</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">—</div>
        <div className="px-1 py-0.5 text-muted-foreground">ICU stay</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">38 (44%)</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">—</div>
      </div>
    </div>
  )
}

function DistributionPreview() {
  const bars = [3, 5, 8, 12, 15, 11, 7, 4, 2]
  const max = Math.max(...bars)
  return (
    <div className="flex items-end gap-px h-10 w-full">
      {bars.map((h, i) => (
        <div
          key={i}
          className="flex-1 bg-primary/40 rounded-t-sm"
          style={{ height: `${(h / max) * 100}%` }}
        />
      ))}
    </div>
  )
}

function SummaryPreview() {
  return (
    <div className="w-full text-[8px] leading-tight space-y-0.5">
      <div className="flex justify-between text-muted-foreground"><span>Rows</span><span>100</span></div>
      <div className="flex justify-between text-muted-foreground"><span>Columns</span><span>14</span></div>
      <div className="flex justify-between text-muted-foreground"><span>Numeric</span><span>9</span></div>
      <div className="flex justify-between text-muted-foreground"><span>Categorical</span><span>5</span></div>
      <div className="flex justify-between text-muted-foreground"><span>Missing</span><span>0.2%</span></div>
    </div>
  )
}

const ANALYSIS_TYPES: AnalysisTypeCard[] = [
  {
    value: 'table1',
    nameKey: 'datasets.analysis_type_table1',
    descriptionKey: 'datasets.analysis_type_table1_desc',
    icon: <TableIcon size={20} className="text-blue-500" />,
    preview: <Table1Preview />,
  },
  {
    value: 'distribution',
    nameKey: 'datasets.analysis_type_distribution',
    descriptionKey: 'datasets.analysis_type_distribution_desc',
    icon: <BarChart3 size={20} className="text-violet-500" />,
    preview: <DistributionPreview />,
  },
  {
    value: 'summary',
    nameKey: 'datasets.analysis_type_summary',
    descriptionKey: 'datasets.analysis_type_summary_desc',
    icon: <FileText size={20} className="text-emerald-500" />,
    preview: <SummaryPreview />,
  },
]

export function CreateAnalysisDialog({ open, onOpenChange, datasetFileId }: CreateAnalysisDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [selectedType, setSelectedType] = useState<DatasetAnalysisType>('table1')
  const { createAnalysis } = useDatasetStore()

  const handleCreate = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    createAnalysis(datasetFileId, trimmed, selectedType)
    setName('')
    setSelectedType('table1')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('datasets.new_analysis')}</DialogTitle>
          <DialogDescription>{t('datasets.new_analysis_description')}</DialogDescription>
        </DialogHeader>

        {/* Type selection cards */}
        <div className="grid grid-cols-3 gap-2 py-2">
          {ANALYSIS_TYPES.map((at) => (
            <button
              key={at.value}
              onClick={() => {
                setSelectedType(at.value)
                if (!name.trim()) {
                  setName(t(at.nameKey))
                }
              }}
              className={cn(
                'flex flex-col rounded-lg border p-3 text-left transition-all hover:bg-accent/50',
                selectedType === at.value && 'border-primary ring-1 ring-primary bg-primary/5'
              )}
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  {at.icon}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium">{t(at.nameKey)}</p>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground mb-2">
                {t(at.descriptionKey)}
              </p>
              {/* Mini preview */}
              <div className="rounded border bg-muted/30 p-1.5">
                {at.preview}
              </div>
            </button>
          ))}
        </div>

        {/* Name input */}
        <div className="space-y-1.5">
          <Label htmlFor="analysis-name">{t('datasets.name')}</Label>
          <Input
            id="analysis-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t(ANALYSIS_TYPES.find(a => a.value === selectedType)?.nameKey ?? '')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
            }}
          />
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
