import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, Unlock } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import { useUserDirectoryStore, toDetails } from '@/stores/user-directory-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useAppStore } from '@/stores/app-store'
import type { AuthorDetails } from '@/types/author'
import type { OrganizationInfo, Organization } from '@/types'

/** The authoring provenance an entity carries. */
export interface AuthoringValue {
  createdById?: number
  createdBy?: string
  createdByDetails?: AuthorDetails
  organization?: OrganizationInfo
}

interface AuthoringFieldsProps {
  value: AuthoringValue
  /** Emits the fields that changed. Author fields are set together; organization
   *  on its own. Absent keys mean "unchanged". */
  onChange: (patch: Partial<AuthoringValue>) => void
  /** Hide the organization field. Used for the workspace, whose org is a live
   *  link (organizationId) edited elsewhere, not a frozen provenance snapshot. */
  hideOrganization?: boolean
}

function authorDisplay(v: AuthoringValue, resolve: (id: number) => string): string {
  if (v.createdById != null) {
    const name = resolve(v.createdById)
    if (name) return name
  }
  const full = [v.createdByDetails?.firstName, v.createdByDetails?.lastName].filter(Boolean).join(' ')
  return full || v.createdBy || ''
}

/** A field that shows a greyed-out original value with a lock toggle; unlocking
 *  swaps it for a dropdown so the value can be re-attributed. */
function LockableField({
  label, locked, onToggle, current, children, t,
}: {
  label: string
  locked: boolean
  onToggle: () => void
  current: string
  children: React.ReactNode
  t: (k: string) => string
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {locked ? (
            <Input value={current} disabled placeholder={t('common.none')} className="text-muted-foreground" />
          ) : (
            children
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggle}
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent',
                !locked && 'border-primary/50 text-primary',
              )}
            >
              {locked ? <Lock size={15} /> : <Unlock size={15} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {locked ? t('authoring.unlock_hint') : t('authoring.lock_hint')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

/**
 * Editable authoring provenance (author + organization) for an entity's Edit
 * dialog. Both fields start locked, showing the original values greyed out —
 * nothing changes unless the user unlocks. Unlocking turns the field into a
 * dropdown to re-attribute: authors come from the user directory, organizations
 * from the org store; picking one writes a frozen snapshot (name/details) onto
 * the entity, mirroring how provenance is stored elsewhere.
 */
export function AuthoringFields({ value, onChange, hideOrganization }: AuthoringFieldsProps) {
  const { t, i18n } = useTranslation()
  const directory = useUserDirectoryStore((s) => s.byId)
  const resolveName = useUserDirectoryStore((s) => s.resolveName)
  const organizations = useOrganizationStore((s) => s._organizationsRaw)
  const currentUserId = useAppStore((s) => s.user?.id)

  const [authorUnlocked, setAuthorUnlocked] = useState(false)
  const [orgUnlocked, setOrgUnlocked] = useState(false)

  const users = Object.values(directory).sort((a, b) =>
    (resolveName(a.id) || a.username).localeCompare(resolveName(b.id) || b.username))

  const authorCurrent = authorDisplay(value, resolveName)
  const orgCurrent = value.organization ? localized(value.organization.name, i18n.language) : ''
  const orgSelectedId = value.organization && 'id' in value.organization
    ? (value.organization as Organization).id
    : undefined

  const authorSelectedId = value.createdById ?? currentUserId

  const pickAuthor = (idStr: string) => {
    const id = Number(idStr)
    const u = directory[id]
    if (!u) return
    const details = toDetails(u)
    const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
    onChange({ createdById: id, createdBy: full || u.username, createdByDetails: details })
  }

  const pickOrg = (id: string) => {
    const org = organizations.find((o) => o.id === id)
    if (org) onChange({ organization: org })
  }

  // Unlocking commits whatever the dropdown already shows, so that simply
  // unlocking (without re-picking the same, pre-selected value — which Radix
  // Select won't fire onValueChange for) counts as a re-attribution.
  const toggleAuthor = () => {
    setAuthorUnlocked((u) => {
      if (!u && authorSelectedId != null) pickAuthor(String(authorSelectedId))
      return !u
    })
  }

  const toggleOrg = () => {
    setOrgUnlocked((u) => {
      if (!u && orgSelectedId != null) pickOrg(orgSelectedId)
      return !u
    })
  }

  return (
    <div className="space-y-4">
      <LockableField
        label={t('authoring.author')}
        locked={!authorUnlocked}
        onToggle={toggleAuthor}
        current={authorCurrent}
        t={t}
      >
        <Select value={authorSelectedId != null ? String(authorSelectedId) : undefined} onValueChange={pickAuthor}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('authoring.select_author')} />
          </SelectTrigger>
          <SelectContent>
            {users.map((u) => (
              <SelectItem key={u.id} value={String(u.id)}>{resolveName(u.id) || u.username}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </LockableField>

      {!hideOrganization && (
      <LockableField
        label={t('common.organization')}
        locked={!orgUnlocked}
        onToggle={toggleOrg}
        current={orgCurrent}
        t={t}
      >
        <Select value={orgSelectedId} onValueChange={pickOrg}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('authoring.select_organization')} />
          </SelectTrigger>
          <SelectContent>
            {organizations.map((o) => (
              <SelectItem key={o.id} value={o.id}>{localized(o.name, i18n.language) || o.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </LockableField>
      )}
    </div>
  )
}
