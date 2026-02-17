import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { OrganizationInfo } from '@/types'

interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const ORG_TYPES = ['hospital', 'university', 'research_institute', 'company', 'consortium', 'other'] as const

const emptyOrg: OrganizationInfo = {
  name: '',
  type: '',
  location: '',
  country: '',
  website: '',
  email: '',
  referenceId: '',
}

export function CreateWorkspaceDialog({ open, onOpenChange }: CreateWorkspaceDialogProps) {
  const { t } = useTranslation()
  const { addWorkspace, getUniqueOrganizations } = useWorkspaceStore()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [org, setOrg] = useState<OrganizationInfo>({ ...emptyOrg })
  const [pickExisting, setPickExisting] = useState<string>('new')

  const existingOrgs = getUniqueOrganizations()

  const handlePickOrg = (value: string) => {
    setPickExisting(value)
    if (value === 'new') {
      setOrg({ ...emptyOrg })
    } else {
      const existing = existingOrgs.find((o) => o.name === value)
      if (existing) {
        setOrg({ ...existing })
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !org.name.trim()) return
    await addWorkspace({
      name: name.trim(),
      description: description.trim(),
      organization: org,
    })
    setName('')
    setDescription('')
    setOrg({ ...emptyOrg })
    setPickExisting('new')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('workspaces.create_dialog_title')}</DialogTitle>
            <DialogDescription>{t('workspaces.create_dialog_description')}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            {/* Workspace fields */}
            <div className="space-y-2">
              <Label htmlFor="ws-name">{t('workspaces.field_name')}</Label>
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
              <Textarea
                id="ws-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('workspaces.field_description_placeholder')}
                rows={2}
              />
            </div>

            {/* Organization section */}
            <div className="border-t pt-4">
              <Label className="text-sm font-medium">{t('workspaces.organization_section')}</Label>

              {existingOrgs.length > 0 && (
                <div className="mt-2 space-y-2">
                  <Label htmlFor="ws-org-pick" className="text-xs text-muted-foreground">
                    {t('workspaces.pick_existing_org')}
                  </Label>
                  <Select value={pickExisting} onValueChange={handlePickOrg}>
                    <SelectTrigger id="ws-org-pick">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">{t('workspaces.new_organization')}</SelectItem>
                      {existingOrgs.map((o) => (
                        <SelectItem key={o.name} value={o.name}>
                          {o.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="ws-org-name">{t('workspaces.field_org_name')}</Label>
                  <Input
                    id="ws-org-name"
                    value={org.name}
                    onChange={(e) => setOrg({ ...org, name: e.target.value })}
                    placeholder={t('workspaces.field_org_name_placeholder')}
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
                    placeholder={t('workspaces.field_org_location_placeholder')}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ws-org-country">{t('workspaces.field_org_country')}</Label>
                  <Input
                    id="ws-org-country"
                    value={org.country ?? ''}
                    onChange={(e) => setOrg({ ...org, country: e.target.value })}
                    placeholder={t('workspaces.field_org_country_placeholder')}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ws-org-website">{t('workspaces.field_org_website')}</Label>
                  <Input
                    id="ws-org-website"
                    value={org.website ?? ''}
                    onChange={(e) => setOrg({ ...org, website: e.target.value })}
                    placeholder={t('workspaces.field_org_website_placeholder')}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ws-org-email">{t('workspaces.field_org_email')}</Label>
                  <Input
                    id="ws-org-email"
                    value={org.email ?? ''}
                    onChange={(e) => setOrg({ ...org, email: e.target.value })}
                    placeholder={t('workspaces.field_org_email_placeholder')}
                  />
                </div>
              </div>
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || !org.name.trim()}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
