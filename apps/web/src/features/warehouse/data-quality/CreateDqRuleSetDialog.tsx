import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDqStore } from '@/stores/dq-store'
import type { DqRuleSet } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingRuleSet?: DqRuleSet | null
  onCreated?: (ruleSetId: string) => void
}

export function CreateDqRuleSetDialog({ open, onOpenChange, editingRuleSet, onCreated }: Props) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useWorkspaceStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { createRuleSet, updateRuleSet } = useDqStore()
  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database')

  const [name, setName] = useState('')
  const [dataSourceId, setDataSourceId] = useState('')

  const isEdit = !!editingRuleSet

  useEffect(() => {
    if (editingRuleSet) {
      setName(editingRuleSet.name)
      setDataSourceId(editingRuleSet.dataSourceId)
    } else {
      setName('')
      setDataSourceId('')
    }
  }, [editingRuleSet, open])

  const handleSubmit = async () => {
    if (!name.trim() || !dataSourceId || !activeWorkspaceId) return

    if (isEdit && editingRuleSet) {
      await updateRuleSet(editingRuleSet.id, { name: name.trim(), dataSourceId })
      onOpenChange(false)
    } else {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      await createRuleSet({
        id,
        workspaceId: activeWorkspaceId,
        name: name.trim(),
        description: '',
        dataSourceId,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      })
      onOpenChange(false)
      onCreated?.(id)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('data_quality.edit_rs_title') : t('data_quality.create_rs_title')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs">{t('data_quality.rs_name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('data_quality.rs_name_placeholder')}
              className="mt-1"
              autoFocus
            />
          </div>
          <div>
            <Label className="text-xs">{t('data_quality.rs_database')}</Label>
            <Select value={dataSourceId} onValueChange={setDataSourceId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={t('data_quality.select_database')} />
              </SelectTrigger>
              <SelectContent>
                {dbSources.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id}>
                    {ds.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || !dataSourceId}>
            {isEdit ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
