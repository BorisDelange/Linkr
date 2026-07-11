import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Plus, Trash2, Users } from 'lucide-react'
import { isServerMode } from '@/lib/api-client'
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
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
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

const WORKSPACE_ROLES: MemberRole[] = ['viewer', 'editor', 'owner']
// Project overrides add "none" = hide this project from the member.
const PROJECT_ROLES: ProjectMemberRole[] = ['none', 'viewer', 'editor', 'owner']

type Row = WorkspaceMember | ProjectMember

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
  const { t } = useTranslation()
  const currentUserId = useAuthStore((s) => s.user?.id)
  const wsRole = useMyWorkspaceRole()
  const projRole = useMyProjectRole()
  const canManage =
    scope === 'workspace'
      ? wsRole.can('workspace-members:write')
      : projRole.can('project-members:write')
  const [members, setMembers] = useState<Row[]>([])
  const [directory, setDirectory] = useState<DirectoryUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [newRole, setNewRole] = useState<ProjectMemberRole>('editor')
  const [busy, setBusy] = useState(false)
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

  // Users not already listed here — the pool the picker offers to add. For a
  // project override, everyone is offerable (an override can target a workspace
  // member too); for a workspace, only non-members.
  const memberIds = new Set(members.map((m) => m.userId))
  const addableOptions = directory
    .filter((u) => scope === 'project' || !memberIds.has(u.id))
    .map((u) => ({ value: String(u.id), label: u.username }))

  const upsert = async (body: { userId?: number; username?: string; role: ProjectMemberRole }) => {
    setBusy(true)
    try {
      if (scope === 'workspace') await membersApi.upsertWorkspace(targetId, body)
      else await membersApi.upsertProject(targetId, body)
      await load()
      setError(null)
    } catch {
      setError(t('members.save_error'))
    } finally {
      setBusy(false)
    }
  }

  const handleAdd = async () => {
    if (selectedUserIds.length === 0) return
    setBusy(true)
    try {
      for (const id of selectedUserIds) {
        if (scope === 'workspace') {
          await membersApi.upsertWorkspace(targetId, { userId: Number(id), role: newRole })
        } else {
          await membersApi.upsertProject(targetId, { userId: Number(id), role: newRole })
        }
      }
      setSelectedUserIds([])
      await load()
      setError(null)
    } catch {
      setError(t('members.save_error'))
    } finally {
      setBusy(false)
    }
  }

  const handleChangeRole = (userId: number, role: ProjectMemberRole) =>
    upsert({ userId, role })

  const handleRemove = async (userId: number) => {
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

  if (!isServerMode()) {
    return (
      <div className="mx-auto max-w-3xl pt-2">
        <Card>
          <CardContent className="flex items-start gap-2 p-4 text-xs text-muted-foreground">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>{t('members.requires_backend')}</span>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pt-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Users size={15} />
            {t('members.title')}
          </CardTitle>
          <CardDescription>
            {scope === 'project'
              ? t('members.project_description')
              : t('members.workspace_description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Add members: pick one or more users, choose a role, add them all. */}
          <div className="space-y-2">
            <Label>{t('members.add_label')}</Label>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <MultiSelectFilter
                  value={selectedUserIds}
                  options={addableOptions}
                  placeholder={t('members.select_users_placeholder')}
                  onChange={setSelectedUserIds}
                  popoverWidthClass="w-64"
                  selectAllRespectsSearch
                  triggerClass="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:border-primary"
                />
              </div>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as ProjectMemberRole)}>
                <SelectTrigger className="h-8 w-36 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`members.role_${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={handleAdd}
                disabled={selectedUserIds.length === 0 || busy || !canManage}
                className="gap-1"
              >
                <Plus size={14} />
                {scope === 'project' ? t('members.add_override') : t('members.add')}
              </Button>
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          {/* Members list */}
          {loading ? (
            <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
          ) : members.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {scope === 'project' ? t('members.no_overrides') : t('members.empty')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('members.user')}</TableHead>
                  <TableHead className="w-40">{t('members.role')}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => {
                  const isSelf = m.userId === currentUserId
                  return (
                    <TableRow key={m.userId}>
                      <TableCell className="text-sm">
                        <span className="font-medium">{m.user?.username ?? `#${m.userId}`}</span>
                        {m.user?.email && (
                          <span className="ml-2 text-xs text-muted-foreground">{m.user.email}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={m.role}
                          onValueChange={(v) => handleChangeRole(m.userId, v as ProjectMemberRole)}
                          disabled={busy || !canManage}
                        >
                          <SelectTrigger className="h-8 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {roleOptions.map((r) => (
                              <SelectItem key={r} value={r}>
                                {t(`members.role_${r}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => handleRemove(m.userId)}
                          disabled={busy || !canManage || (scope === 'workspace' && isSelf)}
                          title={
                            scope === 'project'
                              ? t('members.remove_override')
                              : t('members.remove')
                          }
                        >
                          <Trash2 size={14} />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
