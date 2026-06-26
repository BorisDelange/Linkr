import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Minus, RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import type { SeedChange, SeedDiffResult, SeedEntityType, SeedChangeType } from '@/lib/seed-change-detector'

/** Display order of entity-type sub-groups within a workspace. */
const TYPE_ORDER: SeedEntityType[] = [
  'workspace', 'project', 'dataset', 'dashboard', 'database',
  'mappingProject', 'conceptMapping', 'etlScript', 'dqRuleSet', 'catalog',
]

const changeIcons: Record<SeedChangeType, typeof Plus> = {
  added: Plus,
  modified: Pencil,
  removed: Minus,
}

const changeBadgeVariant: Record<SeedChangeType, 'default' | 'secondary' | 'destructive'> = {
  added: 'default',
  modified: 'secondary',
  removed: 'destructive',
}

/** Stable per-change key for selection state. */
function changeKey(c: SeedChange): string {
  return `${c.workspaceFolder}:${c.entityType}:${c.entityId}`
}

/** Read a workspace's human-readable name from its bundled workspace.json, by folder. */
async function fetchWorkspaceName(folder: string, language: string): Promise<string | null> {
  const url = `${import.meta.env.BASE_URL}data/seed/${folder}/workspace.json`.replace(/\/\//g, '/')
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const ws = await res.json() as { name?: Record<string, string> }
    const name = ws.name
    if (!name) return null
    return name[language] ?? name['en'] ?? Object.values(name)[0] ?? null
  } catch {
    return null
  }
}

interface SeedUpdateDialogProps {
  diff: SeedDiffResult
  /** Re-import the chosen entities, then advance their baseline. */
  onReseed: (changes: SeedChange[]) => Promise<void>
  /** Keep all local data; advance the whole baseline so this stops showing. */
  onKeep: () => void
}

export function SeedUpdateDialog({ diff, onReseed, onKeep }: SeedUpdateDialogProps) {
  const { t, i18n } = useTranslation()

  // Re-importable changes (added/modified) vs notify-only (removed).
  const reseedable = useMemo(() => diff.changes.filter((c) => c.changeType !== 'removed'), [diff.changes])
  const removed = useMemo(() => diff.changes.filter((c) => c.changeType === 'removed'), [diff.changes])

  // Selection: all re-importable entities checked by default.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(reseedable.map(changeKey)))
  const [busy, setBusy] = useState(false)

  const byWorkspace = useMemo(() => {
    const map = new globalThis.Map<string, SeedChange[]>()
    for (const change of diff.changes) {
      if (!map.has(change.workspaceFolder)) map.set(change.workspaceFolder, [])
      map.get(change.workspaceFolder)!.push(change)
    }
    return map
  }, [diff.changes])

  // Resolve each workspace folder to its human-readable name (folder is technical).
  const [wsNames, setWsNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const folders = [...new Set(diff.changes.map((c) => c.workspaceFolder))]
    Promise.all(folders.map(async (f) => [f, await fetchWorkspaceName(f, i18n.language)] as const))
      .then((pairs) => {
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const [f, name] of pairs) if (name) map[f] = name
        setWsNames(map)
      })
    return () => { cancelled = true }
  }, [diff.changes, i18n.language])

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleUpdate = async () => {
    const picked = reseedable.filter((c) => selected.has(changeKey(c)))
    if (picked.length === 0) return
    setBusy(true)
    try {
      await onReseed(picked)
    } finally {
      setBusy(false)
    }
  }

  // Group a workspace's changes by entity type (stable order), with removed entities
  // pushed to the end within each type so the actionable (new/updated) ones stay grouped.
  const groupByType = (changes: SeedChange[]): Array<{ type: SeedEntityType; items: SeedChange[] }> => {
    const byType = new globalThis.Map<SeedEntityType, SeedChange[]>()
    for (const c of changes) {
      if (!byType.has(c.entityType)) byType.set(c.entityType, [])
      byType.get(c.entityType)!.push(c)
    }
    const order = (c: SeedChange) => (c.changeType === 'removed' ? 1 : 0)
    return TYPE_ORDER
      .filter((type) => byType.has(type))
      .map((type) => ({
        type,
        items: byType.get(type)!.slice().sort((a, b) => order(a) - order(b)),
      }))
  }

  const renderRow = (change: SeedChange) => {
    const ChangeIcon = changeIcons[change.changeType]
    const key = changeKey(change)
    const isRemoved = change.changeType === 'removed'
    return (
      <label
        key={`${change.entityType}-${change.entityId}`}
        className={`flex items-center gap-2 text-xs ${isRemoved ? 'opacity-70' : 'cursor-pointer'}`}
      >
        {isRemoved ? (
          <span className="w-4 shrink-0" />
        ) : (
          <Checkbox
            checked={selected.has(key)}
            onCheckedChange={() => toggle(key)}
            disabled={busy}
            className="shrink-0"
          />
        )}
        <span className="truncate font-medium">{change.entityLabel}</span>
        <Badge
          variant={changeBadgeVariant[change.changeType]}
          className="ml-auto shrink-0 text-[10px] px-1.5 py-0"
        >
          <ChangeIcon size={10} className="mr-0.5" />
          {t(`version_check.seed_change_${change.changeType}`)}
        </Badge>
      </label>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onKeep() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('version_check.seed_changed_title')}</DialogTitle>
          <DialogDescription asChild>
            <div className="mt-3 space-y-3">
              <p>{t('version_check.seed_changed_description')}</p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[320px] overflow-y-auto rounded-md border p-3">
          <div className="space-y-5">
            {[...byWorkspace.entries()].map(([wsFolder, changes]) => (
              <div key={wsFolder}>
                <p className="text-sm font-semibold mb-3">{wsNames[wsFolder] ?? wsFolder}</p>
                <div className="space-y-3 pl-1">
                  {groupByType(changes).map(({ type, items }) => (
                    <div key={type}>
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t(`version_check.seed_entity_${type}`)}
                      </p>
                      <div className="space-y-1 pl-1">
                        {items.map((change) => renderRow(change))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {removed.length > 0 && (
          <p className="text-xs text-muted-foreground">{t('version_check.seed_removed_hint')}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onKeep} disabled={busy}>
            {t('version_check.keep_data')}
          </Button>
          <Button onClick={handleUpdate} disabled={busy || selected.size === 0}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {t('version_check.update_selected')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
