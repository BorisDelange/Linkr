/**
 * Content keys — how a dashboard, tab or widget is addressed in an export tree.
 *
 * A key is derived from the *content* (the English name, the grid position, the
 * parent), never from a database id. That is what makes an export byte-stable:
 * a delete+reimport re-derives the same keys, so the git diff shows a change
 * only where content actually changed.
 *
 * These live here rather than in the app because two writers need them — the
 * app's export path and the authoring serializer — and a key derived two
 * different ways is not a cosmetic bug: a widget whose key drifts is re-imported
 * as a *different* widget, orphaning whatever pointed at it.
 *
 * Deliberately structural: the inputs are the fields a key is built from, not
 * the app's entity types, so this package stays free of app imports.
 */
import { slugify } from './ids.js'
import { readLocalized } from './check.js'

/** Name in any accepted form; the English value is what a key is built from. */
type NameInput = string | Record<string, string | undefined> | undefined

export interface TabKeyInput {
  id: string
  name: NameInput
  parentTabId?: string | null
  displayOrder?: number
}

export interface WidgetKeyInput {
  id: string
  name: NameInput
  tabId: string
  layout: { x: number; y: number }
}

/**
 * A dashboard's key: the slug of its English name.
 *
 * The export filename is normally the same slug, but it follows the name — the
 * name is the source. Deriving this from the filename instead looks equivalent
 * until a rename, after which the two disagree and every tab key built on the
 * wrong one addresses a dashboard that does not exist. Nothing catches that at
 * write time; the import simply drops those tabs and their widgets.
 */
export function dashboardKey(name: NameInput, fallback = ''): string {
  return slugify(readLocalized(name, 'en') || fallback)
}

/**
 * Every tab id → its parent-qualified key.
 *
 * Sub-tabs (one level of nesting) are qualified by their parent's key, root tabs
 * by the dashboard. Siblings colliding on one slug get `#<displayOrder>`.
 */
export function buildTabKeyMap(dashKey: string, tabs: TabKeyInput[]): Map<string, string> {
  const keyOf = new Map<string, string>()
  const seen = new Set<string>()
  // Parents before children, so a sub-tab's parent key is already resolved.
  const ordered = [...tabs].sort((a, b) => (a.parentTabId ? 1 : 0) - (b.parentTabId ? 1 : 0))
  for (const tab of ordered) {
    const base = slugify(readLocalized(tab.name, 'en') || '')
    const parent = tab.parentTabId ? keyOf.get(tab.parentTabId) : null
    let key = `${parent ?? dashKey}/${base}`
    if (seen.has(key)) key = `${key}#${tab.displayOrder ?? 0}`
    seen.add(key)
    keyOf.set(tab.id, key)
  }
  return keyOf
}

/**
 * Code-point order on the id, matching Python's `sorted(key=str)`.
 *
 * The `#i` collision counter below is handed out in iteration order, so reading
 * widgets unordered would give two same-named widgets each other's keys — a
 * silent swap on every re-export. The Python twin sorts identically.
 */
function byId<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)
}

/**
 * Every widget id → its key, qualified by its tab and disambiguated by grid
 * position (widgets have no order field), then `#i` on a tie.
 */
export function buildWidgetKeyMap(
  tabKeyMap: Map<string, string>,
  widgets: WidgetKeyInput[],
): Map<string, string> {
  const keyOf = new Map<string, string>()
  const seen = new Set<string>()
  for (const w of byId(widgets)) {
    const tabKey = tabKeyMap.get(w.tabId) ?? ''
    const base = widgetKey(tabKey, w.name, w.layout)
    let key = base
    for (let i = 1; seen.has(key); i++) key = `${base}#${i}`
    seen.add(key)
    keyOf.set(w.id, key)
  }
  return keyOf
}

/** One widget's key, before collision handling. */
export function widgetKey(
  tabKey: string,
  name: NameInput,
  layout: { x: number; y: number },
): string {
  return `${tabKey}/${slugify(readLocalized(name, 'en') || '')}@${layout.y},${layout.x}`
}

/** One tab's key, before collision handling. */
export function tabKey(parentKey: string, name: NameInput): string {
  return `${parentKey}/${slugify(readLocalized(name, 'en') || '')}`
}

export interface DqCheckKeyInput {
  checkKey?: string | null
  templateKey?: string | null
  name?: NameInput
}

/**
 * Each data-quality check's portable key (`checkKey`), in the order given: the
 * one it carries, else its template key, else the slug of its (English) name — `#<n>` when
 * another check, or one of `taken` (the keys its rule set already holds), has it.
 *
 * Set once at creation and kept after: a quality profile points at a check by
 * this key, so a rename must not move it. Python twin: `check_keys` in
 * apps/api/app/services/dq_check_portable.py.
 */
export function dqCheckKeys(checks: DqCheckKeyInput[], taken: Iterable<string> = []): string[] {
  const seen = new Set(taken)
  return checks.map((c) => {
    const base = c.checkKey || c.templateKey || slugify(readLocalized(c.name, 'en') || 'check')
    let key = base
    for (let n = 2; seen.has(key); n++) key = `${base}#${n}`
    seen.add(key)
    return key
  })
}
