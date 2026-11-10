import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  AlertTriangle, ChevronDown, ChevronRight, ExternalLink, Filter, ListChecks, ListMinus, Loader2, PanelLeft, Play,
  Plus, Repeat, Search, ShieldCheck, X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SectionLabel } from '@/components/ui/section-label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SidebarSearchField, SidebarSearchToggle, matchesSidebarSearch, useSidebarSearch } from '@/components/SidebarSearch'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { usableExploreSql } from '@/lib/duckdb/data-quality'
import { DQ_CATEGORIES, type DqCategory, type DqCheckOrigin } from '@/lib/dq-taxonomy'
import { profileGaps, setChecks, setWholeRuleSet, takenChecks, type ProfileRuleSet } from '@/lib/dq-profile'
import { hasLocalizedContent, localized } from '@/lib/localized'
import { groupLabel, groupPath, groupTree, nodeChecks, readCheckGroups, type DqGroupNode } from '@/lib/dq-groups'
import { paths } from '@/lib/paths'
import { cn } from '@/lib/utils'
import { useDqProfileStore } from '@/stores/dq-profile-store'
import type { DqCustomCheck, DqProfile, DqProfileSource, DqRuleSet } from '@/types'
import { AddProfileChecksDialog } from './AddProfileChecksDialog'
import { DqCheckRow } from './DqCheckRow'
import { DqCheckTree } from './DqCheckTree'
import { foldLevels, groupFoldKey } from './check-tree'
import { CATEGORY_COLORS, SEVERITY_CONFIG } from './DqConstants'
import { DqTestResult } from './DqTestResult'
import { FoldLevelButton } from './FoldLevelButton'
import { useCheckTest } from './use-check-test'
import { OPEN_GROUPS_UP_TO, useFoldState, type FoldNode } from './use-fold-state'

interface Props {
  profile: DqProfile
  /** The workspace's rule sets, the ones the profile draws from first. */
  ruleSets: ProfileRuleSet[]
  /** The profile's database, '' when it cannot be read here. */
  dataSourceId: string
  /** Opens the profile's investigation console with this query. */
  onInvestigate: (sql: string) => void
}

type OriginFilter = 'all' | DqCheckOrigin
type CategoryFilter = 'all' | DqCategory
const ORIGINS: DqCheckOrigin[] = ['ddl', 'mapping', 'manual']

const ruleSetKey = (ruleSetId: string) => `rs:${ruleSetId}`
/** Fold-key scope of one rule set's groups. */
const groupScope = (ruleSetId: string) => `rs:${ruleSetId}:`

const groupsOf = (ruleSet: DqRuleSet) => readCheckGroups(ruleSet.checkGroups)

/** Rule sets, then their groups level by level, for `FoldLevelButton`. */
function foldLevelsOf(groups: { ruleSet: DqRuleSet; tree: { roots: DqGroupNode<DqCustomCheck>[]; ungrouped: DqCustomCheck[] } }[]): FoldNode[][] {
  const below = groups.map((g) => {
    const scope = groupScope(g.ruleSet.id)
    const parent = ruleSetKey(g.ruleSet.id)
    const levels = foldLevels(g.tree.roots, scope, parent)
    const other = g.tree.ungrouped.length ? [{ key: groupFoldKey(scope, ''), parent }] : []
    return levels.length ? [[...levels[0], ...other], ...levels.slice(1)] : other.length ? [other] : []
  })
  const depth = Math.max(0, ...below.map((l) => l.length))
  return [
    groups.map((g) => ({ key: ruleSetKey(g.ruleSet.id) })),
    ...Array.from({ length: depth }, (_, i) => below.flatMap((l) => l[i] ?? [])),
  ]
}

/**
 * The checks a profile takes, grouped by rule set, laid out like a rule set's
 * Checks tab: filters, search, select several. They are added from a table of
 * every check of the workspace's rule sets (+), and only read here — a check is
 * edited in its rule set. Test runs it on the profile's database.
 */
export function DqProfileChecksTab({ profile, ruleSets, dataSourceId, onInvestigate }: Props) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const canWrite = useMyWorkspaceRole().can('data-quality:write')
  const checksByRuleSet = useDqProfileStore((s) => s.checksByRuleSet)
  const updateProfile = useDqProfileStore((s) => s.updateProfile)

  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const search = useSidebarSearch()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [queryField, setQueryField] = useState<'sql' | 'exploreSql'>('sql')
  const [addOpen, setAddOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const { testing, result: testResult, run: runTest, clear: clearTestResult } = useCheckTest(dataSourceId)

  const save = useCallback((sources: DqProfileSource[]) => updateProfile(profile.id, { sources }), [updateProfile, profile.id])

  // The rule sets the profile takes checks from, each with those checks, in profile order.
  const taken = useMemo(() => ruleSets.flatMap((prs) => {
    const source = profile.sources.find((s) => s.ruleSetId === prs.ruleSet.id)
    if (!source) return []
    return [{ ...prs, source, checks: takenChecks(source, checksByRuleSet[prs.ruleSet.id] ?? []) }]
  }), [ruleSets, profile.sources, checksByRuleSet])
  const allTaken = useMemo(() => taken.flatMap((g) => g.checks), [taken])
  // Rule sets start open; their tables too, while the profile is short.
  const fold = useFoldState((key) => key.startsWith('rs:') || allTaken.length <= OPEN_GROUPS_UP_TO)
  const isOpen = (key: string) => !!search.query || fold.isOpen(key)

  const filtered = originFilter !== 'all' || categoryFilter !== 'all'
  const groups = useMemo(() => taken
    .map((g) => {
      const checks = g.checks.filter((c) =>
        (originFilter === 'all' || c.origin === originFilter)
        && (categoryFilter === 'all' || c.category === categoryFilter)
        && (matchesSidebarSearch(localized(c.name, i18n.language), search.query)
          || matchesSidebarSearch(groupPath(groupsOf(g.ruleSet), c.groupKey).map((step) => groupLabel(step, i18n.language)).join(' '), search.query)))
      return { ...g, checks, tree: groupTree(readCheckGroups(g.ruleSet.checkGroups), checks, { keepEmpty: false }) }
    })
    .filter((g) => g.checks.length > 0 || (!filtered && !search.query)),
  [taken, originFilter, categoryFilter, search.query, filtered, i18n.language])
  const visibleChecks = groups.flatMap((g) => g.checks)

  const selectedGroup = taken.find((g) => g.checks.some((c) => c.id === selectedId))
  const selected = selectedGroup
    ? { check: selectedGroup.checks.find((c) => c.id === selectedId)!, ruleSet: selectedGroup.ruleSet }
    : null

  const gaps = useMemo(
    () => profileGaps(profile.sources, ruleSets.map((r) => r.ruleSet), checksByRuleSet),
    [profile.sources, ruleSets, checksByRuleSet],
  )
  const missingCount = gaps.missingRuleSets.length + Object.values(gaps.missingChecks).flat().length
  const dropMissing = () => void save(profile.sources
    .filter((s) => !gaps.missingRuleSets.includes(s.ruleSetId))
    .map((s) => {
      const gone = gaps.missingChecks[s.ruleSetId]
      return gone ? { ...s, checkKeys: (s.checkKeys ?? []).filter((k) => !gone.includes(k)) } : s
    })
    .filter((s) => s.mode === 'all' || (s.checkKeys ?? []).length > 0))

  /** Leave these checks out of the profile, wherever they come from. */
  const removeChecks = (checks: DqCustomCheck[]) => {
    let sources = profile.sources
    for (const g of taken) {
      const keys = checks.filter((c) => c.ruleSetId === g.ruleSet.id).map((c) => c.checkKey)
      if (!keys.length) continue
      const allKeys = (checksByRuleSet[g.ruleSet.id] ?? []).map((c) => c.checkKey)
      sources = setChecks(sources, { id: g.ruleSet.id, ref: g.ref }, allKeys, keys, false)
    }
    setSelectedIds(new Set())
    return save(sources)
  }

  /** `all` follows the rule set as it grows; `selected` freezes today's list. */
  const setFollows = (g: (typeof taken)[number], follows: boolean) => {
    if (follows) return save(setWholeRuleSet(profile.sources, { id: g.ruleSet.id, ref: g.ref }, true))
    const keys = (checksByRuleSet[g.ruleSet.id] ?? []).map((c) => c.checkKey)
    return save(profile.sources.map((s) => (s.ruleSetId === g.ruleSet.id ? { ...s, mode: 'selected' as const, checkKeys: keys } : s)))
  }

  const openRuleSet = (ruleSetId: string, workspaceId: string) =>
    navigate(`${paths.warehouseDqRuleSet(workspaceId, ruleSetId)}?tab=checks`)

  const toggleSelected = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const allSelected = visibleChecks.length > 0 && visibleChecks.every((c) => selectedIds.has(c.id))
  const exitEditMode = () => {
    setEditMode(false)
    setSelectedIds(new Set())
  }
  const selectCheck = (id: string) => {
    setSelectedId(id)
    clearTestResult()
  }

  const investigate = () => {
    if (selected && dataSourceId) onInvestigate(usableExploreSql(selected.check) ?? selected.check.sql)
  }

  const checkRow = (check: DqCustomCheck, ruleSet: DqRuleSet) => (
    <DqCheckRow
      key={check.id}
      id={check.id}
      name={localized(check.name, i18n.language)}
      category={check.category}
      disabled={check.disabled}
      selected={selectedId === check.id && !editMode}
      editMode={editMode}
      checked={selectedIds.has(check.id)}
      onSelect={() => (editMode ? toggleSelected(check.id) : selectCheck(check.id))}
      onToggleSelected={() => toggleSelected(check.id)}
      menu={(
        <>
          <ContextMenuItem onClick={() => openRuleSet(ruleSet.id, ruleSet.workspaceId)}>
            <ExternalLink size={14} />
            {t('data_quality.profile_open_rule_set')}
          </ContextMenuItem>
          {canWrite && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={() => void removeChecks([check])}>
                <ListMinus size={14} />
                {t('data_quality.profile_remove_check')}
              </ContextMenuItem>
            </>
          )}
        </>
      )}
    />
  )

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-1 border-b px-3 py-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant={sidebarVisible ? 'secondary' : 'ghost'} size="icon-xs" onClick={() => setSidebarVisible(!sidebarVisible)}>
                <PanelLeft size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('data_quality.checks')}</TooltipContent>
          </Tooltip>
          {selected && (
            <>
              <Button
                size="sm"
                onClick={() => void runTest(selected.check)}
                disabled={testing || !dataSourceId}
                className="h-6 gap-1 px-2 text-xs"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {testing ? t('data_quality.testing') : t('data_quality.test_check')}
              </Button>
              <Button size="sm" variant="outline" onClick={investigate} disabled={!dataSourceId} className="h-6 gap-1 px-2 text-xs">
                <Search size={14} />
                {t('data_quality.investigate')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6 gap-1 px-2 text-xs"
                onClick={() => openRuleSet(selected.ruleSet.id, selected.ruleSet.workspaceId)}
              >
                <ExternalLink size={12} />
                {t('data_quality.profile_open_in_rule_set', { name: localized(selected.ruleSet.name, i18n.language) })}
              </Button>
            </>
          )}
        </div>

        {missingCount > 0 && (
          <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning-foreground">
            <AlertTriangle size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">{t('data_quality.profile_missing', { count: missingCount })}</span>
            {canWrite && (
              <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={dropMissing}>
                {t('data_quality.profile_drop_missing')}
              </Button>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1">
          <Allotment proportionalLayout={false}>
            <Allotment.Pane preferredSize={300} minSize={180} maxSize={600} visible={sidebarVisible}>
              <div className="flex h-full min-h-0 flex-col border-r">
                <div className="flex items-center justify-between border-b px-3 py-1.5">
                  <SectionLabel>
                    {t('data_quality.checks')}
                    <span className="ml-1.5 font-normal tabular-nums text-muted-foreground/70">
                      {filtered || search.query ? `${visibleChecks.length}/${allTaken.length}` : allTaken.length}
                    </span>
                  </SectionLabel>
                  <div className="flex items-center gap-0.5">
                    <DropdownMenu>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <Button variant={filtered ? 'secondary' : 'ghost'} size="icon-xs">
                              <Filter size={12} />
                            </Button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent>{t('data_quality.filters')}</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent align="end" density="compact" className="w-44">
                        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('data_quality.filter_origin')}</DropdownMenuLabel>
                        <DropdownMenuCheckboxItem checked={originFilter === 'all'} onCheckedChange={() => setOriginFilter('all')}>
                          {t('data_quality.filter_all')}
                        </DropdownMenuCheckboxItem>
                        {ORIGINS.map((o) => (
                          <DropdownMenuCheckboxItem key={o} checked={originFilter === o} onCheckedChange={() => setOriginFilter(o)}>
                            {t(`data_quality.origin_${o}`)}
                          </DropdownMenuCheckboxItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('data_quality.filter_category')}</DropdownMenuLabel>
                        <DropdownMenuCheckboxItem checked={categoryFilter === 'all'} onCheckedChange={() => setCategoryFilter('all')}>
                          {t('data_quality.filter_all')}
                        </DropdownMenuCheckboxItem>
                        {DQ_CATEGORIES.map((c) => (
                          <DropdownMenuCheckboxItem key={c} checked={categoryFilter === c} onCheckedChange={() => setCategoryFilter(c)}>
                            {t(`data_quality.category_${c}`)}
                          </DropdownMenuCheckboxItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {canWrite && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant={editMode ? 'secondary' : 'ghost'} size="icon-xs" onClick={() => (editMode ? exitEditMode() : setEditMode(true))}>
                            <ListChecks size={13} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{editMode ? t('common.done') : t('data_quality.select_multiple')}</TooltipContent>
                      </Tooltip>
                    )}
                    <FoldLevelButton
                      levels={foldLevelsOf(groups)}
                      isOpen={fold.isOpen}
                      onFold={fold.setOpen}
                      disabled={!!search.query}
                    />
                    <SidebarSearchToggle open={search.open} onToggle={search.toggle} label={t('data_quality.search_checks')} />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" disabled={!canWrite} onClick={() => setAddOpen(true)}>
                          <Plus size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('data_quality.profile_add_checks')}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                {search.open && (
                  <SidebarSearchField
                    value={search.query}
                    onChange={search.setQuery}
                    onClose={search.toggle}
                    placeholder={t('data_quality.search_checks')}
                  />
                )}

                {editMode && (
                  <div className="flex items-center gap-1 border-b bg-accent/30 px-2 py-1">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={() => setSelectedIds(allSelected ? new Set() : new Set(visibleChecks.map((c) => c.id)))}
                      className="size-3.5 shrink-0"
                      aria-label={t('data_quality.select_all')}
                    />
                    <span className="mr-auto text-[10px] text-muted-foreground">
                      {t('data_quality.n_selected', { count: selectedIds.size })}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={selectedIds.size === 0}
                          onClick={() => void removeChecks(allTaken.filter((c) => selectedIds.has(c.id)))}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <ListMinus size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('data_quality.profile_remove_checks')}</TooltipContent>
                    </Tooltip>
                    <Button variant="ghost" size="icon-xs" onClick={exitEditMode}>
                      <X size={12} />
                    </Button>
                  </div>
                )}

                <ScrollArea className="min-h-0 flex-1 overflow-hidden">
                  <div className="p-1.5">
                    {groups.length === 0 ? (
                      <div className="py-8 text-center">
                        <ShieldCheck size={20} className="mx-auto text-muted-foreground/50" />
                        <p className="mt-2 text-[10px] text-muted-foreground">
                          {search.query || filtered ? t('common.no_results') : t('data_quality.profile_no_checks')}
                        </p>
                      </div>
                    ) : groups.map((g) => {
                      const open = isOpen(ruleSetKey(g.ruleSet.id))
                      const total = (checksByRuleSet[g.ruleSet.id] ?? []).length
                      const follows = g.source.mode === 'all'
                      return (
                        <div key={g.ruleSet.id} className="mb-0.5">
                          <ContextMenu>
                            <ContextMenuTrigger asChild>
                              <button
                                type="button"
                                onClick={() => fold.toggle(ruleSetKey(g.ruleSet.id))}
                                className="flex h-6 w-full items-center gap-1 rounded px-1 text-left text-[10px] font-semibold text-muted-foreground hover:bg-accent/50"
                              >
                                {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                                <span className="min-w-0 flex-1 truncate">{localized(g.ruleSet.name, i18n.language)}</span>
                                {follows && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Repeat size={11} className="shrink-0 text-primary" />
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs">{t('data_quality.profile_follows_hint')}</TooltipContent>
                                  </Tooltip>
                                )}
                                <span className="shrink-0 font-normal tabular-nums text-muted-foreground/70">
                                  {g.checks.length === total ? total : `${g.checks.length}/${total}`}
                                </span>
                              </button>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                              <ContextMenuItem onClick={() => openRuleSet(g.ruleSet.id, g.ruleSet.workspaceId)}>
                                <ExternalLink size={14} />
                                {t('data_quality.profile_open_rule_set')}
                              </ContextMenuItem>
                              {canWrite && (
                                <>
                                  <ContextMenuItem onClick={() => void setFollows(g, !follows)}>
                                    <Repeat size={14} />
                                    {follows ? t('data_quality.profile_stop_following') : t('data_quality.profile_follow')}
                                  </ContextMenuItem>
                                  <ContextMenuSeparator />
                                  <ContextMenuItem
                                    variant="destructive"
                                    onClick={() => void save(setWholeRuleSet(profile.sources, { id: g.ruleSet.id }, false))}
                                  >
                                    <ListMinus size={14} />
                                    {t('data_quality.profile_remove_rule_set')}
                                  </ContextMenuItem>
                                </>
                              )}
                            </ContextMenuContent>
                          </ContextMenu>
                          {open && (
                            <div className="space-y-0.5 pl-3">
                              <DqCheckTree
                                roots={g.tree.roots}
                                ungrouped={g.tree.ungrouped}
                                scope={groupScope(g.ruleSet.id)}
                                isOpen={isOpen}
                                onToggle={fold.toggle}
                                isDisabled={(c) => c.disabled}
                                renderCheck={(check) => checkRow(check, g.ruleSet)}
                                groupMenu={canWrite ? (_key, node) => (
                                  <ContextMenuItem
                                    variant="destructive"
                                    onClick={() => void removeChecks(node ? nodeChecks(node) : g.tree.ungrouped)}
                                  >
                                    <ListMinus size={14} />
                                    {t('data_quality.profile_remove_group')}
                                  </ContextMenuItem>
                                ) : undefined}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              </div>
            </Allotment.Pane>

            <Allotment.Pane minSize={400}>
              {selected ? (
                <div className="flex h-full flex-col">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5 text-xs">
                    <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-medium', CATEGORY_COLORS[selected.check.category])}>
                      {t(`data_quality.category_${selected.check.category}`)}
                      {selected.check.subcategory && ` · ${t(`data_quality.subcategory_${selected.check.subcategory}`)}`}
                    </span>
                    <span className={SEVERITY_CONFIG[selected.check.severity].color}>
                      {t(`data_quality.severity_${selected.check.severity}`)}
                    </span>
                    <span className="text-muted-foreground">
                      {t('data_quality.custom_threshold')} {selected.check.threshold}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="ml-auto shrink-0">{t(`data_quality.origin_${selected.check.origin}`)}</Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        {selected.check.templateKey
                          ? <span className="font-mono">{selected.check.templateKey}</span>
                          : t('data_quality.origin_manual_hint')}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {(hasLocalizedContent(selected.check.description) || selected.check.disabled) && (
                    <div className="space-y-0.5 border-b px-3 py-1.5 text-xs text-muted-foreground">
                      {hasLocalizedContent(selected.check.description) && <p>{localized(selected.check.description, i18n.language)}</p>}
                      {selected.check.disabled && (
                        <p className="flex items-center gap-1.5">
                          <AlertTriangle size={12} className="shrink-0" />
                          {t('data_quality.profile_check_disabled')}
                        </p>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-1 border-b px-3 py-1">
                    {(['sql', 'exploreSql'] as const).map((field) => (
                      <Button
                        key={field}
                        variant={queryField === field ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => setQueryField(field)}
                        className="h-6 px-2 text-xs"
                      >
                        {t(field === 'sql' ? 'data_quality.query_count' : 'data_quality.query_explore')}
                      </Button>
                    ))}
                    <span className="ml-auto text-[10px] text-muted-foreground">{t('data_quality.profile_read_only')}</span>
                  </div>
                  <div className="min-h-0 flex-1">
                    <CodeEditor
                      key={`${selected.check.id}:${queryField}`}
                      value={(queryField === 'sql' ? selected.check.sql : selected.check.exploreSql) ?? ''}
                      language="sql"
                      readOnly
                    />
                  </div>
                  {testResult && <DqTestResult result={testResult} onClose={clearTestResult} />}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <ShieldCheck size={32} className="mx-auto text-muted-foreground/50" />
                    <p className="mt-3 text-sm font-medium">
                      {allTaken.length ? t('data_quality.select_check') : t('data_quality.profile_no_checks')}
                    </p>
                    <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                      {allTaken.length ? t('data_quality.profile_select_check_description') : t('data_quality.profile_no_checks_description')}
                    </p>
                    <Button variant="outline" size="sm" className="mt-4 gap-1.5" disabled={!canWrite} onClick={() => setAddOpen(true)}>
                      <Plus size={14} />
                      {t('data_quality.profile_add_checks')}
                    </Button>
                  </div>
                </div>
              )}
            </Allotment.Pane>
          </Allotment>
        </div>
      </div>

      <AddProfileChecksDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        profile={profile}
        ruleSets={ruleSets}
        checksByRuleSet={checksByRuleSet}
        onAdd={save}
      />
    </TooltipProvider>
  )
}
