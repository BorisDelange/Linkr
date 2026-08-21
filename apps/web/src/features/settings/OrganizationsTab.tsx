import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOrganizationStore } from '@/stores/organization-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { localized, localizedRaw, setLocalized, seedLocalizedForEditing } from '@/lib/localized'
import { LangHint } from '@/components/ui/lang-hint'
import { useSaveForm } from '@/hooks/use-save-form'
import { Plus, Pencil, Trash2, Building2, MapPin, Globe, Mail, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DialogShell } from '@/components/ui/dialog-shell'
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

// Localized fields start as {} (not ''): setLocalized('') would seed every language
// with an empty string ({ en: v, fr: '' }), and a defined-but-empty `fr` then
// defeats the en-fallback in localized() — the French view reads blank. Starting
// from {}, setLocalized yields { en: v } and the fallback works, matching how every
// other create dialog behaves.
const emptyOrg: OrganizationInfo = {
  name: {},
  type: '',
  customType: {},
  location: {},
  country: {},
  website: '',
  email: '',
  referenceId: '',
}

export function OrganizationsTab() {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const { _organizationsRaw, addOrganization, updateOrganization, deleteOrganization } = useOrganizationStore()
  const { _workspacesRaw } = useWorkspaceStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<OrganizationInfo>({ ...emptyOrg })
  const [baseline, setBaseline] = useState<OrganizationInfo>({ ...emptyOrg })
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const getLinkedWorkspaceCount = (orgId: string) =>
    _workspacesRaw.filter((ws) => ws.organizationId === orgId).length

  const handleOpenCreate = () => {
    setEditingId(null)
    setForm({ ...emptyOrg })
    setBaseline({ ...emptyOrg })
    setDialogOpen(true)
  }

  const handleOpenEdit = (orgId: string) => {
    const org = _organizationsRaw.find((o) => o.id === orgId)
    if (!org) return
    setEditingId(orgId)
    const values: OrganizationInfo = {
      // Localized fields: pre-fill the active language from the other one when blank
      // (convenience), so the field isn't empty just because it was only entered in
      // one language. The input controls the raw value, so it stays clearable.
      // Seed into baseline too, else this pre-fill would show as an unsaved change.
      name: seedLocalizedForEditing(org.name, language),
      type: org.type ?? '',
      customType: seedLocalizedForEditing(org.customType, language),
      location: seedLocalizedForEditing(org.location, language),
      country: seedLocalizedForEditing(org.country, language),
      website: org.website ?? '',
      email: org.email ?? '',
      referenceId: org.referenceId ?? '',
    }
    setForm(values)
    setBaseline(values)
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!localized(form.name, language).trim()) return
    if (editingId) {
      await updateOrganization(editingId, form)
    } else {
      await addOrganization(form)
    }
    setDialogOpen(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: form,
    baseline,
    onSave: handleSave,
    // A brand-new org has an empty baseline, so "dirty" already covers it;
    // require a non-empty name to enable Save.
    canSave: !!localized(form.name, language).trim(),
  })

  const [deleteConfirm, setDeleteConfirm] = useState('')

  const handleDelete = async () => {
    if (!deleteId) return
    await deleteOrganization(deleteId)
    setDeleteId(null)
    setDeleteConfirm('')
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
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {_organizationsRaw.map((org) => {
            const linkedCount = getLinkedWorkspaceCount(org.id)
            return (
              <Card
                key={org.id}
                className="cursor-pointer transition-colors hover:bg-accent/50"
                onClick={() => handleOpenEdit(org.id)}
              >
                <CardContent className="flex items-start gap-4 p-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Building2 size={18} className="text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-card-foreground">{localized(org.name, language)}</p>
                      {org.type && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {org.type === 'other' && org.customType ? localized(org.customType, language) : t(`workspaces.org_type_${org.type}`)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {(org.location || org.country) && (
                        <span className="flex items-center gap-1">
                          <MapPin size={12} />
                          {[localized(org.location, language), localized(org.country, language)].filter(Boolean).join(', ')}
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
                  <div className="flex shrink-0" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                          <MoreHorizontal size={16} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleOpenEdit(org.id)}>
                          <Pencil size={14} />
                          {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleteId(org.id)}
                        >
                          <Trash2 size={14} />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Create / Edit dialog */}
      <DialogShell
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        kind="settings"
        title={editingId ? t('settings.edit_organization') : t('settings.add_organization')}
        onConfirm={save}
        confirmLabel={editingId ? t('common.save') : t('common.create')}
        confirmDisabled={!canSaveNow}
      >
          <div
            className="grid gap-3 sm:grid-cols-2"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
                e.preventDefault()
                save()
              }
            }}
          >
            <div className="space-y-2">
              <Label>
                {t('workspaces.field_org_name')}
                <LangHint lang={language} />
              </Label>
              <Input
                value={localizedRaw(form.name, language)}
                onChange={(e) => setForm({ ...form, name: setLocalized(form.name, language, e.target.value) })}
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
                <Label>
                  {t('workspaces.field_org_custom_type')}
                  <LangHint lang={language} />
                </Label>
                <Input
                  value={localizedRaw(form.customType, language)}
                  onChange={(e) => setForm({ ...form, customType: setLocalized(form.customType, language, e.target.value) })}
                  placeholder={t('workspaces.field_org_custom_type_placeholder')}
                />
              </div>
            )}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label>{t('workspaces.field_org_location')}</Label>
                <LangHint lang={language} />
              </div>
              <Input
                value={localizedRaw(form.location, language)}
                onChange={(e) => setForm({ ...form, location: setLocalized(form.location, language, e.target.value) })}
                placeholder={t('workspaces.field_org_location_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label>{t('workspaces.field_org_country')}</Label>
                <LangHint lang={language} />
              </div>
              <Input
                value={localizedRaw(form.country, language)}
                onChange={(e) => setForm({ ...form, country: setLocalized(form.country, language, e.target.value) })}
                placeholder={t('workspaces.field_org_country_placeholder')}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>{t('workspaces.field_org_website')}</Label>
              <Input
                value={form.website ?? ''}
                onChange={(e) => setForm({ ...form, website: e.target.value })}
                placeholder={t('workspaces.field_org_website_placeholder')}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
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
      </DialogShell>

      {/* Delete confirmation — type the name to confirm */}
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(open) => { if (!open) { setDeleteId(null); setDeleteConfirm('') } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.delete_organization')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {deleteLinkedCount > 0 && (
                  <span className="block">
                    {t('settings.delete_organization_has_workspaces', { count: deleteLinkedCount })}
                    <br />
                    {t('settings.delete_organization_removes_link')}
                  </span>
                )}
                <span className="block">
                  {t('settings.delete_organization_confirm')}{' '}
                  <span className="font-semibold text-foreground">{localized(deleteOrg?.name, language)}</span>
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            placeholder={localized(deleteOrg?.name, language)}
            autoFocus
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteConfirm !== localized(deleteOrg?.name, language)}
              className="bg-destructive text-white hover:bg-destructive/90 disabled:opacity-50"
            >
              {t('settings.delete_organization')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
