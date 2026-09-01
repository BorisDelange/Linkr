import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import { FileText, Highlighter, ChevronDown, Settings2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchInput } from '@/components/ui/search-input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { usePatientChartContext } from '../PatientChartContext'
import { useTabVisible } from '../TabVisibilityContext'
import { usePatientChartStore, type NotesConfig } from '@/stores/patient-chart-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { sanitizeHtml } from '@/lib/sanitize'
import { buildNotesQuery } from '@/lib/duckdb/patient-data-queries'
import { formatDate as fmtDate } from '@/lib/format-helpers'
import { SortPopover } from '@/components/ui/sort-popover'
import type { SortState } from '@/components/ui/list-page-toolbar'
import { sortNotes, noteAtOffset, NOTES_SORT_KEYS } from './notes-sort'
import {
  readWordSets,
  appliedSets,
  highlightWords,
  toggleSet,
  matchesAppliedSets,
  type WordSet,
} from './word-sets'
import { WORD_SET_COLORS, SEARCH_COLOR_INDEX, wordSetColorIndex } from './word-set-colors'
import { WordSetsDialog } from './WordSetsDialog'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NoteRow {
  note_id: number
  note_date: string
  note_title: string
  note_text: string
  note_type: string
  visit_id: number | null
}

// ---------------------------------------------------------------------------
// Note type badge style — deliberately neutral: the colored highlights inside
// the note text are what should catch the eye, not the type label.
// ---------------------------------------------------------------------------

const NOTE_TYPE_BADGE_CLASS = 'bg-muted text-muted-foreground'

// ---------------------------------------------------------------------------
// Fuzzy-ish matching helper
// ---------------------------------------------------------------------------

function fuzzyMatch(text: string, query: string): boolean {
  if (!query.trim()) return true
  const lower = text.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((token) => lower.includes(token))
}

// ---------------------------------------------------------------------------
// Colored highlight helpers
// ---------------------------------------------------------------------------

interface ColoredWord {
  word: string
  colorIndex: number
}

/**
 * The words to match, escaped and ordered LONGEST FIRST.
 *
 * Alternation in JS is first-match-wins, not longest-match, so a set holding
 * both "GCS" and "GCS motor" matched only "GCS" in "GCS motor 5". Across two
 * sets it was worse: the shorter word's colour was shown, crediting the wrong
 * set for the hit. Sorting by length makes the longest candidate win.
 */
function escapedWordPatterns(coloredWords: ColoredWord[]): Array<ColoredWord & { pattern: string }> {
  return coloredWords
    .filter((cw) => cw.word.trim())
    .map((cw) => ({
      ...cw,
      pattern: cw.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    }))
    .sort((a, b) => b.word.length - a.word.length)
}

/** Split text around matches, returning segments with optional color index. */
function coloredHighlightSegments(
  text: string,
  coloredWords: ColoredWord[],
): Array<{ text: string; colorIndex: number | null }> {
  if (coloredWords.length === 0) return [{ text, colorIndex: null }]

  const escaped = escapedWordPatterns(coloredWords)
  if (escaped.length === 0) return [{ text, colorIndex: null }]

  const regex = new RegExp(`(${escaped.map((e) => e.pattern).join('|')})`, 'gi')
  const parts: Array<{ text: string; colorIndex: number | null }> = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Build a quick lookup: lowercase word → colorIndex
  const wordColorMap = new Map<string, number>()
  for (const cw of coloredWords) {
    wordColorMap.set(cw.word.toLowerCase(), cw.colorIndex)
  }

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), colorIndex: null })
    }
    const matchedLower = match[0].toLowerCase()
    const ci = wordColorMap.get(matchedLower) ?? coloredWords[0]?.colorIndex ?? 0
    parts.push({ text: match[0], colorIndex: ci })
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), colorIndex: null })
  }

  return parts.length > 0 ? parts : [{ text, colorIndex: null }]
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NoteTypeBadge({ type }: { type: string }) {
  if (!type) return null
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight ${NOTE_TYPE_BADGE_CLASS}`}
    >
      {type}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Word Sets Popover
// ---------------------------------------------------------------------------

/**
 * Applying word sets: one checkbox per set, several at once.
 *
 * Applying is all this does. Creating and rewording live in the editor dialog,
 * because a popover that also authored its own content left no room to do
 * either job properly — sets could not be edited at all, only deleted.
 */
function WordSetsPopover({
  wordSets,
  appliedIds,
  filterToApplied,
  onToggleSet,
  onToggleFilter,
  onClear,
  onEdit,
}: {
  wordSets: WordSet[]
  appliedIds: string[]
  filterToApplied: boolean
  onToggleSet: (id: string) => void
  onToggleFilter: () => void
  onClear: () => void
  onEdit: () => void
}) {
  const { t } = useTranslation()
  const appliedCount = appliedSets(wordSets, appliedIds).length

  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* Filled once something is applied, like the sort control: the widget
            header is the only place that says highlighting is on. */}
        <Button variant={appliedCount > 0 ? 'secondary' : 'ghost'} size="sm-tight" className="px-2">
          <Highlighter size={12} />
          {t('patient_data.notes_word_sets')}
          {appliedCount > 0 && <span className="tabular-nums">{appliedCount}</span>}
          <ChevronDown size={12} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="truncate text-xs font-medium text-muted-foreground">
            {t('patient_data.notes_word_sets')}
          </p>
          {appliedCount > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              {t('common.clear')}
            </button>
          )}
        </div>

        {wordSets.length === 0 ? (
          <p className="px-1.5 py-3 text-center text-xs text-muted-foreground">
            {t('patient_data.notes_no_word_sets')}
          </p>
        ) : (
          <div className="space-y-0.5">
            {wordSets.map((set, i) => {
              const applied = appliedIds.includes(set.id)
              return (
                <label
                  key={set.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs transition-colors hover:bg-accent/30"
                >
                  <Checkbox checked={applied} onCheckedChange={() => onToggleSet(set.id)} />
                  <span
                    className={cn('size-2.5 shrink-0 rounded-sm', WORD_SET_COLORS[wordSetColorIndex(i, set.color)].bg)}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{set.label}</span>
                  {/* The word count is what tells two similarly named sets apart
                      without opening the editor. */}
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {set.words.length}
                  </span>
                </label>
              )
            })}
          </div>
        )}

        {/* Filtering is opt-in and separate from highlighting: a clinician often
            wants every note on screen with the terms picked out, and only
            sometimes wants the list cut down to the notes that carry them. */}
        <label className="mt-1 flex cursor-pointer items-center gap-2 rounded border-t px-1.5 pb-1 pt-2 text-xs transition-colors hover:bg-accent/30">
          <Checkbox checked={filterToApplied} onCheckedChange={() => onToggleFilter()} />
          <span className="min-w-0 flex-1">{t('patient_data.notes_filter_to_word_sets')}</span>
        </label>

        <Button variant="ghost" size="sm-tight" className="mt-1 w-full justify-start" onClick={onEdit}>
          <Settings2 size={12} />
          {t('patient_data.notes_manage_word_sets')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Main widget
// ---------------------------------------------------------------------------

export function NotesWidget({
  widgetId,
  config: configProp,
}: {
  widgetId: string
  /** Unsaved draft from the editor preview; falls back to the stored config. */
  config?: Record<string, unknown>
}) {
  const { t, i18n } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const visible = useTabVisible()
  // Narrow selectors: see PatientSummaryWidget.
  const selectedPatientId = usePatientChartStore((s) => s.selectedPatientId)
  const selectedVisitId = usePatientChartStore((s) => s.selectedVisitId)
  const widgets = usePatientChartStore((s) => s.widgets)
  const updateWidgetConfig = usePatientChartStore((s) => s.updateWidgetConfig)
  const patientId = selectedPatientId[projectUid] ?? null
  const visitId = selectedVisitId[projectUid] ?? null

  const widget = widgets.find((w) => w.id === widgetId)
  const config = (configProp ?? widget?.config ?? {}) as NotesConfig

  const [notes, setNotes] = useState<NoteRow[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedNoteId, setSelectedNoteId] = useState<number | null>(null)
  const [nameFilter, setNameFilter] = useState('')
  const [textSearch, setTextSearch] = useState('')
  // null keeps the query's own order (newest first), which is what a clinician
  // expects to land on.
  const [sort, setSort] = useState<SortState | null>(null)
  const [editingWordSets, setEditingWordSets] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  const wordSets = useMemo(() => readWordSets(config.wordSets), [config.wordSets])
  // Applied sets live in the config, so a board reopens highlighting what it
  // was highlighting — the sets themselves would be pointless otherwise.
  const appliedIds = useMemo(() => config.appliedWordSetIds ?? [], [config.appliedWordSetIds])
  const filterToApplied = config.filterToWordSets ?? false

  // Load notes
  useEffect(() => {
    // Skip while the tab is hidden (keep-alive leaves it mounted); keep the data
    // we already have so revealing the tab doesn't force a refetch.
    if (!visible) return
    if (!dataSourceId || !schemaMapping || !patientId) {
      setNotes([])
      return
    }

    let cancelled = false
    setLoading(true)

    const sql = buildNotesQuery(schemaMapping, patientId, visitId)
    if (!sql) {
      setNotes([])
      setLoading(false)
      return
    }

    queryDataSource(dataSourceId, sql)
      .then((rows) => {
        if (!cancelled) {
          const noteRows = (rows as unknown as NoteRow[]) ?? []
          setNotes(noteRows)
          if (noteRows.length > 0) {
            setSelectedNoteId(noteRows[0].note_id)
          }
        }
      })
      .catch(() => {
        if (!cancelled) setNotes([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [visible, dataSourceId, schemaMapping, patientId, visitId])

  // Reset selection when notes change
  useEffect(() => {
    if (notes.length > 0 && !notes.find((n) => n.note_id === selectedNoteId)) {
      setSelectedNoteId(notes[0].note_id)
    }
  }, [notes, selectedNoteId])

  // Filtered notes (by name/title)
  const filteredNotes = useMemo(() => {
    if (!nameFilter.trim()) return notes
    return notes.filter(
      (n) =>
        fuzzyMatch(n.note_title || '', nameFilter) ||
        fuzzyMatch(n.note_type || '', nameFilter),
    )
  }, [notes, nameFilter])

  // Text search — further filter notes that contain the search text, then sort
  const displayNotes = useMemo(() => {
    let result = filteredNotes
    if (textSearch.trim()) {
      result = result.filter((n) => fuzzyMatch(n.note_text, textSearch))
    }
    if (filterToApplied) {
      result = result.filter((n) => matchesAppliedSets(n.note_text, wordSets, appliedIds))
    }
    return sortNotes(result, sort)
  }, [filteredNotes, textSearch, sort, filterToApplied, wordSets, appliedIds])

  // Resolved against the filtered list, so a note excluded by the current
  // search stops being displayed instead of lingering from before.
  const selectedNote = displayNotes.find((n) => n.note_id === selectedNoteId) ?? null

  const sortFields = useMemo(
    () => [
      { key: NOTES_SORT_KEYS.date, label: t('patient_data.notes_sort_date') },
      { key: NOTES_SORT_KEYS.name, label: t('patient_data.notes_sort_name') },
    ],
    [t],
  )

  // Focus follows the selection so the NEXT arrow starts from the row the user
  // just moved to, and the row is scrolled into view when it is off-screen.
  const selectedRowRef = useRef<HTMLButtonElement>(null)
  const keyboardMoveRef = useRef(false)
  useEffect(() => {
    if (!keyboardMoveRef.current) return
    keyboardMoveRef.current = false
    selectedRowRef.current?.focus({ preventScroll: true })
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedNoteId])

  /** Up/down move through the list, the way a mail client's message list does. */
  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const next = noteAtOffset(displayNotes, selectedNoteId, e.key === 'ArrowDown' ? 1 : -1)
      if (!next) return
      // Only once a move actually happens: at either end the keypress belongs to
      // the scroll container, so the list can still be scrolled past its edge.
      e.preventDefault()
      keyboardMoveRef.current = true
      setSelectedNoteId(next.note_id)
    },
    [displayNotes, selectedNoteId],
  )

  // Build colored word list for highlighting
  const coloredWords = useMemo<ColoredWord[]>(() => {
    const words: ColoredWord[] = []
    // Text search tokens → yellow (index 0)
    if (textSearch.trim()) {
      for (const token of textSearch.trim().split(/\s+/)) {
        if (token) words.push({ word: token, colorIndex: SEARCH_COLOR_INDEX })
      }
    }
    // Every word of every applied set, in that set's colour — the one it was
    // given, or the one its position implies.
    for (const { word, setIndex } of highlightWords(wordSets, appliedIds)) {
      words.push({ word, colorIndex: wordSetColorIndex(setIndex, wordSets[setIndex]?.color) })
    }
    return words
  }, [textSearch, wordSets, appliedIds])

  const handleToggleSet = useCallback(
    (id: string) => {
      updateWidgetConfig(widgetId, { ...config, appliedWordSetIds: toggleSet(appliedIds, id) })
    },
    [widgetId, config, appliedIds, updateWidgetConfig],
  )

  const handleClearSets = useCallback(() => {
    updateWidgetConfig(widgetId, { ...config, appliedWordSetIds: [] })
  }, [widgetId, config, updateWidgetConfig])

  const handleToggleFilter = useCallback(() => {
    updateWidgetConfig(widgetId, { ...config, filterToWordSets: !filterToApplied })
  }, [widgetId, config, filterToApplied, updateWidgetConfig])

  const handleSaveWordSets = useCallback(
    (next: WordSet[]) => {
      // Deleting a set has to un-apply it too, or its id would sit in the config
      // for ever and reappear the day a new set happened to reuse it.
      const alive = new Set(next.map((s) => s.id))
      updateWidgetConfig(widgetId, {
        ...config,
        wordSets: next,
        appliedWordSetIds: appliedIds.filter((id) => alive.has(id)),
      })
    },
    [widgetId, config, appliedIds, updateWidgetConfig],
  )

  const formatDate = (d: string) => fmtDate(d, i18n.language)

  // Scroll content to top when selecting a new note
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0)
  }, [selectedNoteId])

  // No note table in schema
  if (!schemaMapping?.noteTable) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">
          {t('patient_data.no_note_table')}
        </p>
      </div>
    )
  }

  if (!patientId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">
          {t('patient_data.select_patient_first')}
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  if (notes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">
          {t('patient_data.no_data')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <SortPopover
          options={sortFields}
          value={sort}
          onChange={setSort}
          label={t('common.sort_by')}
        />
        <SearchInput
          value={nameFilter}
          onChange={setNameFilter}
          placeholder={t('patient_data.notes_filter_name')}
          size="dense"
          className="flex-1"
        />
        <SearchInput
          value={textSearch}
          onChange={setTextSearch}
          placeholder={t('patient_data.notes_search_text')}
          size="dense"
          className="flex-1"
        />
        <WordSetsPopover
          wordSets={wordSets}
          appliedIds={appliedIds}
          filterToApplied={filterToApplied}
          onToggleSet={handleToggleSet}
          onToggleFilter={handleToggleFilter}
          onClear={handleClearSets}
          onEdit={() => setEditingWordSets(true)}
        />
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {displayNotes.length}/{notes.length}
        </span>
      </div>

      {/* Content: resizable sidebar + viewer */}
      <div className="min-h-0 flex-1">
        <Allotment defaultSizes={[220, 780]} separator>
          {/* Sidebar */}
          <Allotment.Pane minSize={120} maxSize={400}>
            <ScrollArea className="h-full">
              {/* Arrows are handled here rather than per row: the keypress lands on
                  whichever note has focus, and the list stays one tab stop. */}
              <div className="p-1" onKeyDown={handleListKeyDown}>
                {displayNotes.map((note) => (
                  <button
                    key={note.note_id}
                    ref={selectedNoteId === note.note_id ? selectedRowRef : undefined}
                    onClick={() => setSelectedNoteId(note.note_id)}
                    // No focus ring: focus only ever lands here to follow the
                    // selection, which bg-accent already shows.
                    className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors outline-none ${
                      selectedNoteId === note.note_id
                        ? 'bg-accent'
                        : 'hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <FileText size={10} className="shrink-0 text-cyan-500" />
                      <span className="flex-1 truncate text-xs font-medium">
                        {note.note_title || t('patient_data.notes_untitled')}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 pl-4">
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {formatDate(note.note_date)}
                      </span>
                      <NoteTypeBadge type={note.note_type} />
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </Allotment.Pane>

          {/* Document viewer */}
          <Allotment.Pane>
            <div ref={contentRef} className="h-full overflow-auto p-4">
              {selectedNote ? (
                <div>
                  <div className="mb-3 space-y-1">
                    <h3 className="text-sm font-semibold">
                      {selectedNote.note_title || t('patient_data.notes_untitled')}
                    </h3>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {formatDate(selectedNote.note_date)}
                      </span>
                      <NoteTypeBadge type={selectedNote.note_type} />
                      {selectedNote.visit_id && (
                        <span className="text-[10px] text-muted-foreground">
                          Visit {selectedNote.visit_id}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <NoteTextRenderer
                      text={selectedNote.note_text}
                      coloredWords={coloredWords}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-xs text-muted-foreground">
                    {t('patient_data.notes_select_document')}
                  </p>
                </div>
              )}
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>

      {editingWordSets && (
        <WordSetsDialog
          open
          onOpenChange={setEditingWordSets}
          sets={wordSets}
          onSave={handleSaveWordSets}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Note text renderer — handles plain text and HTML, with colored highlighting
// ---------------------------------------------------------------------------

function NoteTextRenderer({
  text,
  coloredWords,
}: {
  text: string
  coloredWords: ColoredWord[]
}) {
  const isHtml = /<[a-z][\s\S]*>/i.test(text)

  if (isHtml && coloredWords.length === 0) {
    return <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(text) }} />
  }

  if (isHtml && coloredWords.length > 0) {
    const highlighted = highlightInHtml(text, coloredWords)
    return <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(highlighted) }} />
  }

  // Plain text. Newlines inside a paragraph are kept by whitespace-pre-wrap
  // rather than one <p> per line: the surrounding `prose` styles give every <p>
  // a full paragraph margin, which would space single line breaks far apart.
  const paragraphs = text.split(/\n{2,}/)

  return (
    <div className="space-y-3">
      {paragraphs.map((para, i) => (
        <p key={i} className="my-0 text-xs leading-relaxed whitespace-pre-wrap">
          {coloredWords.length > 0
            ? coloredHighlightSegments(para, coloredWords).map((seg, k) =>
                seg.colorIndex !== null ? (
                  <mark
                    key={k}
                    className={`${WORD_SET_COLORS[seg.colorIndex]?.bg ?? 'bg-yellow-200 dark:bg-yellow-500/30'} rounded-sm px-0.5`}
                  >
                    {seg.text}
                  </mark>
                ) : (
                  <span key={k}>{seg.text}</span>
                ),
              )
            : para}
        </p>
      ))}
    </div>
  )
}

/** Highlight words inside HTML with per-word colors. */
function highlightInHtml(html: string, coloredWords: ColoredWord[]): string {
  if (coloredWords.length === 0) return html

  const escaped = escapedWordPatterns(coloredWords)
  if (escaped.length === 0) return html

  // Build a lookup for matched word → color
  const wordColorMap = new Map<string, number>()
  for (const cw of coloredWords) {
    wordColorMap.set(cw.word.toLowerCase(), cw.colorIndex)
  }

  const regex = new RegExp(`(${escaped.map((e) => e.pattern).join('|')})`, 'gi')
  const isDark = document.documentElement.classList.contains('dark')

  const parts = html.split(/(<[^>]*>)/)
  return parts
    .map((part) => {
      if (part.startsWith('<')) return part
      return part.replace(regex, (match) => {
        const ci = wordColorMap.get(match.toLowerCase()) ?? 0
        const color = WORD_SET_COLORS[ci]
        const style = isDark ? color?.cssDark : color?.css
        return `<mark style="${style ?? ''}border-radius:2px;padding:0 2px;">${match}</mark>`
      })
    })
    .join('')
}
