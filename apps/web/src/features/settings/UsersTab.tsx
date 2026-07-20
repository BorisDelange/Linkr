import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Pencil, Plus, Power, PowerOff, Trash2, Users } from 'lucide-react'
import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import { isValidOrcid, normalizeOrcid } from '@/lib/user-identity'
import { localized, localizedRaw, setLocalized, seedLocalizedForEditing, hasLocalizedContent } from '@/lib/localized'
import type { Role, User, UserCreateInput, LocalizedString } from '@/types'
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
import { PasswordInput } from '@/components/ui/password-input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

interface UserDraft {
  username: string
  password: string
  passwordConfirm: string
  role: string
  firstName: string
  lastName: string
  /** Multilingual, like the profile page — edited in the active app language. */
  affiliation: LocalizedString | string
  profession: LocalizedString | string
  orcid: string
}

const emptyDraft: UserDraft = {
  username: '',
  password: '',
  passwordConfirm: '',
  role: 'user',
  firstName: '',
  lastName: '',
  affiliation: '',
  profession: '',
  orcid: '',
}

function draftFromUser(u: User, lang: string): UserDraft {
  return {
    username: u.username,
    password: '',
    passwordConfirm: '',
    role: u.role,
    firstName: u.firstName ?? '',
    lastName: u.lastName ?? '',
    // Pre-fill the active language from the other one when it's blank (convenience);
    // the input then controls the raw value, so it stays clearable.
    affiliation: seedLocalizedForEditing(u.affiliation, lang),
    profession: seedLocalizedForEditing(u.profession, lang),
    orcid: u.orcid ?? '',
  }
}

/** Keep a possibly-multilingual field if it carries any content, else drop it. */
function localizedOrUndefined(v: LocalizedString | string): LocalizedString | string | undefined {
  return hasLocalizedContent(v) ? v : undefined
}

export function UsersTab() {
  const { t, i18n } = useTranslation()
  const [users, setUsers] = useState<User[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [draft, setDraft] = useState<UserDraft>(emptyDraft)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)

  const load = useCallback(async () => {
    const storage = getStorage()
    const [u, r] = await Promise.all([storage.users.getAll(), storage.roles.getAll()])
    setUsers(u)
    setRoles(r)
  }, [])

  useEffect(() => {
    if (!isServerMode()) return
    let cancelled = false
    void (async () => {
      const storage = getStorage()
      const [u, r] = await Promise.all([storage.users.getAll(), storage.roles.getAll()])
      if (!cancelled) { setUsers(u); setRoles(r) }
    })()
    return () => { cancelled = true }
  }, [])

  // Users/roles are server-only (accounts + server-side auth). Mirror the
  // versioning tabs: show a "requires backend" notice in client-only mode.
  if (!isServerMode()) {
    return (
      <div className="flex flex-col items-center py-10">
        <Users size={32} className="text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium text-foreground">{t('settings.users_requires_backend')}</p>
        <div className="mt-3 flex max-w-md items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
          <Info size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-amber-700 dark:text-amber-300">{t('settings.users_requires_backend_description')}</p>
        </div>
      </div>
    )
  }

  const setField = (key: Exclude<keyof UserDraft, 'affiliation' | 'profession'>, value: string) =>
    setDraft((d) => ({ ...d, [key]: value }))
  // affiliation/profession are multilingual: edit the active language, keep the other.
  const setLocalizedField = (key: 'affiliation' | 'profession', value: string) =>
    setDraft((d) => ({ ...d, [key]: setLocalized(d[key], i18n.language, value) }))

  const openAdd = () => {
    setEditing(null)
    setDraft(emptyDraft)
    setError(null)
    setDialogOpen(true)
  }

  const openEdit = (u: User) => {
    setEditing(u)
    setDraft(draftFromUser(u, i18n.language))
    setError(null)
    setDialogOpen(true)
  }

  const roleName = (name: string) => {
    const r = roles.find((x) => x.name === name)
    return r ? localized(r.label, i18n.language) || r.name : name
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.username.trim()) return
    const orcid = draft.orcid.trim() ? normalizeOrcid(draft.orcid) : ''
    if (!isValidOrcid(orcid)) {
      setError(t('settings.invalid_orcid'))
      return
    }
    if (draft.password && draft.password !== draft.passwordConfirm) {
      setError(t('settings.password_mismatch'))
      return
    }
    if (!draft.username.trim()) return
    const fields = {
      role: draft.role,
      firstName: draft.firstName.trim() || undefined,
      lastName: draft.lastName.trim() || undefined,
      affiliation: localizedOrUndefined(draft.affiliation),
      profession: localizedOrUndefined(draft.profession),
      orcid: orcid || undefined,
    }
    try {
      const storage = getStorage()
      if (editing) {
        const changes: Partial<UserCreateInput> = { ...fields }
        if (draft.username.trim() !== editing.username) changes.username = draft.username.trim()
        if (draft.password.trim()) changes.password = draft.password
        await storage.users.update(editing.id, changes)
      } else {
        if (!draft.password.trim()) {
          setError(t('settings.password_required'))
          return
        }
        await storage.users.create({ username: draft.username.trim(), password: draft.password, ...fields })
      }
      setDialogOpen(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const id = deleteTarget.id
    setDeleteTarget(null)
    try {
      await getStorage().users.delete(id)
    } finally {
      // Backend guards (e.g. last admin) surface as a rejected request; reload either way.
      await load()
    }
  }

  const toggleActive = async (u: User) => {
    try {
      await getStorage().users.update(u.id, { isActive: u.isActive === false })
    } finally {
      // Backend refuses to disable the last active admin — reload to reflect the
      // real state whether it succeeded or was rejected.
      await load()
    }
  }

  const roleBadgeVariant = (r: string) => {
    switch (r) {
      case 'admin': return 'default' as const
      case 'editor': return 'secondary' as const
      default: return 'outline' as const
    }
  }

  const adminCount = users.filter((u) => u.role === 'admin').length
  const activeAdminCount = users.filter((u) => u.role === 'admin' && u.isActive !== false).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('settings.users_title')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.users_description')}</p>
        </div>
        <Button size="sm" onClick={openAdd}>
          <Plus size={14} />
          {t('settings.add_user')}
        </Button>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('settings.user_username')}</TableHead>
              <TableHead>{t('profile.first_name')}</TableHead>
              <TableHead>{t('profile.last_name')}</TableHead>
              <TableHead>{t('profile.affiliation')}</TableHead>
              <TableHead>{t('settings.user_role')}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="text-sm font-medium">{user.username}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{user.firstName}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{user.lastName}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{localized(user.affiliation, i18n.language)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Badge variant={roleBadgeVariant(user.role)} className="text-[11px]">
                      {roleName(user.role)}
                    </Badge>
                    {user.isActive === false && (
                      <Badge
                        variant="outline"
                        className="text-[11px] text-amber-600 border-amber-200 bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950"
                      >
                        {t('settings.user_disabled_badge')}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon-xs" onClick={() => openEdit(user)}>
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => toggleActive(user)}
                      // Can't disable the last active admin (backend enforces too).
                      disabled={user.isActive !== false && user.role === 'admin' && activeAdminCount === 1}
                      title={user.isActive === false ? t('settings.user_enable') : t('settings.user_disable')}
                    >
                      {user.isActive === false ? <Power size={14} /> : <PowerOff size={14} />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setDeleteTarget(user)}
                      disabled={user.role === 'admin' && adminCount === 1}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{editing ? t('settings.edit_user') : t('settings.add_user')}</DialogTitle>
              <DialogDescription>{t('settings.add_user_description')}</DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="user-username">{t('settings.user_username')}<RequiredMark /></Label>
                <Input
                  id="user-username"
                  value={draft.username}
                  onChange={(e) => setField('username', e.target.value)}
                  autoFocus={!editing}
                  autoComplete="off"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="user-password">
                    {editing ? t('settings.new_password_optional') : <>{t('settings.temporary_password')}<RequiredMark /></>}
                  </Label>
                  <PasswordInput
                    id="user-password"
                    value={draft.password}
                    autoComplete="new-password"
                    placeholder={editing ? t('settings.leave_blank_keep') : undefined}
                    onChange={(e) => setField('password', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="user-password-confirm">
                    {t('settings.confirm_password')}{!editing && <RequiredMark />}
                  </Label>
                  <PasswordInput
                    id="user-password-confirm"
                    value={draft.passwordConfirm}
                    autoComplete="new-password"
                    placeholder={editing ? t('settings.leave_blank_keep') : undefined}
                    onChange={(e) => setField('passwordConfirm', e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t('settings.user_role')}</Label>
                <Select value={draft.role} onValueChange={(v) => setField('role', v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.filter((r) => r.scope === 'global').map((r) => (
                      <SelectItem key={r.id} value={r.name}>
                        {localized(r.label, i18n.language) || r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="user-first-name">{t('profile.first_name')}</Label>
                  <Input id="user-first-name" value={draft.firstName} onChange={(e) => setField('firstName', e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="user-last-name">{t('profile.last_name')}</Label>
                  <Input id="user-last-name" value={draft.lastName} onChange={(e) => setField('lastName', e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="user-affiliation">{t('profile.affiliation')}</Label>
                <Input
                  id="user-affiliation"
                  value={localizedRaw(draft.affiliation, i18n.language)}
                  placeholder={t('profile.affiliation_placeholder')}
                  onChange={(e) => setLocalizedField('affiliation', e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="user-profession">{t('profile.profession')}</Label>
                  <Input
                    id="user-profession"
                    value={localizedRaw(draft.profession, i18n.language)}
                    placeholder={t('profile.profession_placeholder')}
                    onChange={(e) => setLocalizedField('profession', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="user-orcid">{t('profile.orcid')}</Label>
                  <Input
                    id="user-orcid"
                    value={draft.orcid}
                    placeholder="0000-0000-0000-0000"
                    onChange={(e) => setField('orcid', e.target.value)}
                  />
                </div>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!draft.username.trim()}>
                {editing ? t('common.save') : t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.delete_user')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.delete_user_confirm')}{' '}
              <span className="font-semibold text-foreground">{deleteTarget?.username}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
