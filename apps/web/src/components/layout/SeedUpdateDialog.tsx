import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Minus, RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { SectionLabel } from '@/components/ui/section-label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'
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
  /** Keep all local data; advance the whole baseline so this stops showing (deliberate choice). */
  onKeep: () => void
  /** Close for this session without deciding (click-outside / Esc / X) — baseline untouched. */
  onDismiss: () => void
  /**
   * Resolve whether a removed entity's local copy was seed-created (safe to delete).
   * User-created content (or pre-origin-field data) returns false and stays read-only.
   */
  canDeleteRemoved: (change: SeedChange) => Promise<boolean>
  /**
   * Whether a removed workspace is kept because it still holds content of its own.
   * Its row is then read-only and says so, rather than appearing deletable and
   * quietly surviving the update.
   */
  workspaceKept: (change: SeedChange) => Promise<boolean>
}

export function SeedUpdateDialog({ diff, onApply, onKeep, onDismiss, canDeleteRemoved, workspaceKept }: SeedUpdateDialogProps) {
  const { t, i18n } = useTranslation()

  // Re-importable changes (added/modified) vs removed-from-seed.
  const reseedable = useMemo(() => diff.changes.filter((c) => c.changeType !== 'removed'), [diff.changes])
  const removed = useMemo(() => diff.changes.filter((c) => c.changeType === 'removed'), [diff.changes])

  // Selection: everything the dialog can act on is checked by default — accepting
  // the update wholesale is the common answer, and leaving removals unticked meant
  // the usual case took one click per stale entity.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(reseedable.map(changeKey)))
  const [busy, setBusy] = useState(false)

  // Which removed entities are safe to delete (seed-origin). Resolved async; until then a
  // removed row stays read-only. User content is never offered for deletion.
  const [deletable, setDeletable] = useState<Set<string>>(() => new Set())
  const [keptWorkspaces, setKeptWorkspaces] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    let cancelled = false
    Promise.all(removed.map(async (c) => [changeKey(c), await canDeleteRemoved(c)] as const))
      .then((pairs) => {
        if (cancelled) return
        const set = new Set(pairs.filter(([, ok]) => ok).map(([k]) => k))
        // A removed-whole-workspace row has no resolvable local id of its own (its seed folder
        // is gone). It's deletable iff it has at least one seed-origin removed child — deleting
        // it cascades to those children. Mark the workspace row accordingly.
        for (const c of removed) {
          if (c.entityType !== 'workspace') continue
          const hasDeletableChild = removed.some(
            (ch) => ch.entityType !== 'workspace' && ch.workspaceFolder === c.workspaceFolder && set.has(changeKey(ch)),
          )
          if (hasDeletableChild) set.add(changeKey(c))
        }
        setDeletable(set)
        // A workspace still holding content the user put there is kept whatever its
        // children say, and shown as such — otherwise it silently survives the update
        // and the user meets a second workspace with no idea why.
        Promise.all(
          removed
            .filter((c) => c.entityType === 'workspace')
            .map(async (c) => [changeKey(c), await workspaceKept(c)] as const),
        ).then((kept) => {
          if (cancelled) return
          setKeptWorkspaces(new Set(kept.filter(([, k]) => k).map(([k]) => k)))
        })
        // Tick the removals now rather than at mount: which ones are safe is only
        // knowable once this resolves, and pre-ticking a row that turns out to hold
        // user content would offer to delete work the seed never created.
        setSelected((prev) => new Set([...prev, ...set]))
      })
    return () => { cancelled = true }
  }, [removed, canDeleteRemoved, workspaceKept])

  const byWorkspace = useMemo(() => {
    const map = new globalThis.Map<string, SeedChange[]>()
    for (const change of diff.changes) {
      if (!map.has(change.workspaceFolder)) map.set(change.workspaceFolder, [])
      map.get(change.workspaceFolder)!.push(change)
    }
    return map
  }, [diff.changes])

  // Resolve each workspace folder to its human-readable name (folder is technical). Prefer the
  // live workspace.json; fall back to the name the change already carries (the only source for a
  // workspace removed from the seed, whose workspace.json no longer exists) before the folder.
  const wsNameFromChanges = useMemo(() => {
    const map: Record<string, string> = {}
    for (const c of diff.changes) if (c.workspaceName) map[c.workspaceFolder] = c.workspaceName
    return map
  }, [diff.changes])

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

  const wsLabel = (folder: string) => wsNames[folder] ?? wsNameFromChanges[folder] ?? folder

  // Folders whose whole workspace is added or removed. There the re-seed/delete granularity is
  // the workspace itself (seedWorkspaces loads it as a block), so its child rows are shown
  // read-only and ride along with the workspace row.
  const wholeWorkspaceFolders = useMemo(() => {
    const set = new Set<string>()
    for (const c of diff.changes) {
      if (c.entityType === 'workspace' && (c.changeType === 'added' || c.changeType === 'removed')) {
        set.add(c.workspaceFolder)
      }
    }
    return set
  }, [diff.changes])

  /** A row is its own control unless it's a child of a wholly added/removed workspace. */
  const isChildOfWholeWorkspace = (c: SeedChange) =>
    c.entityType !== 'workspace' && wholeWorkspaceFolders.has(c.workspaceFolder)

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /**
   * Every row the user can actually tick: rows that own their own control, and —
   * among removals — only the ones resolved as safe to delete. A child of a wholly
   * added/removed workspace rides along with its workspace row and is read-only,
   * so selecting it would be invisible here and ignored downstream.
   */
  const selectableKeys = useMemo(
    () => diff.changes
      .filter((c) => !isChildOfWholeWorkspace(c))
      .filter((c) => c.changeType !== 'removed' || deletable.has(changeKey(c)))
      .map(changeKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diff.changes, wholeWorkspaceFolders, deletable],
  )

  // Expand a selected whole-workspace row into all its child changes of a given change type,
  // so checking the workspace applies to everything inside it (children are read-only).
  const childrenOf = (folder: string, changeTypes: SeedChange['changeType'][]) =>
    diff.changes.filter((c) =>
      c.workspaceFolder === folder && c.entityType !== 'workspace' && changeTypes.includes(c.changeType),
    )

  const pickedReseed = reseedable.filter((c) => {
    if (isChildOfWholeWorkspace(c)) return false // ride along with the workspace row instead
    if (!selected.has(changeKey(c))) return false
    return true
  }).concat(
    // children of any selected, wholly-added workspace
    [...wholeWorkspaceFolders]
      .filter((f) => selected.has(`${f}:workspace:${f}`))
      .flatMap((f) => childrenOf(f, ['added', 'modified'])),
  )

  const pickedRemove = removed.filter((c) => {
    if (isChildOfWholeWorkspace(c)) return false
    return deletable.has(changeKey(c)) && selected.has(changeKey(c))
  }).concat(
    // children of any selected, wholly-removed workspace (origin-guarded later in deleteRemovedSelection)
    [...wholeWorkspaceFolders]
      .filter((f) => selected.has(`${f}:workspace:${f}`))
      .flatMap((f) => childrenOf(f, ['removed'])),
  )

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
    // A child of a wholly added/removed workspace rides along with the workspace: shown as a
    // checked-but-locked box with a tooltip. A removed row is checkable only once confirmed
    // seed-origin (safe to delete); other non-seed removed rows stay read-only.
    const ridesAlong = isChildOfWholeWorkspace(change)
    // A workspace the user has put content into is kept whatever its seed children say,
    // so its row must not offer a deletion that will not happen.
    const isKeptWorkspace = keptWorkspaces.has(key)
    const canCheck = ridesAlong || isKeptWorkspace ? false : isRemoved ? deletable.has(key) : true
    // A rides-along child mirrors its workspace row's checkbox (locked): checking the workspace
    // checks them all, unchecking clears them — so the UI matches what apply actually does.
    const workspaceKey = `${change.workspaceFolder}:workspace:${change.workspaceFolder}`
    const ridesAlongChecked = ridesAlong && selected.has(workspaceKey)

    const checkboxSlot = ridesAlong ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help">
            <Checkbox checked={ridesAlongChecked} disabled className="pointer-events-none" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('version_check.seed_child_included_tooltip')}</TooltipContent>
      </Tooltip>
    ) : canCheck ? (
      <Checkbox
        checked={selected.has(key)}
        onCheckedChange={() => toggle(key)}
        disabled={busy}
        className={`shrink-0 ${isRemoved ? 'data-[state=checked]:bg-destructive data-[state=checked]:border-destructive' : ''}`}
      />
    ) : (
      <span className="w-4 shrink-0" />
    )

    return (
      <label
        key={`${change.entityType}-${change.entityId}`}
        className={`flex items-center gap-2 text-xs ${canCheck ? 'cursor-pointer' : 'opacity-70'}`}
      >
        {checkboxSlot}
        <span className="truncate font-medium">{change.entityLabel}</span>
        {isKeptWorkspace ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="ml-auto shrink-0 cursor-help px-1.5 py-0.5 leading-none">
                {t('version_check.seed_workspace_kept')}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{t('version_check.seed_workspace_kept_tooltip')}</TooltipContent>
          </Tooltip>
        ) : (
          <Badge
            variant={changeBadgeVariant[change.changeType]}
            className="ml-auto shrink-0 gap-0.5 px-1.5 py-0.5 leading-none [&>svg]:size-2.5"
          >
            <ChangeIcon className="shrink-0" />
            {t(`version_check.seed_change_${change.changeType}`)}
          </Badge>
        )}
      </label>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onDismiss() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('version_check.seed_changed_title')}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3">
              <p>{t('version_check.seed_changed_description')}</p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <TooltipProvider delayDuration={200}>
        {/* Vertical padding lives on the children, not here: a sticky bar sits
            BELOW its container's top padding, so a padded box leaves a transparent
            strip above it that scrolling rows show through. */}
        <div className="max-h-[320px] overflow-y-auto rounded-md border px-3">
          {/* Same pair-of-links treatment every other multi-select list uses
              (ExportDashboardDialog, the filter sidebar, the analysis panels).
              Sticky so it stays reachable once the list scrolls. */}
          {selectableKeys.length > 1 && (
            <div className="sticky top-0 z-10 flex justify-end gap-1.5 bg-background pb-1.5 pt-3 text-[10px] text-muted-foreground">
              <button type="button" disabled={busy} onClick={() => setSelected(new Set(selectableKeys))} className="hover:text-foreground">
                {t('common.select_all')}
              </button>
              <span className="text-muted-foreground/40">/</span>
              <button type="button" disabled={busy} onClick={() => setSelected(new Set())} className="hover:text-foreground">
                {t('common.select_none')}
              </button>
            </div>
          )}
          {/* The sticky bar already carries the top padding when it is shown. */}
          <div className={`space-y-5 pb-3 ${selectableKeys.length > 1 ? '' : 'pt-3'}`}>
            {[...byWorkspace.entries()].map(([wsFolder, changes]) => (
              <div key={wsFolder}>
                <p className="text-sm font-semibold mb-3">
                  {wsLabel(wsFolder)}
                  {wholeWorkspaceFolders.has(wsFolder) && (
                    <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                      {t('version_check.seed_whole_workspace_hint')}
                    </span>
                  )}
                </p>
                <div className="space-y-3 pl-1">
                  {groupByType(changes).map(({ type, items }) => (
                    <div key={type}>
                      <SectionLabel as="p" className="mb-1 tracking-wide">
                        {t(`version_check.seed_entity_${type}`)}
                      </SectionLabel>
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
        </TooltipProvider>

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
