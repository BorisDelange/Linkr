import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Boxes, ChevronDown, Plus, Trash2, Check, CornerDownLeft } from 'lucide-react'
import { isServerMode } from '@/lib/api-client'
import { useSessionStore } from '@/stores/session-store'
import type { SessionLanguage } from '@/lib/api/execution-sessions'
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
 * Selects the active execution session (kernel namespace) for a project, scoped
 * to the current script's language: an R session only shows on R scripts. Sits in
 * the IDE toolbar next to the database dropdown. Server mode only — a session is
 * a server-side kernel namespace.
 */
export function SessionDropdown({
  projectUid,
  language,
}: {
  projectUid: string
  language: SessionLanguage
}) {
  const { t } = useTranslation()
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const createSession = useSessionStore((s) => s.createSession)
  const removeSession = useSessionStore((s) => s.removeSession)
  const setActiveSession = useSessionStore((s) => s.setActiveSession)
  // Subscribe to the slices so the label re-renders on change.
  const activeByScope = useSessionStore((s) => s.activeByScope)
  const sessionsByScope = useSessionStore((s) => s.sessions)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    if (projectUid) loadSessions(projectUid, language)
  }, [projectUid, language, loadSessions])

  if (!isServerMode()) return null

  const scopeKey = `${projectUid}:${language}`
  const activeId = activeByScope[scopeKey] ?? 'default'
  const named = sessionsByScope[scopeKey] ?? []
  const all = [{ id: 'default', name: t('sessions.default') }, ...named]
  const activeName = all.find((s) => s.id === activeId)?.name ?? t('sessions.default')

  const submitNew = async () => {
    const name = newName.trim()
    if (!name) return
    const id = await createSession(projectUid, language, name)
    setActiveSession(projectUid, language, id)
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
            onSelect={() => setActiveSession(projectUid, language, s.id)}
          >
            <Check size={12} className={s.id === activeId ? 'opacity-100' : 'opacity-0'} />
            <span className="flex-1 truncate">{s.name}</span>
            {s.id !== 'default' && (
              <button
                type="button"
                // hover:!text-destructive overrides the DropdownMenuItem's
                // focus/hover text color that otherwise wins over the child.
                className="group/trash rounded p-0.5 text-muted-foreground"
                // Stop the pointer/click from reaching the DropdownMenuItem, so
                // deleting doesn't also select (and close) the session.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  removeSession(projectUid, language, s.id)
                }}
                aria-label={t('sessions.delete')}
              >
                <Trash2 size={10} className="group-hover/trash:text-destructive" />
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
            className="group/new flex items-center gap-2 text-xs"
            onSelect={(e) => { e.preventDefault(); setAdding(true) }}
          >
            <Plus size={12} />
            <span className="flex-1">{t('sessions.new')}</span>
            <CornerDownLeft size={11} className="opacity-0 transition-opacity group-hover/new:opacity-60" />
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
