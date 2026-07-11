import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCheck,
  Info,
  Pencil,
  Plus,
  Shield,
  SquareX,
  Trash2,
  Building2,
  FolderOpen,
  BookOpen,
  Users,
  UserCog,
  Database,
  UsersRound,
  Table2,
  BarChart3,
  ShieldHalf,
  Building,
  Layers,
  Puzzle,
  FileSpreadsheet,
  ArrowRightLeft,
  SquareTerminal,
  ShieldCheck,
  Workflow,
  LayoutDashboard,
  Code,
  User,
  FileText,
  type LucideIcon,
} from 'lucide-react'
import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import { localized, setLocalized } from '@/lib/localized'
import { useSaveForm } from '@/hooks/use-save-form'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/** Resources that gate the account instance-wide rather than a single workspace. */
const GLOBAL_RESOURCES = new Set([
  'users',
  'roles',
  'organizations',
  'app-database',
  'all-workspaces',
  'all-projects',
])

const resourceOf = (permission: Permission) => permission.split(':')[0]
const isGlobalPermission = (permission: Permission) => GLOBAL_RESOURCES.has(resourceOf(permission))

/** Resources that carry an explanatory tooltip (settings.resource_hint_<r>). */
const RESOURCE_HINTS = new Set(['all-workspaces', 'all-projects'])

/** Per-resource icon + color, mirroring the sidebar so a resource is easy to
 *  place. Icons/colors match the corresponding sidebar nav item. */
const RESOURCE_META: Record<string, { icon: LucideIcon; color: string }> = {
  // Workspace section (sidebar colors: teal = warehouse).
  workspaces: { icon: Building2, color: 'text-amber-500' },
  members: { icon: Users, color: 'text-amber-500' },
  projects: { icon: FolderOpen, color: 'text-blue-700' },
  wiki: { icon: BookOpen, color: 'text-emerald-500' },
  plugins: { icon: Puzzle, color: 'text-pink-500' },
  schemas: { icon: FileSpreadsheet, color: 'text-teal-500' },
  databases: { icon: Database, color: 'text-teal-500' },
  'concept-mapping': { icon: ArrowRightLeft, color: 'text-teal-500' },
  'sql-scripts': { icon: SquareTerminal, color: 'text-teal-500' },
  'data-quality': { icon: ShieldCheck, color: 'text-teal-500' },
  catalog: { icon: BookOpen, color: 'text-teal-500' },
  etl: { icon: Workflow, color: 'text-teal-500' },
  // Project section (blue = project chrome, teal = warehouse, rose = lab).
  'project-members': { icon: UserCog, color: 'text-blue-700' },
  summary: { icon: LayoutDashboard, color: 'text-blue-500' },
  ide: { icon: Code, color: 'text-violet-500' },
  pipeline: { icon: Workflow, color: 'text-orange-500' },
  'project-databases': { icon: Database, color: 'text-teal-500' },
  concepts: { icon: BookOpen, color: 'text-teal-500' },
  cohorts: { icon: UsersRound, color: 'text-teal-500' },
  'patient-data': { icon: User, color: 'text-teal-500' },
  datasets: { icon: Table2, color: 'text-rose-500' },
  dashboards: { icon: BarChart3, color: 'text-rose-500' },
  reports: { icon: FileText, color: 'text-rose-500' },
  // Global-tier resources.
  users: { icon: Users, color: 'text-blue-500' },
  roles: { icon: ShieldHalf, color: 'text-slate-500' },
  organizations: { icon: Building, color: 'text-amber-500' },
  'app-database': { icon: Database, color: 'text-slate-500' },
  'all-workspaces': { icon: Building2, color: 'text-amber-500' },
  'all-projects': { icon: Layers, color: 'text-blue-700' },
}

/** Workspace-tier resources split into two visual sections (sidebar order).
 *  This is presentation only — the enforcement tier is unchanged. */
const WORKSPACE_SECTIONS: { key: string; resources: string[] }[] = [
  {
    key: 'workspace',
    resources: [
      'workspaces', 'members', 'projects', 'wiki', 'plugins', 'schemas',
      'databases', 'concept-mapping', 'sql-scripts', 'data-quality', 'catalog', 'etl',
    ],
  },
  {
    key: 'project',
    resources: [
      'project-members', 'summary', 'ide', 'pipeline', 'project-databases',
      'concepts', 'cohorts', 'patient-data', 'datasets', 'dashboards', 'reports',
    ],
  },
]

type Draft = Record<string, Permission[]>

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

/** Built-in roles first, most→least privileged; custom roles after. */
function sortRoles(roles: Role[]): Role[] {
  const rank = new Map(['admin', 'owner', 'editor', 'user', 'viewer'].map((n, i) => [n, i]))
  const rankOf = (r: Role) => (rank.has(r.name) ? rank.get(r.name)! : Number.MAX_SAFE_INTEGER)
  return [...roles].sort((a, b) => rankOf(a) - rankOf(b))
}

interface RoleMatrixProps {
  description: string
  roles: Role[]
  /** Permission catalogue restricted to this section's scope. */
  catalogue: Permission[]
  /** Optional visual sections (workspace/project), rendered as banded groups. */
  sections?: { key: string; resources: string[] }[]
  draft: Draft
  onToggle: (roleId: string, permission: Permission, checked: boolean) => void
  onSetAll: (roleId: string, permissions: Permission[]) => void
  onEdit: (role: Role) => void
  onDelete: (role: Role) => void
}

function RoleMatrix({ description, roles, catalogue, sections, draft, onToggle, onSetAll, onEdit, onDelete }: RoleMatrixProps) {
  const { t, i18n } = useTranslation()
  const rawGroups = useMemo(() => groupByResource(catalogue), [catalogue])

  // Order groups by section (sidebar order) and tag each with its section head,
  // so the body can render a section band before its first resource.
  const groups = useMemo(() => {
    if (!sections) return rawGroups.map((g) => ({ ...g, sectionKey: undefined as string | undefined }))
    const byResource = new Map(rawGroups.map((g) => [g.resource, g]))
    const ordered: { resource: string; actions: string[]; sectionKey: string | undefined }[] = []
    for (const section of sections) {
      let first = true
      for (const resource of section.resources) {
        const g = byResource.get(resource)
        if (!g) continue
        ordered.push({ ...g, sectionKey: first ? section.key : undefined })
        first = false
      }
    }
    return ordered
  }, [rawGroups, sections])

  if (roles.length === 0) return null

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{description}</p>
      <TooltipProvider>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="sticky left-0 z-10 w-56 bg-muted/40 px-3 py-2 text-left font-medium">
                  {t('settings.permission')}
                </th>
                {roles.map((role) => {
                  const displayName = localized(role.label, i18n.language) || role.name
                  return (
                    <th key={role.id} className="w-28 px-2 py-2 align-top font-medium">
                      <div className="flex flex-col items-center gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block w-full truncate text-center">{displayName}</span>
                          </TooltipTrigger>
                          <TooltipContent>{displayName}</TooltipContent>
                        </Tooltip>
                        <div className="flex h-6 items-center gap-0.5">
                          <Button variant="ghost" size="icon-xs" onClick={() => onEdit(role)} title={t('common.rename')}>
                            <Pencil size={12} />
                          </Button>
                          {role.isSystem ? (
                            <Badge variant="outline" className="text-[10px]">{t('settings.role_system')}</Badge>
                          ) : (
                            <Button variant="ghost" size="icon-xs" onClick={() => onDelete(role)} title={t('common.delete')}>
                              <Trash2 size={12} />
                            </Button>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 text-muted-foreground">
                          <Button variant="ghost" size="icon-xs" onClick={() => onSetAll(role.id, [...catalogue])} title={t('common.select_all')}>
                            <CheckCheck size={13} />
                          </Button>
                          <Button variant="ghost" size="icon-xs" onClick={() => onSetAll(role.id, [])} title={t('common.select_none')}>
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
              {groups.map((group) => {
                const meta = RESOURCE_META[group.resource]
                const ResourceIcon = meta?.icon
                return (
                <Fragment key={group.resource}>
                  {group.sectionKey && (
                    <tr className="border-b border-t bg-muted/60">
                      <td
                        colSpan={roles.length + 1}
                        className="sticky left-0 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-foreground"
                      >
                        {t(`settings.roles_section_${group.sectionKey}`)}
                      </td>
                    </tr>
                  )}
                  <tr className="border-b bg-muted/20">
                    <td className="sticky left-0 z-10 w-56 bg-muted/20 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        {ResourceIcon && <ResourceIcon size={13} className={meta.color} />}
                        {t(`settings.resource_${group.resource}`, group.resource)}
                        {RESOURCE_HINTS.has(group.resource) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help text-muted-foreground/70">
                                <Info size={12} />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs normal-case tracking-normal">
                              {t(`settings.resource_hint_${group.resource}`)}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </span>
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
                        {roles.map((role) => (
                          <td key={role.id} className="px-3 py-1.5 text-center">
                            <Checkbox
                              checked={(draft[role.id] ?? []).includes(permission)}
                              onCheckedChange={(v) => onToggle(role.id, permission, v === true)}
                            />
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </TooltipProvider>
    </div>
  )
}

export function RolesTab() {
  const { t, i18n } = useTranslation()
  const [roles, setRoles] = useState<Role[]>([])
  const [catalogue, setCatalogue] = useState<Permission[]>([])
  const [draft, setDraft] = useState<Draft>({})
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newScope, setNewScope] = useState<'workspace' | 'global'>('workspace')
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null)
  const [renameTarget, setRenameTarget] = useState<Role | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [roleTab, setRoleTab] = useState<'workspace' | 'global'>('global')

  const applyRoles = useCallback((r: Role[]) => {
    setRoles(r)
    setDraft(Object.fromEntries(r.map((role) => [role.id, [...role.permissions]])))
  }, [])

  const load = useCallback(async () => {
    const storage = getStorage()
    const [r, perms] = await Promise.all([storage.roles.getAll(), storage.roles.getPermissions()])
    applyRoles(r)
    setCatalogue(perms)
  }, [applyRoles])

  useEffect(() => {
    if (!isServerMode()) return
    let cancelled = false
    void (async () => {
      const storage = getStorage()
      const [r, perms] = await Promise.all([storage.roles.getAll(), storage.roles.getPermissions()])
      if (!cancelled) {
        setRoles(r)
        setDraft(Object.fromEntries(r.map((role) => [role.id, [...role.permissions]])))
        setCatalogue(perms)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const baseline = useMemo(
    () => Object.fromEntries(roles.map((r) => [r.id, r.permissions])),
    [roles],
  )

  const saveChanges = useCallback(async () => {
    const storage = getStorage()
    const changed = roles.filter(
      (r) => JSON.stringify([...(draft[r.id] ?? [])].sort()) !== JSON.stringify([...r.permissions].sort()),
    )
    try {
      await Promise.all(changed.map((r) => storage.roles.update(r.id, { permissions: draft[r.id] ?? [] })))
    } finally {
      await load()
    }
  }, [roles, draft, load])

  const form = useSaveForm({ current: draft, baseline, onSave: saveChanges })

  const workspaceRoles = useMemo(() => sortRoles(roles.filter((r) => r.scope === 'workspace')), [roles])
  const globalRoles = useMemo(() => sortRoles(roles.filter((r) => r.scope === 'global')), [roles])
  const workspaceCatalogue = useMemo(() => catalogue.filter((p) => !isGlobalPermission(p)), [catalogue])
  const globalCatalogue = useMemo(() => catalogue.filter(isGlobalPermission), [catalogue])

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

  const toggle = (roleId: string, permission: Permission, checked: boolean) =>
    setDraft((d) => ({
      ...d,
      [roleId]: checked
        ? [...(d[roleId] ?? []), permission]
        : (d[roleId] ?? []).filter((p) => p !== permission),
    }))

  // Replace only this section's permissions for the role, preserving the other scope's.
  const setAll = (roleId: string, sectionPermissions: Permission[], next: Permission[]) =>
    setDraft((d) => {
      const kept = (d[roleId] ?? []).filter((p) => !sectionPermissions.includes(p))
      return { ...d, [roleId]: [...kept, ...next] }
    })

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    try {
      await getStorage().roles.create({
        name,
        label: newLabel.trim() ? { en: newLabel.trim() } : {},
        scope: newScope,
        permissions: [],
      })
      setAddOpen(false)
      setNewName('')
      setNewLabel('')
      setRoleTab(newScope)
      setNewScope('workspace')
      setError(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const openRename = (role: Role) => {
    setRenameTarget(role)
    setRenameValue(localized(role.label, i18n.language) || role.name)
  }

  const confirmRename = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!renameTarget) return
    const value = renameValue.trim()
    if (!value) return
    const role = renameTarget
    setRenameTarget(null)
    try {
      await getStorage().roles.update(role.id, {
        label: setLocalized(role.label, i18n.language, value),
      })
    } finally {
      await load()
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
    <div className="space-y-6">
      <Tabs value={roleTab} onValueChange={(v) => setRoleTab(v as 'workspace' | 'global')}>
        <div className="flex items-center justify-between gap-2">
          <TabsList className="w-fit">
            <TabsTrigger value="global">{t('settings.roles_global_title')}</TabsTrigger>
            <TabsTrigger value="workspace">{t('settings.roles_workspace_title')}</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => { setError(null); setAddOpen(true) }}>
              <Plus size={14} />
              {t('settings.add_role')}
            </Button>
            <Button size="sm" onClick={form.save} disabled={!form.canSaveNow}>
              {t('common.save')}
            </Button>
          </div>
        </div>
        <TabsContent value="global" className="mt-4">
          <RoleMatrix
            description={t('settings.roles_global_description')}
            roles={globalRoles}
            catalogue={globalCatalogue}
            draft={draft}
            onToggle={toggle}
            onSetAll={(roleId, next) => setAll(roleId, globalCatalogue, next)}
            onEdit={openRename}
            onDelete={setDeleteTarget}
          />
        </TabsContent>
        <TabsContent value="workspace" className="mt-4">
          <RoleMatrix
            description={t('settings.roles_workspace_description')}
            roles={workspaceRoles}
            catalogue={workspaceCatalogue}
            sections={WORKSPACE_SECTIONS}
            draft={draft}
            onToggle={toggle}
            onSetAll={(roleId, next) => setAll(roleId, workspaceCatalogue, next)}
            onEdit={openRename}
            onDelete={setDeleteTarget}
          />
        </TabsContent>
      </Tabs>

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
              <div className="space-y-2">
                <Label>{t('settings.role_scope')}</Label>
                <Select value={newScope} onValueChange={(v) => setNewScope(v as 'workspace' | 'global')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="workspace">{t('settings.roles_scope_workspace')}</SelectItem>
                    <SelectItem value="global">{t('settings.roles_scope_global')}</SelectItem>
                  </SelectContent>
                </Select>
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

      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null) }}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={confirmRename}>
            <DialogHeader>
              <DialogTitle>{t('settings.rename_role')}</DialogTitle>
              <DialogDescription>{t('settings.rename_role_description')}</DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-2">
              <Label htmlFor="rename-role">{t('settings.role_label')}</Label>
              <Input id="rename-role" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
            </div>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!renameValue.trim()}>
                {t('common.save')}
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
