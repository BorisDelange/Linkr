import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Plus, Shield, Trash2 } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'

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

  const togglePermission = async (role: Role, permission: Permission, checked: boolean) => {
    const permissions = checked
      ? [...role.permissions, permission]
      : role.permissions.filter((p) => p !== permission)
    // Optimistic: reflect the toggle immediately, then persist.
    setRoles((rs) => rs.map((r) => (r.id === role.id ? { ...r, permissions } : r)))
    try {
      await getStorage().roles.update(role.id, { permissions })
    } catch {
      await load()
    }
  }

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

  const handleDelete = async (role: Role) => {
    try {
      await getStorage().roles.delete(role.id)
      await load()
    } catch {
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

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium">
                {t('settings.permission')}
              </th>
              {roles.map((role) => (
                <th key={role.id} className="px-3 py-2 text-center font-medium">
                  <div className="flex flex-col items-center gap-1">
                    <span>{localized(role.label, i18n.language) || role.name}</span>
                    {role.isSystem ? (
                      <Badge variant="outline" className="text-[10px]">{t('settings.role_system')}</Badge>
                    ) : (
                      <Button variant="ghost" size="icon-xs" onClick={() => handleDelete(role)} title={t('common.delete')}>
                        <Trash2 size={12} />
                      </Button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.resource}>
                <tr className="border-b bg-muted/20">
                  <td colSpan={roles.length + 1} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(`settings.resource_${group.resource}`, group.resource)}
                  </td>
                </tr>
                {group.actions.map((action) => {
                  const permission = `${group.resource}:${action}`
                  return (
                    <tr key={permission} className="border-b last:border-0">
                      <td className="sticky left-0 z-10 bg-background px-3 py-1.5 pl-6 text-muted-foreground">
                        {t(`settings.action_${action}`, action)}
                      </td>
                      {roles.map((role) => (
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

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleAdd}>
            <DialogHeader>
              <DialogTitle>{t('settings.add_role')}</DialogTitle>
              <DialogDescription>{t('settings.add_role_description')}</DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="role-name">{t('settings.role_name')}</Label>
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
    </div>
  )
}
