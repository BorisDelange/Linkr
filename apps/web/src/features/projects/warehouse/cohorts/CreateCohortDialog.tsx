import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CohortLevel } from '@/types'

interface CreateCohortDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: { name: string; description: string; level: CohortLevel }) => void
}

const levelOptions: { value: CohortLevel; labelKey: string; descKey: string }[] = [
  { value: 'patient', labelKey: 'cohorts.level_patient', descKey: 'cohorts.level_patient_desc' },
  { value: 'visit', labelKey: 'cohorts.level_visit', descKey: 'cohorts.level_visit_desc' },
  { value: 'visit_detail', labelKey: 'cohorts.level_visit_detail', descKey: 'cohorts.level_visit_detail_desc' },
]

export function CreateCohortDialog({ open, onOpenChange, onSubmit }: CreateCohortDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [level, setLevel] = useState<CohortLevel>('patient')

  const handleSubmit = () => {
    if (!name.trim()) return
    onSubmit({ name: name.trim(), description: description.trim(), level })
    setName('')
    setDescription('')
    setLevel('patient')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('cohorts.create_title')}</DialogTitle>
          <DialogDescription>{t('cohorts.create_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t('cohorts.field_name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('cohorts.field_name_placeholder')}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('cohorts.field_description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('cohorts.field_description_placeholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('cohorts.field_level')}</Label>
            <div className="flex flex-col gap-1.5 mt-1.5">
              {levelOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setLevel(opt.value)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    level === opt.value
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted/50'
                  }`}
                >
                  <span className="text-xs font-medium">{t(opt.labelKey)}</span>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{t(opt.descKey)}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim()}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
