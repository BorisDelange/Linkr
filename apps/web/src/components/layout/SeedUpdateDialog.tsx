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
  /**
   * Apply the selection: re-import `reseed` (added/modified) and delete the local copy of
   * `remove` (removed-from-seed, seed-origin only), then advance their baseline.
   */
  onApply: (reseed: SeedChange[], remove: SeedChange[]) => Promise<void>
  /** Keep all local data; advance the whole baseline so this stops showing. */
  onKeep: () => void
  /**
   * Resolve whether a removed entity's local copy was seed-created (safe to delete).
   * User-created content (or pre-origin-field data) returns false and stays read-only.
   */
  canDeleteRemoved: (change: SeedChange) => Promise<boolean>
}

export function SeedUpdateDialog({ diff, onApply, onKeep, canDeleteRemoved }: SeedUpdateDialogProps) {
  const { t, i18n } = useTranslation()

  // Re-importable changes (added/modified) vs removed-from-seed.
  const reseedable = useMemo(() => diff.changes.filter((c) => c.changeType !== 'removed'), [diff.changes])
  const removed = useMemo(() => diff.changes.filter((c) => c.changeType === 'removed'), [diff.changes])

  // Selection: re-importable entities checked by default; removed ones unchecked (destructive).
  const [selected, setSelected] = useState<Set<string>>(() => new Set(reseedable.map(changeKey)))
  const [busy, setBusy] = useState(false)

  // Which removed entities are safe to delete (seed-origin). Resolved async; until then a
  // removed row stays read-only. User content is never offered for deletion.
  const [deletable, setDeletable] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    let cancelled = false
    Promise.all(removed.map(async (c) => [changeKey(c), await canDeleteRemoved(c)] as const))
      .then((pairs) => {
        if (cancelled) return
        setDeletable(new Set(pairs.filter(([, ok]) => ok).map(([k]) => k)))
      })
    return () => { cancelled = true }
  }, [removed, canDeleteRemoved])

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

  const pickedReseed = reseedable.filter((c) => selected.has(changeKey(c)))
  const pickedRemove = removed.filter((c) => deletable.has(changeKey(c)) && selected.has(changeKey(c)))

  const handleApply = async () => {
    if (pickedReseed.length === 0 && pickedRemove.length === 0) return
    setBusy(true)
    try {
      await onApply(pickedReseed, pickedRemove)
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
    // A removed row is checkable only once confirmed seed-origin (safe to delete). User
    // content / pre-origin data stays read-only.
    const canCheck = isRemoved ? deletable.has(key) : true
    return (
      <label
        key={`${change.entityType}-${change.entityId}`}
        className={`flex items-center gap-2 text-xs ${canCheck ? 'cursor-pointer' : 'opacity-70'}`}
      >
        {canCheck ? (
          <Checkbox
            checked={selected.has(key)}
            onCheckedChange={() => toggle(key)}
            disabled={busy}
            className={`shrink-0 ${isRemoved ? 'data-[state=checked]:bg-destructive data-[state=checked]:border-destructive' : ''}`}
          />
        ) : (
          <span className="w-4 shrink-0" />
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
          <p className="text-xs text-muted-foreground">{t('version_check.seed_removed_deletable_hint')}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onKeep} disabled={busy}>
            {t('version_check.keep_data')}
          </Button>
          <Button onClick={handleApply} disabled={busy || (pickedReseed.length === 0 && pickedRemove.length === 0)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {t('version_check.update_selected')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
