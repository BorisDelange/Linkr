import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { isServerMode } from '@/lib/api-client'
import { localized } from '@/lib/localized'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { useAuthStore } from '@/stores/auth-store'
import { useMyWorkspaceRole, useMyProjectRole } from '@/hooks/use-context-role'
import {
  membersApi,
  type DirectoryUser,
  type MemberRole,
  type ProjectMember,
  type ProjectMemberRole,
  type WorkspaceMember,
} from '@/lib/api/members'
import { Button } from '@/components/ui/button'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
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

const WORKSPACE_ROLES: MemberRole[] = ['viewer', 'editor', 'owner']
// Project overrides add "none" = hide this project from the member.
const PROJECT_ROLES: ProjectMemberRole[] = ['none', 'viewer', 'editor', 'owner']

type Member = WorkspaceMember | ProjectMember

/** A member joined with their directory entry, for the same columns as Settings → Users. */
interface Row {
  userId: number
  role: ProjectMemberRole
  username: string
  email: string
  firstName: string
  lastName: string
  affiliation: string
  profession: string
  orcid: string
}

interface MembersTabProps {
  scope: 'workspace' | 'project'
  /** Workspace id or project uid. */
  targetId: string
}

/**
 * Membership management for a workspace or a project. Server-mode only
 * (accounts + roles live on the backend). Project scope manages per-project
 * overrides that replace the inherited workspace role.
 */
export function MembersTab({ scope, targetId }: MembersTabProps) {
  const { t, i18n } = useTranslation()
  const currentUserId = useAuthStore((s) => s.user?.id)
  const wsRole = useMyWorkspaceRole()
  const projRole = useMyProjectRole()
  const canManage =
    scope === 'workspace'
      ? wsRole.can('workspace-members:write')
      : projRole.can('project-members:write')
  const [members, setMembers] = useState<Member[]>([])
  const [directory, setDirectory] = useState<DirectoryUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [newRole, setNewRole] = useState<ProjectMemberRole>('editor')
  const [busy, setBusy] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<Row | null>(null)
  const roleOptions = scope === 'project' ? PROJECT_ROLES : WORKSPACE_ROLES

  const load = useCallback(async () => {
    if (!isServerMode()) return
    setLoading(true)
    try {
      const rows =
        scope === 'workspace'
          ? await membersApi.listWorkspace(targetId)
          : await membersApi.listProject(targetId)
      setMembers(rows)
      setError(null)
    } catch {
      setError(t('members.load_error'))
    } finally {
      setLoading(false)
    }
  }, [scope, targetId, t])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!isServerMode()) return
    membersApi.directory().then(setDirectory).catch(() => setDirectory([]))
  }, [])

  const rows = useMemo<Row[]>(() => {
    const byId = new Map(directory.map((u) => [u.id, u]))
    return members.map((m) => {
      const u = byId.get(m.userId)
      return {
        userId: m.userId,
        role: m.role,
        username: m.user?.username ?? u?.username ?? `#${m.userId}`,
        email: m.user?.email ?? '',
        firstName: u?.firstName ?? '',
        lastName: u?.lastName ?? '',
        affiliation: localized(u?.affiliation, i18n.language),
        profession: localized(u?.profession, i18n.language),
        orcid: u?.orcid ?? '',
      }
    })
  }, [members, directory, i18n.language])

  // Users not already listed here — the pool the picker offers to add. For a
  // project override, everyone is offerable (an override can target a workspace
  // member too); for a workspace, only non-members.
  const memberIds = new Set(members.map((m) => m.userId))
  const addableOptions = directory
    .filter((u) => scope === 'project' || !memberIds.has(u.id))
    .map((u) => ({ value: String(u.id), label: u.username }))

  const upsert = useCallback(async (userId: number, role: ProjectMemberRole) => {
    if (scope === 'workspace') await membersApi.upsertWorkspace(targetId, { userId, role })
    else await membersApi.upsertProject(targetId, { userId, role })
  }, [scope, targetId])

  const openAdd = () => {
    setSelectedUserIds([])
    setNewRole('editor')
    setError(null)
    setAddOpen(true)
  }

  const handleAdd = async () => {
    if (selectedUserIds.length === 0) return
    setBusy(true)
    try {
      for (const id of selectedUserIds) await upsert(Number(id), newRole)
      setAddOpen(false)
      await load()
    } catch {
      setError(t('members.save_error'))
    } finally {
      setBusy(false)
    }
  }

  const handleChangeRole = useCallback(async (userId: number, role: ProjectMemberRole) => {
    setBusy(true)
    try {
      await upsert(userId, role)
      await load()
      setError(null)
    } catch {
      setError(t('members.save_error'))
    } finally {
      setBusy(false)
    }
  }, [upsert, load, t])

  const handleRemove = async () => {
    if (!removeTarget) return
    const { userId } = removeTarget
    setRemoveTarget(null)
    setBusy(true)
    try {
      if (scope === 'workspace') await membersApi.removeWorkspace(targetId, userId)
      else await membersApi.removeProject(targetId, userId)
      await load()
      setError(null)
    } catch {
      setError(t('members.remove_error'))
    } finally {
      setBusy(false)
    }
  }

  const columns = useMemo<ConceptColumn<Row>[]>(() => [
    { id: 'username', header: t('settings.user_username'), accessor: (r) => r.username, filter: 'text', size: 160 },
    { id: 'firstName', header: t('profile.first_name'), accessor: (r) => r.firstName, filter: 'text', size: 130 },
    { id: 'lastName', header: t('profile.last_name'), accessor: (r) => r.lastName, filter: 'text', size: 130 },
    { id: 'email', header: t('settings.user_email'), accessor: (r) => r.email, filter: 'text', size: 190, hidden: true },
    { id: 'affiliation', header: t('profile.affiliation'), accessor: (r) => r.affiliation, filter: 'text', size: 180 },
    { id: 'profession', header: t('profile.profession'), accessor: (r) => r.profession, filter: 'text', size: 150, hidden: true },
    { id: 'orcid', header: 'ORCID', accessor: (r) => r.orcid, filter: 'text', size: 160, hidden: true },
    {
      id: 'role',
      header: t('members.role'),
      accessor: (r) => r.role,
      filter: 'select',
      selectOptionLabel: (v) => t(`members.role_${v}`),
      size: 170,
      cell: (r) => (
        <Select
          value={r.role}
          onValueChange={(v) => void handleChangeRole(r.userId, v as ProjectMemberRole)}
          disabled={busy || !canManage}
        >
          <SelectTrigger size="sm" className="h-6 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roleOptions.map((role) => (
              <SelectItem key={role} value={role}>{t(`members.role_${role}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      id: 'actions',
      header: '',
      accessor: () => '',
      filter: 'none',
      sortable: false,
      size: 48,
      cell: (r) => {
        const isSelf = r.userId === currentUserId
        return (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setRemoveTarget(r)}
            disabled={busy || !canManage || (scope === 'workspace' && isSelf)}
            title={scope === 'project' ? t('members.remove_override') : t('members.remove')}
          >
            <Trash2 size={14} />
          </Button>
        )
      },
    },
  ], [t, busy, canManage, currentUserId, scope, roleOptions, handleChangeRole])

  if (!isServerMode()) {
    return <ServerModeNotice description={t('members.requires_backend')} />
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 pt-2">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('members.title')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {scope === 'project' ? t('members.project_description') : t('members.workspace_description')}
          </p>
        </div>
        <Button size="sm" onClick={openAdd} disabled={!canManage}>
          <Plus size={14} />
          {scope === 'project' ? t('members.add_override') : t('members.add')}
        </Button>
      </div>

      {error && !addOpen && <p className="text-xs text-destructive">{error}</p>}

      <div className="h-[calc(100vh-320px)] min-h-[280px] overflow-hidden rounded-lg border">
        <ConceptDataTable
          data={loading ? [] : rows}
          columns={columns}
          rowKey={(r) => r.userId}
          emptyMessage={
            loading
              ? t('common.loading')
              : scope === 'project' ? t('members.no_overrides') : t('members.empty')
          }
        />
      </div>

      <DialogShell
        open={addOpen}
        onOpenChange={setAddOpen}
        title={scope === 'project' ? t('members.add_override') : t('members.add_label')}
        description={scope === 'project' ? t('members.project_description') : t('members.workspace_description')}
        onConfirm={handleAdd}
        confirmLabel={scope === 'project' ? t('members.add_override') : t('members.add')}
        confirmDisabled={selectedUserIds.length === 0}
        busy={busy}
      >
        <FormField label={t('members.user')} required>
          {() => (
            <MultiSelectFilter
              value={selectedUserIds}
              options={addableOptions}
              placeholder={t('members.select_users_placeholder')}
              onChange={setSelectedUserIds}
              popoverWidthClass="w-72"
              selectAllRespectsSearch
              triggerClass="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:border-primary"
            />
          )}
        </FormField>
        <FormField label={t('members.role')}>
          {({ id }) => (
            <Select value={newRole} onValueChange={(v) => setNewRole(v as ProjectMemberRole)}>
              <SelectTrigger id={id} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((r) => (
                  <SelectItem key={r} value={r}>{t(`members.role_${r}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogShell>

      <AlertDialog open={!!removeTarget} onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {scope === 'project' ? t('members.remove_override') : t('members.remove')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(scope === 'project' ? 'members.remove_override_confirm' : 'members.remove_confirm', {
                name: removeTarget?.username ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemove} className="bg-destructive text-white hover:bg-destructive/90">
              {scope === 'project' ? t('members.remove_override') : t('members.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
