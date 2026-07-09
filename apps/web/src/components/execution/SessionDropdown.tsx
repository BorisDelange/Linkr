import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Boxes, ChevronDown, Plus, Trash2, Check } from 'lucide-react'
import { isServerMode } from '@/lib/api-client'
import { useSessionStore } from '@/stores/session-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Selects the active execution session (kernel namespace) for a project. Sits in
 * the IDE toolbar next to the database dropdown. Server mode only — a session is
 * a server-side kernel namespace.
 */
export function SessionDropdown({ projectUid }: { projectUid: string }) {
  const { t } = useTranslation()
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const createSession = useSessionStore((s) => s.createSession)
  const removeSession = useSessionStore((s) => s.removeSession)
  const setActiveSession = useSessionStore((s) => s.setActiveSession)
  // Subscribe to the slices so the label re-renders on change.
  const activeByProject = useSessionStore((s) => s.activeByProject)
  const sessionsByProject = useSessionStore((s) => s.sessions)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    if (projectUid) loadSessions(projectUid)
  }, [projectUid, loadSessions])

  if (!isServerMode()) return null

  const activeId = activeByProject[projectUid] ?? 'default'
  const named = sessionsByProject[projectUid] ?? []
  const all = [{ id: 'default', name: t('sessions.default') }, ...named]
  const activeName = all.find((s) => s.id === activeId)?.name ?? t('sessions.default')

  const submitNew = async () => {
    const name = newName.trim()
    if (!name) return
    const id = await createSession(projectUid, name)
    setActiveSession(projectUid, id)
    setNewName('')
    setAdding(false)
  }

  return (
    <DropdownMenu onOpenChange={(o) => { if (!o) { setAdding(false); setNewName('') } }}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs" className="gap-1 max-w-[160px] text-[11px]">
          <Boxes size={11} className="shrink-0" />
          <span className="truncate">{activeName}</span>
          <ChevronDown size={10} className="shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t('sessions.title')}
        </DropdownMenuLabel>
        {all.map((s) => (
          <DropdownMenuItem
            key={s.id}
            className="flex items-center gap-2 text-xs"
            onSelect={(e) => {
              // Keep the menu open when clicking the delete affordance.
              e.preventDefault()
              setActiveSession(projectUid, s.id)
            }}
          >
            <Check size={12} className={s.id === activeId ? 'opacity-100' : 'opacity-0'} />
            <span className="flex-1 truncate">{s.name}</span>
            {s.id !== 'default' && (
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation()
                  removeSession(projectUid, s.id)
                }}
                aria-label={t('sessions.delete')}
              >
                <Trash2 size={12} />
              </button>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {adding ? (
          <div className="flex items-center gap-1 px-2 py-1.5">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNew()
                if (e.key === 'Escape') { setAdding(false); setNewName('') }
              }}
              placeholder={t('sessions.name_placeholder')}
              className="h-6 text-xs"
            />
          </div>
        ) : (
          <DropdownMenuItem
            className="flex items-center gap-2 text-xs"
            onSelect={(e) => { e.preventDefault(); setAdding(true) }}
          >
            <Plus size={12} />
            {t('sessions.new')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
