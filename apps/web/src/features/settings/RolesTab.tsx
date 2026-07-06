import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCheck, Info, Plus, Shield, SquareX, Trash2 } from 'lucide-react'
import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import { localized } from '@/lib/localized'
import type { Permission, Role } from '@/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** Group "resource:action" strings by resource, preserving catalogue order. */
function groupByResource(perms: Permission[]): { resource: string; actions: string[] }[] {
  const order: string[] = []
  const byResource = new Map<string, string[]>()
  for (const p of perms) {
    const [resource, action] = p.split(':')
    if (!byResource.has(resource)) {
      byResource.set(resource, [])
      order.push(resource)
    }
    byResource.get(resource)!.push(action)
  }
  return order.map((resource) => ({ resource, actions: byResource.get(resource)! }))
}

export function RolesTab() {
  const { t, i18n } = useTranslation()
  const [roles, setRoles] = useState<Role[]>([])
  const [catalogue, setCatalogue] = useState<Permission[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null)

  const load = useCallback(async () => {
    const storage = getStorage()
    const [r, perms] = await Promise.all([storage.roles.getAll(), storage.roles.getPermissions()])
    setRoles(r)
    setCatalogue(perms)
  }, [])

  useEffect(() => {
    if (!isServerMode()) return
    let cancelled = false
    void (async () => {
      const storage = getStorage()
      const [r, perms] = await Promise.all([storage.roles.getAll(), storage.roles.getPermissions()])
      if (!cancelled) { setRoles(r); setCatalogue(perms) }
    })()
    return () => { cancelled = true }
  }, [])

  const groups = useMemo(() => groupByResource(catalogue), [catalogue])

  // Show built-in roles first, most→least privileged; custom roles after.
  const sortedRoles = useMemo(() => {
    const rank = new Map(['admin', 'owner', 'editor', 'user', 'viewer'].map((n, i) => [n, i]))
    const rankOf = (r: Role) => (rank.has(r.name) ? rank.get(r.name)! : Number.MAX_SAFE_INTEGER)
    return [...roles].sort((a, b) => rankOf(a) - rankOf(b))
  }, [roles])

  if (!isServerMode()) {
    return (
      <div className="flex flex-col items-center py-10">
        <Shield size={32} className="text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium text-foreground">{t('settings.roles_requires_backend')}</p>
        <div className="mt-3 flex max-w-md items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
          <Info size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-amber-700 dark:text-amber-300">{t('settings.roles_requires_backend_description')}</p>
        </div>
      </div>
    )
  }

  // Optimistically reflect a new permission set for a role, then persist it.
  const persistPermissions = async (role: Role, permissions: Permission[]) => {
    setRoles((rs) => rs.map((r) => (r.id === role.id ? { ...r, permissions } : r)))
    try {
      await getStorage().roles.update(role.id, { permissions })
    } catch {
      await load()
    }
  }

  const togglePermission = (role: Role, permission: Permission, checked: boolean) =>
    persistPermissions(
      role,
      checked ? [...role.permissions, permission] : role.permissions.filter((p) => p !== permission),
    )

  const setAllForRole = (role: Role, all: boolean) =>
    persistPermissions(role, all ? [...catalogue] : [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    try {
      await getStorage().roles.create({
        name,
        label: newLabel.trim() ? { en: newLabel.trim() } : {},
        scope: 'workspace',
        permissions: [],
      })
      setAddOpen(false)
      setNewName('')
      setNewLabel('')
      setError(null)
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
      await getStorage().roles.delete(id)
    } finally {
      await load()
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('settings.roles_title')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.roles_description')}</p>
        </div>
        <Button size="sm" onClick={() => { setError(null); setAddOpen(true) }}>
          <Plus size={14} />
          {t('settings.add_role')}
        </Button>
      </div>

      <TooltipProvider>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="sticky left-0 z-10 w-56 bg-muted/40 px-3 py-2 text-left font-medium">
                {t('settings.permission')}
              </th>
              {sortedRoles.map((role) => {
                const displayName = localized(role.label, i18n.language) || role.name
                return (
                  <th key={role.id} className="w-28 px-2 py-2 align-top font-medium">
                    <div className="flex flex-col items-center gap-1">
                      {/* Line 1: name, truncated with a full-text tooltip on hover. */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="block w-full truncate text-center">{displayName}</span>
                        </TooltipTrigger>
                        <TooltipContent>{displayName}</TooltipContent>
                      </Tooltip>
                      {/* Line 2: system badge or delete action. */}
                      <div className="flex h-6 items-center">
                        {role.isSystem ? (
                          <Badge variant="outline" className="text-[10px]">{t('settings.role_system')}</Badge>
                        ) : (
                          <Button variant="ghost" size="icon-xs" onClick={() => setDeleteTarget(role)} title={t('common.delete')}>
                            <Trash2 size={12} />
                          </Button>
                        )}
                      </div>
                      {/* Line 3: select-all / select-none. */}
                      <div className="flex items-center gap-0.5 text-muted-foreground">
                        <Button variant="ghost" size="icon-xs" onClick={() => setAllForRole(role, true)} title={t('common.select_all')}>
                          <CheckCheck size={13} />
                        </Button>
                        <Button variant="ghost" size="icon-xs" onClick={() => setAllForRole(role, false)} title={t('common.select_none')}>
                          <SquareX size={13} />
                        </Button>
                      </div>
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.resource}>
                <tr className="border-b bg-muted/20">
                  <td className="sticky left-0 z-10 w-56 bg-muted/20 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(`settings.resource_${group.resource}`, group.resource)}
                  </td>
                  <td colSpan={roles.length} className="bg-muted/20" />
                </tr>
                {group.actions.map((action) => {
                  const permission = `${group.resource}:${action}`
                  return (
                    <tr key={permission} className="border-b last:border-0">
                      <td className="sticky left-0 z-10 bg-background px-3 py-1.5 pl-6 text-muted-foreground">
                        {t(`settings.action_${action}`, action)}
                      </td>
                      {sortedRoles.map((role) => (
                        <td key={role.id} className="px-3 py-1.5 text-center">
                          <Checkbox
                            checked={role.permissions.includes(permission)}
                            onCheckedChange={(v) => togglePermission(role, permission, v === true)}
                          />
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      </TooltipProvider>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleAdd}>
            <DialogHeader>
              <DialogTitle>{t('settings.add_role')}</DialogTitle>
              <DialogDescription>{t('settings.add_role_description')}</DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="role-name">{t('settings.role_name')}<RequiredMark /></Label>
                <Input id="role-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="data-scientist" autoFocus />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role-label">{t('settings.role_label')}</Label>
                <Input id="role-label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder={t('settings.role_label_placeholder')} />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!newName.trim()}>
                {t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.delete_role')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.delete_role_confirm')}{' '}
              <span className="font-semibold text-foreground">
                {deleteTarget ? (localized(deleteTarget.label, i18n.language) || deleteTarget.name) : ''}
              </span>
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
