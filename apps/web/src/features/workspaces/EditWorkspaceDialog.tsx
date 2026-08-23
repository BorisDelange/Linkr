import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import { useSaveForm } from '@/hooks/use-save-form'
import type { Workspace, ProjectBadge } from '@/types'
import { Info } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { EntityDialogTabs } from '@/components/ui/entity-dialog-tabs'
import { RequiredMark } from '@/components/ui/required-mark'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const NONE = '__none__'

interface EditWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace?: Workspace
}

export function EditWorkspaceDialog({ open, onOpenChange, workspace }: EditWorkspaceDialogProps) {
  const { t } = useTranslation()
  const { updateWorkspace, updateWorkspaceBadges } = useWorkspaceStore()
  const allWorkspaces = useWorkspaceStore((s) => s.workspaces)
  // A workspace has no parent workspace, so useBadgeSuggestions (which scopes by
  // workspaceId) doesn't apply: the siblings here are the other workspaces.
  const badgeSuggestions = useMemo(
    () => allWorkspaces.filter((w) => w.id !== workspace?.id).flatMap((w) => w.badges ?? []),
    [allWorkspaces, workspace?.id],
  )
  const organizations = useOrganizationStore((s) => s._organizationsRaw)
  const language = useAppStore((s) => s.language)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [selectedOrgId, setSelectedOrgId] = useState<string>(NONE)
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})

  useEffect(() => {
    if (open && workspace) {
      setName(localized(workspace.name, language))
      setDescription(localized(workspace.description, language))
      setBadges(workspace.badges ?? [])
      setSelectedOrgId(workspace.organizationId ?? NONE)
      setAuthoring({})
    }
  }, [open, workspace, language])

  const doSave = async () => {
    if (!workspace) return
    await updateWorkspace(workspace.id, {
      name: setLocalized(workspace.name, language, name.trim()),
      description: setLocalized(workspace.description, language, description.trim()),
      organizationId: selectedOrgId === NONE ? undefined : selectedOrgId,
      ...authoring,
    })
    await updateWorkspaceBadges(workspace.id, badges)
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: { name, description, badges, selectedOrgId, authoring },
    baseline: {
      name: localized(workspace?.name, language),
      description: localized(workspace?.description, language),
      badges: workspace?.badges ?? [],
      selectedOrgId: workspace?.organizationId ?? NONE,
      authoring: {},
    },
    onSave: doSave,
    canSave: name.trim().length > 0,
  })

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('workspaces.edit_dialog_title')}
      description={t('workspaces.edit_dialog_description')}
      onConfirm={save}
      confirmLabel={t('common.save')}
      confirmDisabled={!canSaveNow}
      dirtyTracked
    >
      <EntityDialogTabs
        general={
          <>
            <div className="space-y-2">
              <Label htmlFor="edit-ws-name">{t('workspaces.field_name')}<RequiredMark /></Label>
              <Input
                id="edit-ws-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-ws-desc">{t('workspaces.field_description')}</Label>
              <Input
                id="edit-ws-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            {/* Organization (live link, shared across workspaces) */}
            <div className="space-y-2">
              <Label>{t('workspaces.organization_section')}</Label>
              <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('workspaces.select_organization')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('workspaces.no_organization')}</SelectItem>
                  {organizations.map((org) => (
                    <SelectItem key={org.id} value={org.id}>
                      {localized(org.name, language)}
                      {org.type
                        ? ` (${org.type === 'other' && org.customType ? localized(org.customType, language) : t(`workspaces.org_type_${org.type}`)})`
                        : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-2.5 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
                <Info size={14} className="mt-0.5 shrink-0" />
                <p>
                  {t('workspaces.org_create_hint')}{' '}
                  <Link
                    to="/settings/organizations"
                    className="font-medium underline underline-offset-2"
                    onClick={() => onOpenChange(false)}
                  >
                    {t('workspaces.org_create_hint_link')}
                  </Link>
                </p>
              </div>
            </div>

          </>
        }
        metadata={
          <BadgeEditor
            value={badges}
            onChange={setBadges}
            suggestions={badgeSuggestions}
            label={t('project_settings.badges')}
          />
        }
        attribution={
          workspace ? (
            <AuthoringFields
              hideOrganization
              value={{
                createdById: 'createdById' in authoring ? authoring.createdById : workspace.createdById,
                createdBy: authoring.createdBy ?? workspace.createdBy,
                createdByDetails: authoring.createdByDetails ?? workspace.createdByDetails,
              }}
              onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
            />
          ) : undefined
        }
      />
    </DialogShell>
  )
}
