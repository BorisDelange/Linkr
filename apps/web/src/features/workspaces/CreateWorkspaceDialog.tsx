import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import type { ProjectBadge } from '@/types'
import { Info } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { RequiredMark } from '@/components/ui/required-mark'
import { localized } from '@/lib/localized'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired with the new workspace's id, so the caller can open it. Opening also
   *  has to set the active workspace, which is the caller's business. */
  onCreated?: (id: string, name: string) => void
}

const NONE = '__none__'

export function CreateWorkspaceDialog({ open, onOpenChange, onCreated }: CreateWorkspaceDialogProps) {
  const { t, i18n } = useTranslation()
  const { addWorkspace, updateWorkspaceBadges, _workspacesRaw } = useWorkspaceStore()
  const { _organizationsRaw } = useOrganizationStore()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedOrgId, setSelectedOrgId] = useState<string>(NONE)
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  // A workspace's siblings are the other workspaces, so the suggestions are the
  // whole list — not useBadgeSuggestions, which scopes items to one workspace.
  const badgeCategories = useBadgeCategories()
  const badgeSuggestions = useMemo(() => _workspacesRaw.flatMap((w) => w.badges ?? []), [_workspacesRaw])

  const handleSubmit = async () => {
    if (!name.trim()) return

    const newId = await addWorkspace({
      name: name.trim(),
      description: description.trim(),
      organizationId: selectedOrgId !== NONE ? selectedOrgId : undefined,
    })
    if (badges.length > 0) await updateWorkspaceBadges(newId, badges)
    setName('')
    setDescription('')
    setSelectedOrgId(NONE)
    setBadges([])
    onOpenChange(false)
    onCreated?.(newId, name.trim())
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={t('workspaces.create_dialog_title')}
      description={t('workspaces.create_dialog_description')}
      onConfirm={handleSubmit}
      confirmLabel={t('common.create')}
      confirmDisabled={!name.trim()}
    >
            {/* Workspace fields */}
            <div className="space-y-2">
              <Label htmlFor="ws-name">{t('workspaces.field_name')}<RequiredMark /></Label>
              <Input
                id="ws-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('workspaces.field_name_placeholder')}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ws-desc">{t('workspaces.field_description')}</Label>
              <Input
                id="ws-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('workspaces.field_description_placeholder')}
              />
            </div>

            <BadgeEditor
              categories={badgeCategories}
              value={badges}
              onChange={setBadges}
              suggestions={badgeSuggestions}
              label={t('project_settings.badges')}
            />

            {/* Organization picker */}
            <div className="border-t pt-4">
              <Label className="text-sm font-medium">{t('workspaces.organization_section')}</Label>
              <div className="mt-2 space-y-2">
                <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('workspaces.select_organization')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('workspaces.no_organization')}</SelectItem>
                    {_organizationsRaw.map((org) => (
                      <SelectItem key={org.id} value={org.id}>
                        {localized(org.name, i18n.language)}
                        {org.type
                          ? ` (${org.type === 'other' && org.customType ? localized(org.customType, i18n.language) : t(`workspaces.org_type_${org.type}`)})`
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
            </div>
    </DialogShell>
  )
}
