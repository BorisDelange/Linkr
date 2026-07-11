import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useSaveForm } from '@/hooks/use-save-form'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { localized } from '@/lib/localized'
import { useOrganizationStore } from '@/stores/organization-store'
import { useAppStore } from '@/stores/app-store'
import type { BadgeColor, ProjectBadge } from '@/types'
import { Building2, MapPin, Globe, Mail, Info, Plus, X, Trash2, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { GatedButton } from '@/components/ui/gated-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { MembersTab } from '@/features/settings/MembersTab'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { BadgeColorButton } from '@/components/ui/badge-color-button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

const NONE = '__none__'

export function WorkspaceSettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useResolvedParams()
  const [searchParams] = useSearchParams()
  // Editing needs editor+, deleting needs owner (both enforced server-side too).
  const { can } = useMyWorkspaceRole(wsUid)
  const canEdit = can('workspace-settings:write')
  const canDelete = can('workspace-settings:delete')
  const requestedTab = searchParams.get('tab') ?? 'general'
  const defaultTab = requestedTab === 'danger' && !canDelete ? 'general' : requestedTab
  const language = useAppStore((s) => s.language)
  const { _workspacesRaw, updateWorkspace, updateWorkspaceBadges, deleteWorkspace, closeWorkspace } = useWorkspaceStore()
  const { _organizationsRaw, getOrganization } = useOrganizationStore()

  const workspace = _workspacesRaw.find((ws) => ws.id === wsUid)

  const [name, setName] = useState(localized(workspace?.name, language))
  const [description, setDescription] = useState(localized(workspace?.description, language))

  // Re-seed the fields when the active language (or workspace) changes so the
  // inputs always show the value for the current language, not a stale one.
  useEffect(() => {
    setName(localized(workspace?.name, language))
    setDescription(localized(workspace?.description, language))
  }, [workspace?.name, workspace?.description, language])
  const [selectedOrgId, setSelectedOrgId] = useState<string>(workspace?.organizationId ?? NONE)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteProgress, setDeleteProgress] = useState<{ phaseKey: string } | null>(null)
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')

  const handleSaveGeneral = async () => {
    if (!workspace || !wsUid) return
    await updateWorkspace(wsUid, {
      name: { ...workspace.name, [language]: name },
      description: { ...workspace.description, [language]: description },
    })
  }

  const general = useSaveForm({
    current: { name, description },
    baseline: {
      name: localized(workspace?.name, language),
      description: localized(workspace?.description, language),
    },
    onSave: handleSaveGeneral,
    canSave: !!name.trim(),
  })

  const handleSaveOrganization = async () => {
    if (!wsUid) return
    const orgId = selectedOrgId === NONE ? undefined : selectedOrgId
    await updateWorkspace(wsUid, { organizationId: orgId })
  }

  const organization = useSaveForm({
    current: selectedOrgId,
    baseline: workspace?.organizationId ?? NONE,
    onSave: handleSaveOrganization,
  })

  if (!workspace || !wsUid) return null

  const badges = workspace.badges ?? []

  const handleAddBadge = () => {
    if (!newBadgeLabel.trim()) return
    const badge: ProjectBadge = {
      id: `b-${Date.now()}`,
      label: newBadgeLabel.trim(),
      color: newBadgeColor,
    }
    updateWorkspaceBadges(wsUid, [...badges, badge])
    setNewBadgeLabel('')
  }

  const handleRemoveBadge = (id: string) => {
    updateWorkspaceBadges(wsUid, badges.filter((b) => b.id !== id))
  }

  const linkedOrg = workspace.organizationId ? getOrganization(workspace.organizationId) : null
  // Fallback to embedded org for legacy data
  const displayOrg = linkedOrg ?? (workspace.organization?.name ? workspace.organization : null)

  const handleDelete = async () => {
    setDeleteProgress({ phaseKey: 'workspaces.delete_phase_projects' })
    try {
      await deleteWorkspace(wsUid, (phaseKey) => setDeleteProgress({ phaseKey }))
      closeWorkspace()
      navigate('/workspaces')
    } finally {
      setDeleteProgress(null)
    }
  }

  const wsDisplayName = workspace.name[language] ?? workspace.name['en'] ?? Object.values(workspace.name)[0] ?? ''

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-2">
        <h1 className="text-2xl font-bold text-foreground">
          {t('workspaces.settings_title')}
        </h1>
      </div>

      <Tabs defaultValue={defaultTab} className="flex min-h-0 flex-1 flex-col px-6">
        <TabsList className="shrink-0 w-fit mx-auto">
          <TabsTrigger value="general">{t('workspaces.tab_general')}</TabsTrigger>
          <TabsTrigger value="members">{t('members.title')}</TabsTrigger>
          <TabsTrigger value="badges">{t('workspaces.tab_badges')}</TabsTrigger>
          <TabsTrigger value="organization">{t('workspaces.tab_organization')}</TabsTrigger>
          {canDelete && <TabsTrigger value="danger" className="text-destructive data-[state=active]:text-destructive">{t('workspace_settings.delete_workspace')}</TabsTrigger>}
        </TabsList>

        {/* General */}
        <TabsContent value="general" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-3xl space-y-6 pt-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('workspaces.tab_general')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="ws-name">{t('workspaces.field_name')}</Label>
                  <Input
                    id="ws-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') general.save() }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ws-desc">{t('workspaces.field_description')}</Label>
                  <Textarea
                    id="ws-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                  />
                </div>
                <GatedButton
                  allowed={canEdit}
                  notAllowedReason={t('common.insufficient_permissions')}
                  size="sm"
                  onClick={general.save}
                  disabled={!general.canSaveNow}
                >
                  {t('common.save')}
                </GatedButton>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Members */}
        <TabsContent value="members" className="min-h-0 flex-1 overflow-auto pb-6">
          <MembersTab scope="workspace" targetId={wsUid} />
        </TabsContent>

        {/* Badges */}
        <TabsContent value="badges" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-2xl space-y-6 pt-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('project_settings.badges')}</CardTitle>
                <CardDescription>{t('workspaces.badges_description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {badges.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {badges.map((badge) => (
                      <span
                        key={badge.id}
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${getBadgeClasses(badge.color)}`}
                        style={getBadgeStyle(badge.color)}
                      >
                        {badge.label}
                        {canEdit && (
                          <button
                            onClick={() => handleRemoveBadge(badge.id)}
                            className="rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                <div className="space-y-2">
                  <Label>{t('project_settings.badge_label')}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={newBadgeLabel}
                      onChange={(e) => setNewBadgeLabel(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddBadge()}
                      placeholder={t('project_settings.badge_label_placeholder')}
                      className="h-8 flex-1 text-sm"
                    />
                    <BadgeColorButton value={newBadgeColor} onChange={setNewBadgeColor} />
                    <GatedButton
                      allowed={canEdit}
                      notAllowedReason={t('common.insufficient_permissions')}
                      size="sm"
                      variant="outline"
                      onClick={handleAddBadge}
                      disabled={!newBadgeLabel.trim()}
                      className="gap-1"
                    >
                      <Plus size={14} />
                      {t('project_settings.add_badge')}
                    </GatedButton>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Organization */}
        <TabsContent value="organization" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-3xl space-y-6 pt-2">
            {/* Current linked org display */}
            {displayOrg && (
              <Card>
                <CardContent className="flex items-start gap-4 p-5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Building2 size={20} className="text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-card-foreground">{localized(displayOrg.name, language)}</p>
                      {displayOrg.type && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {displayOrg.type === 'other' && displayOrg.customType ? localized(displayOrg.customType, language) : t(`workspaces.org_type_${displayOrg.type}`)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {(displayOrg.location || displayOrg.country) && (
                        <span className="flex items-center gap-1">
                          <MapPin size={12} />
                          {[localized(displayOrg.location, language), localized(displayOrg.country, language)].filter(Boolean).join(', ')}
                        </span>
                      )}
                      {displayOrg.website && (
                        <span className="flex items-center gap-1"><Globe size={12} />{displayOrg.website}</span>
                      )}
                      {displayOrg.email && (
                        <span className="flex items-center gap-1"><Mail size={12} />{displayOrg.email}</span>
                      )}
                    </div>
                    {displayOrg.referenceId && (
                      <p className="mt-1 text-[11px] text-muted-foreground/60">
                        ID: {displayOrg.referenceId}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Change organization */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('workspaces.change_organization')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-400">
                  <Info size={14} className="mt-0.5 shrink-0" />
                  <span>{t('workspaces.organization_shared_note')}</span>
                </div>
                <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('workspaces.select_organization')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('workspaces.no_organization')}</SelectItem>
                    {_organizationsRaw.map((org) => (
                      <SelectItem key={org.id} value={org.id}>
                        {localized(org.name, language)}
                        {org.type ? ` (${t(`workspaces.org_type_${org.type}`)})` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <GatedButton
                  allowed={canEdit}
                  notAllowedReason={t('common.insufficient_permissions')}
                  size="sm"
                  onClick={organization.save}
                  disabled={!organization.canSaveNow}
                >
                  {t('common.save')}
                </GatedButton>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Danger zone — owner only */}
        {canDelete && (
        <TabsContent value="danger" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-2xl pt-2">
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-sm text-destructive">
                  {t('workspaces.delete_workspace')}
                </CardTitle>
                <CardDescription>
                  {t('workspaces.delete_workspace_description')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm">
                      <Trash2 size={14} />
                      {t('workspaces.delete_workspace')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('workspaces.delete_workspace')}</AlertDialogTitle>
                      <AlertDialogDescription asChild>
                        <div className="space-y-3">
                          <p>{t('workspaces.delete_workspace_description')}</p>
                          <p className="text-sm">
                            {t('workspaces.delete_workspace_confirm')}{' '}
                            <span className="font-semibold text-foreground">{wsDisplayName}</span>
                          </p>
                          <Input
                            value={deleteConfirm}
                            onChange={(e) => setDeleteConfirm(e.target.value)}
                            placeholder={wsDisplayName}
                            className="mt-2"
                          />
                        </div>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel onClick={() => setDeleteConfirm('')}>
                        {t('common.cancel')}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDelete}
                        disabled={deleteConfirm !== wsDisplayName}
                        className="!bg-destructive !text-white hover:!bg-destructive/90 disabled:!opacity-50"
                      >
                        {t('workspaces.delete_workspace')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        )}
      </Tabs>

      {/* Delete progress modal — non-dismissable while deleteWorkspace runs. */}
      <Dialog open={!!deleteProgress} onOpenChange={() => { /* not dismissable */ }}>
        <DialogContent
          className="max-w-md"
          showCloseButton={false}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Loader2 size={14} className="animate-spin text-primary" />
              {t('workspaces.delete_progress_title')}
            </DialogTitle>
          </DialogHeader>
          {deleteProgress && (
            <div className="pt-2">
              <p className="text-xs text-muted-foreground">{t(deleteProgress.phaseKey)}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
