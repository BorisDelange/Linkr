import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOrganizationStore } from '@/stores/organization-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { Plus, Pencil, Trash2, Building2, MapPin, Globe, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { OrganizationInfo } from '@/types'

const ORG_TYPES = ['hospital', 'university', 'research_institute', 'company', 'consortium', 'other'] as const

const emptyOrg: OrganizationInfo = {
  name: '',
  type: '',
  customType: '',
  location: '',
  country: '',
  website: '',
  email: '',
  referenceId: '',
}

export function OrganizationsTab() {
  const { t } = useTranslation()
  const { _organizationsRaw, addOrganization, updateOrganization, deleteOrganization } = useOrganizationStore()
  const { _workspacesRaw } = useWorkspaceStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<OrganizationInfo>({ ...emptyOrg })
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const getLinkedWorkspaceCount = (orgId: string) =>
    _workspacesRaw.filter((ws) => ws.organizationId === orgId).length

  const handleOpenCreate = () => {
    setEditingId(null)
    setForm({ ...emptyOrg })
    setDialogOpen(true)
  }

  const handleOpenEdit = (orgId: string) => {
    const org = _organizationsRaw.find((o) => o.id === orgId)
    if (!org) return
    setEditingId(orgId)
    setForm({
      name: org.name,
      type: org.type ?? '',
      customType: org.customType ?? '',
      location: org.location ?? '',
      country: org.country ?? '',
      website: org.website ?? '',
      email: org.email ?? '',
      referenceId: org.referenceId ?? '',
    })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) return
    if (editingId) {
      await updateOrganization(editingId, form)
    } else {
      await addOrganization(form)
    }
    setDialogOpen(false)
  }

  const handleDelete = async () => {
    if (!deleteId) return
    await deleteOrganization(deleteId)
    setDeleteId(null)
  }

  const deleteOrg = deleteId ? _organizationsRaw.find((o) => o.id === deleteId) : null
  const deleteLinkedCount = deleteId ? getLinkedWorkspaceCount(deleteId) : 0

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {t('settings.organizations_title')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('settings.organizations_description')}
          </p>
        </div>
        <Button size="sm" onClick={handleOpenCreate}>
          <Plus size={16} />
          {t('settings.add_organization')}
        </Button>
      </div>

      {_organizationsRaw.length === 0 ? (
        <Card className="mt-4">
          <CardContent className="flex flex-col items-center py-10">
            <Building2 size={32} className="text-muted-foreground" />
            <p className="mt-3 text-sm font-medium text-muted-foreground">
              {t('settings.no_organizations')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              {t('settings.no_organizations_description')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-4 grid gap-3">
          {_organizationsRaw.map((org) => {
            const linkedCount = getLinkedWorkspaceCount(org.id)
            return (
              <Card key={org.id}>
                <CardContent className="flex items-start gap-4 p-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Building2 size={18} className="text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-card-foreground">{org.name}</p>
                      {org.type && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {org.type === 'other' && org.customType ? org.customType : t(`workspaces.org_type_${org.type}`)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {(org.location || org.country) && (
                        <span className="flex items-center gap-1">
                          <MapPin size={12} />
                          {[org.location, org.country].filter(Boolean).join(', ')}
                        </span>
                      )}
                      {org.website && (
                        <span className="flex items-center gap-1"><Globe size={12} />{org.website}</span>
                      )}
                      {org.email && (
                        <span className="flex items-center gap-1"><Mail size={12} />{org.email}</span>
                      )}
                      <span className="text-muted-foreground/60">
                        {linkedCount} {linkedCount === 1 ? t('workspaces.project_count_one') : t('workspaces.project_count_other')}
                        {' '}{t('settings.organization_linked_workspaces').toLowerCase()}
                      </span>
                    </div>
                    {org.referenceId && (
                      <p className="mt-1 text-[11px] text-muted-foreground/60">
                        ID: {org.referenceId}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground"
                      onClick={() => handleOpenEdit(org.id)}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteId(org.id)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingId ? t('settings.edit_organization') : t('settings.add_organization')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('workspaces.field_org_name')}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('workspaces.field_org_name_placeholder')}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label>{t('workspaces.field_org_type')}</Label>
              <Select value={form.type ?? ''} onValueChange={(v) => setForm({ ...form, type: v, ...(v !== 'other' ? { customType: undefined } : {}) })}>
                <SelectTrigger className="w-full">
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
            {form.type === 'other' && (
              <div className="space-y-2 sm:col-span-2">
                <Label>{t('workspaces.field_org_custom_type')}</Label>
                <Input
                  value={form.customType ?? ''}
                  onChange={(e) => setForm({ ...form, customType: e.target.value })}
                  placeholder={t('workspaces.field_org_custom_type_placeholder')}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>{t('workspaces.field_org_location')}</Label>
              <Input
                value={form.location ?? ''}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder={t('workspaces.field_org_location_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('workspaces.field_org_country')}</Label>
              <Input
                value={form.country ?? ''}
                onChange={(e) => setForm({ ...form, country: e.target.value })}
                placeholder={t('workspaces.field_org_country_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('workspaces.field_org_website')}</Label>
              <Input
                value={form.website ?? ''}
                onChange={(e) => setForm({ ...form, website: e.target.value })}
                placeholder={t('workspaces.field_org_website_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('workspaces.field_org_email')}</Label>
              <Input
                value={form.email ?? ''}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder={t('workspaces.field_org_email_placeholder')}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>{t('workspaces.field_org_reference_id')}</Label>
              <Input
                value={form.referenceId ?? ''}
                onChange={(e) => setForm({ ...form, referenceId: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={!form.name.trim()}>
              {editingId ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.delete_organization')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteLinkedCount > 0
                ? t('settings.delete_organization_has_workspaces', { count: deleteLinkedCount })
                : t('settings.delete_organization_confirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteOrg && (
            <p className="text-sm font-medium">{deleteOrg.name}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('settings.delete_organization')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
