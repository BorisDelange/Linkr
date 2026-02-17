import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import type { OrganizationInfo } from '@/types'

const ORG_TYPES = ['hospital', 'university', 'research_institute', 'company', 'consortium', 'other'] as const

export function WorkspaceSettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useParams()
  const language = useAppStore((s) => s.language)
  const { _workspacesRaw, updateWorkspace, deleteWorkspace, closeWorkspace } = useWorkspaceStore()

  const workspace = _workspacesRaw.find((ws) => ws.id === wsUid)

  const [name, setName] = useState(workspace?.name[language] ?? workspace?.name['en'] ?? '')
  const [description, setDescription] = useState(workspace?.description[language] ?? workspace?.description['en'] ?? '')
  const [org, setOrg] = useState<OrganizationInfo>(workspace?.organization ?? { name: '' })
  const [deleteConfirm, setDeleteConfirm] = useState('')

  if (!workspace || !wsUid) return null

  const handleSaveGeneral = async () => {
    await updateWorkspace(wsUid, {
      name: { ...workspace.name, [language]: name },
      description: { ...workspace.description, [language]: description },
    })
  }

  const handleSaveOrganization = async () => {
    await updateWorkspace(wsUid, { organization: org })
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

        <Tabs defaultValue="general" className="mt-6">
          <TabsList>
            <TabsTrigger value="general">{t('workspaces.tab_general')}</TabsTrigger>
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

          {/* Organization */}
          <TabsContent value="organization" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('workspaces.organization_section')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="ws-org-name">{t('workspaces.field_org_name')}</Label>
                    <Input
                      id="ws-org-name"
                      value={org.name}
                      onChange={(e) => setOrg({ ...org, name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ws-org-type">{t('workspaces.field_org_type')}</Label>
                    <Select value={org.type ?? ''} onValueChange={(v) => setOrg({ ...org, type: v })}>
                      <SelectTrigger id="ws-org-type">
                        <SelectValue placeholder={t('workspaces.field_org_type_placeholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {ORG_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {t(`workspaces.org_type_${type}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ws-org-location">{t('workspaces.field_org_location')}</Label>
                    <Input
                      id="ws-org-location"
                      value={org.location ?? ''}
                      onChange={(e) => setOrg({ ...org, location: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ws-org-country">{t('workspaces.field_org_country')}</Label>
                    <Input
                      id="ws-org-country"
                      value={org.country ?? ''}
                      onChange={(e) => setOrg({ ...org, country: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ws-org-website">{t('workspaces.field_org_website')}</Label>
                    <Input
                      id="ws-org-website"
                      value={org.website ?? ''}
                      onChange={(e) => setOrg({ ...org, website: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ws-org-email">{t('workspaces.field_org_email')}</Label>
                    <Input
                      id="ws-org-email"
                      value={org.email ?? ''}
                      onChange={(e) => setOrg({ ...org, email: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="ws-org-ref">{t('workspaces.field_org_reference_id')}</Label>
                    <Input
                      id="ws-org-ref"
                      value={org.referenceId ?? ''}
                      onChange={(e) => setOrg({ ...org, referenceId: e.target.value })}
                    />
                  </div>
                </div>
                <Button onClick={handleSaveOrganization} disabled={!org.name.trim()}>
                  {t('common.save')}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Danger zone */}
          <TabsContent value="danger" className="mt-4">
            <Card className="border-destructive/30">
              <CardHeader>
                <CardTitle className="text-base text-destructive">
                  {t('workspaces.delete_workspace')}
                </CardTitle>
                <CardDescription>
                  {t('workspaces.delete_workspace_description')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive">{t('workspaces.delete_workspace')}</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('workspaces.delete_workspace')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('workspaces.delete_workspace_description')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="space-y-2 py-2">
                      <Label>{t('workspaces.delete_workspace_confirm')}</Label>
                      <Input
                        value={deleteConfirm}
                        onChange={(e) => setDeleteConfirm(e.target.value)}
                        placeholder={wsDisplayName}
                      />
                    </div>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDelete}
                        disabled={deleteConfirm !== wsDisplayName}
                        className="bg-destructive text-white hover:bg-destructive/90"
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
