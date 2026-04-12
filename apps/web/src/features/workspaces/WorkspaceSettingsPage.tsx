import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useAppStore } from '@/stores/app-store'
import type { BadgeColor, ProjectBadge, PresetBadgeColor } from '@/types'
import { Building2, MapPin, Globe, Mail, Info, Plus, X, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getBadgeClasses, getBadgeStyle, PRESET_COLORS, isCustomColor } from '@/features/projects/ProjectSettingsPage'
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
  const { wsUid } = useParams()
  const [searchParams] = useSearchParams()
  const defaultTab = searchParams.get('tab') ?? 'general'
  const language = useAppStore((s) => s.language)
  const { _workspacesRaw, updateWorkspace, updateWorkspaceBadges, deleteWorkspace, closeWorkspace } = useWorkspaceStore()
  const { _organizationsRaw, getOrganization } = useOrganizationStore()

  const workspace = _workspacesRaw.find((ws) => ws.id === wsUid)

  const [name, setName] = useState(workspace?.name[language] ?? workspace?.name['en'] ?? '')
  const [description, setDescription] = useState(workspace?.description[language] ?? workspace?.description['en'] ?? '')
  const [selectedOrgId, setSelectedOrgId] = useState<string>(workspace?.organizationId ?? NONE)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')

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

  const handleSaveGeneral = async () => {
    await updateWorkspace(wsUid, {
      name: { ...workspace.name, [language]: name },
      description: { ...workspace.description, [language]: description },
    })
  }

  const handleSaveOrganization = async () => {
    const orgId = selectedOrgId === NONE ? undefined : selectedOrgId
    await updateWorkspace(wsUid, { organizationId: orgId })
  }

  const handleDelete = async () => {
    await deleteWorkspace(wsUid)
    closeWorkspace()
    navigate('/workspaces')
  }

  const wsDisplayName = workspace.name[language] ?? workspace.name['en'] ?? Object.values(workspace.name)[0] ?? ''

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-bold text-foreground">
          {t('workspaces.settings_title')}
        </h1>

        <Tabs defaultValue={defaultTab} className="mt-6">
          <TabsList>
            <TabsTrigger value="general">{t('workspaces.tab_general')}</TabsTrigger>
            <TabsTrigger value="badges">{t('workspaces.tab_badges')}</TabsTrigger>
            <TabsTrigger value="organization">{t('workspaces.tab_organization')}</TabsTrigger>
            <TabsTrigger value="danger">{t('workspaces.tab_danger')}</TabsTrigger>
          </TabsList>

          {/* General */}
          <TabsContent value="general" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('workspaces.tab_general')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="ws-name">{t('workspaces.field_name')}</Label>
                  <Input
                    id="ws-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
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
                <Button onClick={handleSaveGeneral} disabled={!name.trim()}>
                  {t('common.save')}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Badges */}
          <TabsContent value="badges" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('project_settings.badges')}</CardTitle>
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
                        <button
                          onClick={() => handleRemoveBadge(badge.id)}
                          className="rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20"
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="space-y-2">
                  <Label>{t('project_settings.badge_label')}</Label>
                  <div className="flex items-center gap-3">
                    <Input
                      value={newBadgeLabel}
                      onChange={(e) => setNewBadgeLabel(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddBadge()}
                      placeholder={t('project_settings.badge_label_placeholder')}
                      className="h-8 w-48 text-sm"
                    />
                    <div className="flex items-center gap-1.5">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c.value}
                          onClick={() => setNewBadgeColor(c.value)}
                          className={`h-6 w-6 rounded-full ${c.swatch} ring-offset-background transition-all ${
                            newBadgeColor === c.value
                              ? 'ring-2 ring-ring ring-offset-2'
                              : 'hover:ring-1 hover:ring-ring hover:ring-offset-1'
                          }`}
                        />
                      ))}
                      <div className="relative">
                        <input
                          type="color"
                          value={isCustomColor(newBadgeColor) ? newBadgeColor : '#6366f1'}
                          onChange={(e) => setNewBadgeColor(e.target.value)}
                          className="absolute inset-0 h-6 w-6 cursor-pointer opacity-0"
                        />
                        <div
                          className={`flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/40 text-muted-foreground/60 ring-offset-background transition-all ${
                            isCustomColor(newBadgeColor)
                              ? 'ring-2 ring-ring ring-offset-2'
                              : 'hover:border-muted-foreground/60'
                          }`}
                          style={isCustomColor(newBadgeColor) ? { backgroundColor: newBadgeColor, borderStyle: 'solid', borderColor: newBadgeColor } : undefined}
                        >
                          {!isCustomColor(newBadgeColor) && <Plus size={10} />}
                        </div>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleAddBadge}
                      disabled={!newBadgeLabel.trim()}
                      className="gap-1"
                    >
                      <Plus size={14} />
                      {t('project_settings.add_badge')}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Organization */}
          <TabsContent value="organization" className="mt-4 space-y-4">
            {/* Current linked org display */}
            {displayOrg && (
              <Card>
                <CardContent className="flex items-start gap-4 p-5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Building2 size={20} className="text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-card-foreground">{displayOrg.name}</p>
                      {displayOrg.type && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {displayOrg.type === 'other' && displayOrg.customType ? displayOrg.customType : t(`workspaces.org_type_${displayOrg.type}`)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {(displayOrg.location || displayOrg.country) && (
                        <span className="flex items-center gap-1">
                          <MapPin size={12} />
                          {[displayOrg.location, displayOrg.country].filter(Boolean).join(', ')}
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
                <CardTitle className="text-base">{t('workspaces.change_organization')}</CardTitle>
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
                        {org.name}
                        {org.type ? ` (${t(`workspaces.org_type_${org.type}`)})` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={handleSaveOrganization}>
                  {t('common.save')}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Danger zone */}
          <TabsContent value="danger" className="mt-4">
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
                            <span className="font-semibold text-foreground font-mono">{wsUid}</span>
                          </p>
                          <Input
                            value={deleteConfirm}
                            onChange={(e) => setDeleteConfirm(e.target.value)}
                            placeholder={wsUid}
                            className="mt-2 font-mono text-sm"
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
                        disabled={deleteConfirm !== wsUid}
                        className="!bg-destructive !text-white hover:!bg-destructive/90 disabled:!opacity-50"
                      >
                        {t('workspaces.delete_workspace')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
