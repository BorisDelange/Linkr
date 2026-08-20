import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { RequiredMark } from '@/components/ui/required-mark'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useEtlStore } from '@/stores/etl-store'
import { useAppStore, stampAuthored, stampLineage } from '@/stores/app-store'
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { VersionField } from '@/components/ui/version-field'
import { useBadgeSuggestions } from '@/hooks/use-badge-suggestions'
import { localized, setLocalized } from '@/lib/localized'
import type { EtlPipeline, ProjectBadge } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (pipelineId: string) => void
  /** Pass a pipeline to edit it instead of creating a new one */
  editingPipeline?: EtlPipeline | null
}

export function CreateEtlDialog({ open, onOpenChange, onCreated, editingPipeline }: Props) {
  const { t } = useTranslation()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { activeWorkspaceId } = useWorkspaceStore()
  const { createPipeline, updatePipeline } = useEtlStore()
  const language = useAppStore((s) => s.language)

  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [version, setVersion] = useState('0.1.0')
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})
  const [saving, setSaving] = useState(false)

  const isEditing = !!editingPipeline
  const { etlPipelines } = useEtlStore()
  const existingIds = etlPipelines.map(p => p.entityId).filter((id): id is string => !!id)
  const badgeSuggestions = useBadgeSuggestions(etlPipelines, activeWorkspaceId, editingPipeline?.id)

  // Populate fields when opening in edit mode
  useEffect(() => {
    if (open && editingPipeline) {
      setName(localized(editingPipeline.name, language))
      setEntityId(editingPipeline.entityId ?? '')
      setSourceId(editingPipeline.sourceDataSourceId)
      setTargetId(editingPipeline.targetDataSourceId ?? '')
      setBadges(editingPipeline.badges ?? [])
      setVersion(editingPipeline.version ?? '0.1.0')
      setAuthoring({})
    } else if (open && !editingPipeline) {
      setName('')
      setEntityId('')
      setSourceId('')
      setTargetId('')
      setBadges([])
      setVersion('0.1.0')
      setAuthoring({})
    }
  }, [open, editingPipeline, language])

  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  const handleSubmit = async () => {
    if (!name.trim() || !activeWorkspaceId) return
    if (!isEditing && !isEntityIdValid(entityId, existingIds)) return
    setSaving(true)
    try {
      if (isEditing && editingPipeline) {
        // The two databases are deliberately not written here: they belong to the
        // pipeline header's pickers, and re-saving a value this dialog captured
        // when it opened would undo a change made there in the meantime.
        await updatePipeline(editingPipeline.id, {
          name: setLocalized(editingPipeline.name, language, name.trim()),
          badges,
          version: version.trim() || '0.1.0',
          ...authoring,
        })
        onOpenChange(false)
      } else {
        const now = new Date().toISOString()
        const pipeline: EtlPipeline = {
          id: crypto.randomUUID(),
          entityId: entityId || undefined,
          workspaceId: activeWorkspaceId,
          name: setLocalized({}, language, name.trim()),
          description: {},
          sourceDataSourceId: sourceId,
          targetDataSourceId: targetId || undefined,
          badges,
          status: 'draft',
          version: version.trim() || '0.1.0',
          // A README from the start: the pipeline is git-versionable, and a repo
          // whose first file is a numbered SQL script says nothing about what the
          // pipeline is for. It lives on the entity, not in the file tree.
          readme: setLocalized({}, language, `# ${name.trim()}\n`),
          ...stampAuthored(),
          ...stampLineage(),
          createdAt: now,
          updatedAt: now,
        }
        await createPipeline(pipeline)
        onOpenChange(false)
        setName('')
        setSourceId('')
        setTargetId('')
        onCreated?.(pipeline.id)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={isEditing ? t('etl.edit_title') : t('etl.create_title')}
      description={isEditing ? t('etl.edit_description') : t('etl.create_description')}
      onConfirm={handleSubmit}
      confirmLabel={isEditing ? t('common.save') : t('common.create')}
      confirmDisabled={!name.trim() || (!isEditing && !isEntityIdValid(entityId, existingIds))}
      busy={saving}
    >
          <div className="space-y-2">
            <Label>{t('etl.pipeline_name')}<RequiredMark /></Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('etl.pipeline_name_placeholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) { e.preventDefault(); handleSubmit() }
              }}
            />
          </div>

                      <EntityIdField
              name={name}
              value={entityId}
              onChange={setEntityId}
              existingIds={existingIds}
              htmlId="etl-pipeline-id"
              placeholder="my-etl-pipeline"
              required
              readOnly={isEditing}
            />

          {/* Only on create: once the pipeline exists, its two databases are set
              from the pickers in the pipeline header, and a second pair of
              dropdowns here just invites the two to disagree. */}
          {!isEditing && (
            <>
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
                <Label>{t('etl.target_database')}</Label>
                <Select value={targetId} onValueChange={setTargetId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('etl.select_target')} />
                  </SelectTrigger>
                  <SelectContent>
                    {dbSources.map((ds) => (
                      <SelectItem key={ds.id} value={ds.id}>
                        {ds.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t('etl.target_database_hint')}</p>
              </div>
            </>
          )}

          <BadgeEditor value={badges} onChange={setBadges} suggestions={badgeSuggestions} />

          <VersionField value={version} onChange={setVersion} />

          {isEditing && editingPipeline && (
            <div className="border-t pt-4">
              <AuthoringFields
                value={{
                  createdById: 'createdById' in authoring ? authoring.createdById : editingPipeline.createdById,
                  createdBy: authoring.createdBy ?? editingPipeline.createdBy,
                  createdByDetails: authoring.createdByDetails ?? editingPipeline.createdByDetails,
                  organization: authoring.organization ?? editingPipeline.organization,
                }}
                onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
              />
            </div>
          )}
    </DialogShell>
  )
}
