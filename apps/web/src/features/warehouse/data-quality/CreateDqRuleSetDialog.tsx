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
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { RequiredMark } from '@/components/ui/required-mark'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore, stampAuthored, stampLineage } from '@/stores/app-store'
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { VersionField } from '@/components/ui/version-field'
import { useBadgeSuggestions } from '@/hooks/use-badge-suggestions'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDqStore } from '@/stores/dq-store'
import type { DqRuleSet, ProjectBadge } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingRuleSet?: DqRuleSet | null
  onCreated?: (ruleSetId: string) => void
}

export function CreateDqRuleSetDialog({ open, onOpenChange, editingRuleSet, onCreated }: Props) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const { activeWorkspaceId } = useWorkspaceStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { createRuleSet, updateRuleSet } = useDqStore()
  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [entityId, setEntityId] = useState('')
  const [dataSourceId, setDataSourceId] = useState('')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [version, setVersion] = useState('0.1.0')
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})

  const isEdit = !!editingRuleSet
  const { dqRuleSets } = useDqStore()
  const existingIds = dqRuleSets.map(r => r.entityId).filter((id): id is string => !!id)
  const badgeSuggestions = useBadgeSuggestions(dqRuleSets, activeWorkspaceId, editingRuleSet?.id)

  useEffect(() => {
    if (editingRuleSet) {
      setName(localized(editingRuleSet.name, language))
      setDescription(localized(editingRuleSet.description, language))
      setEntityId(editingRuleSet.entityId ?? '')
      setDataSourceId(editingRuleSet.dataSourceId)
      setBadges(editingRuleSet.badges ?? [])
      setVersion(editingRuleSet.version ?? '0.1.0')
      setAuthoring({})
    } else {
      setName('')
      setDescription('')
      setEntityId('')
      setDataSourceId('')
      setBadges([])
      setVersion('0.1.0')
      setAuthoring({})
    }
  }, [editingRuleSet, open])

  const handleSubmit = async () => {
    if (!name.trim() || !activeWorkspaceId) return

    if (isEdit && editingRuleSet) {
      await updateRuleSet(editingRuleSet.id, {
        name: setLocalized(editingRuleSet.name, language, name.trim()),
        description: setLocalized(editingRuleSet.description, language, description.trim()),
        dataSourceId,
        badges,
        version: version.trim() || '0.1.0',
        ...authoring,
      })
      onOpenChange(false)
    } else {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      await createRuleSet({
        id,
        entityId: entityId || undefined,
        workspaceId: activeWorkspaceId,
        name: setLocalized(undefined, language, name.trim()),
        description: setLocalized(undefined, language, description.trim()),
        dataSourceId,
        badges,
        status: 'draft',
        version: version.trim() || '0.1.0',
        ...stampAuthored(),
        ...stampLineage(),
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
            <Label className="text-xs">{t('data_quality.rs_name')}<RequiredMark /></Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('data_quality.rs_name_placeholder')}
              className="mt-1"
              autoFocus
            />
          </div>
          <div>
            <Label className="text-xs">{t('common.description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1"
            />
          </div>
                      <EntityIdField
              name={name}
              value={entityId}
              onChange={setEntityId}
              existingIds={existingIds}
              htmlId="dq-ruleset-id"
              placeholder="my-rule-set"
              required
              readOnly={isEdit}
            />
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

          <BadgeEditor value={badges} onChange={setBadges} suggestions={badgeSuggestions} />

          <VersionField value={version} onChange={setVersion} />

          {isEdit && editingRuleSet && (
            <div className="border-t pt-4">
              <AuthoringFields
                value={{
                  createdById: 'createdById' in authoring ? authoring.createdById : editingRuleSet.createdById,
                  createdBy: authoring.createdBy ?? editingRuleSet.createdBy,
                  createdByDetails: authoring.createdByDetails ?? editingRuleSet.createdByDetails,
                  organization: authoring.organization ?? editingRuleSet.organization,
                }}
                onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || (!isEdit && !isEntityIdValid(entityId, existingIds))}>
            {isEdit ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
