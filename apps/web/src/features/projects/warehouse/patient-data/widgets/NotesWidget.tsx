import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import { FileText, Search, X, Plus, Trash2, ChevronDown, ArrowDownUp } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { usePatientChartContext } from '../PatientChartContext'
import { usePatientChartStore, type NotesConfig } from '@/stores/patient-chart-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { sanitizeHtml } from '@/lib/sanitize'
import { buildNotesQuery } from '@/lib/duckdb/patient-data-queries'
import { formatDate as fmtDate } from '@/lib/format-helpers'

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

interface WordSet {
  label: string
  words: string[]
}

// ---------------------------------------------------------------------------
// Highlight color palette (for word sets)
// ---------------------------------------------------------------------------

/** Each word set gets a distinct highlight color. Index by set position. */
const WORD_SET_COLORS = [
  { bg: 'bg-yellow-200 dark:bg-yellow-500/30', css: 'background:rgb(254 240 138);', cssDark: 'background:rgba(234 179 8 / 0.3);' },
  { bg: 'bg-cyan-200 dark:bg-cyan-500/30', css: 'background:rgb(165 243 252);', cssDark: 'background:rgba(6 182 212 / 0.3);' },
  { bg: 'bg-pink-200 dark:bg-pink-500/30', css: 'background:rgb(251 207 232);', cssDark: 'background:rgba(236 72 153 / 0.3);' },
  { bg: 'bg-lime-200 dark:bg-lime-500/30', css: 'background:rgb(217 249 157);', cssDark: 'background:rgba(132 204 22 / 0.3);' },
  { bg: 'bg-orange-200 dark:bg-orange-500/30', css: 'background:rgb(254 215 170);', cssDark: 'background:rgba(249 115 22 / 0.3);' },
  { bg: 'bg-violet-200 dark:bg-violet-500/30', css: 'background:rgb(221 214 254);', cssDark: 'background:rgba(139 92 246 / 0.3);' },
]

/** Text search always uses the first color (yellow). */
const SEARCH_COLOR_INDEX = 0

function getWordSetColorIndex(setIndex: number): number {
  // Offset by 1 so text search (yellow) and first word set don't collide
  return (setIndex + 1) % WORD_SET_COLORS.length
}

// ---------------------------------------------------------------------------
// Badge color palette (auto-assigned to distinct note types)
// ---------------------------------------------------------------------------

const BADGE_PALETTE = [
  'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  'bg-pink-500/15 text-pink-700 dark:text-pink-400',
  'bg-red-500/15 text-red-700 dark:text-red-400',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400',
  'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  'bg-gray-500/15 text-gray-700 dark:text-gray-400',
]

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

/** Split text around matches, returning segments with optional color index. */
function coloredHighlightSegments(
  text: string,
  coloredWords: ColoredWord[],
): Array<{ text: string; colorIndex: number | null }> {
  if (coloredWords.length === 0) return [{ text, colorIndex: null }]

  const escaped = coloredWords
    .filter((cw) => cw.word.trim())
    .map((cw) => ({
      ...cw,
      pattern: cw.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    }))
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

function NoteTypeBadge({ type, colorClass }: { type: string; colorClass: string }) {
  if (!type) return null
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight ${colorClass}`}
    >
      {type}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Word Sets Popover
// ---------------------------------------------------------------------------

function WordSetsPopover({
  wordSets,
  activeWords,
  onToggleWord,
  onAddSet,
  onRemoveSet,
}: {
  wordSets: WordSet[]
  activeWords: Set<string>
  onToggleWord: (word: string, setIndex: number) => void
  onAddSet: (label: string, words: string[]) => void
  onRemoveSet: (index: number) => void
}) {
  const { t } = useTranslation()
  const [newLabel, setNewLabel] = useState('')
  const [newWords, setNewWords] = useState('')

  const handleAdd = () => {
    const label = newLabel.trim()
    const words = newWords
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean)
    if (label && words.length > 0) {
      onAddSet(label, words)
      setNewLabel('')
      setNewWords('')
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
          <Search size={12} />
          {t('patient_data.notes_word_sets')}
          <ChevronDown size={12} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <div className="space-y-3">
          <p className="text-xs font-medium">{t('patient_data.notes_word_sets')}</p>

          {wordSets.map((ws, i) => {
            const ci = getWordSetColorIndex(i)
            const colorCls = WORD_SET_COLORS[ci].bg
            return (
              <div key={i} className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className={`inline-block h-2.5 w-2.5 rounded-sm ${colorCls}`} />
                    <span className="text-xs font-medium">{ws.label}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0"
                    onClick={() => onRemoveSet(i)}
                  >
                    <Trash2 size={10} />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {ws.words.map((word) => (
                    <button
                      key={word}
                      onClick={() => onToggleWord(word, i)}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                        activeWords.has(word.toLowerCase())
                          ? `${colorCls} text-foreground`
                          : 'bg-muted text-muted-foreground hover:bg-muted/80'
                      }`}
                    >
                      {word}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}

          {/* Add new set */}
          <div className="space-y-1.5 border-t pt-2">
            <p className="text-[10px] text-muted-foreground">{t('patient_data.notes_add_word_set')}</p>
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder={t('patient_data.notes_set_name')}
              className="h-7 text-xs"
            />
            <Input
              value={newWords}
              onChange={(e) => setNewWords(e.target.value)}
              placeholder={t('patient_data.notes_set_words_placeholder')}
              className="h-7 text-xs"
            />
            <Button size="sm" className="h-7 w-full text-xs" onClick={handleAdd}>
              <Plus size={12} className="mr-1" />
              {t('common.add')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Main widget
// ---------------------------------------------------------------------------

export function NotesWidget({ widgetId }: { widgetId: string }) {
  const { t, i18n } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const { selectedPatientId, selectedVisitId, widgets, updateWidgetConfig } =
    usePatientChartStore()
  const patientId = selectedPatientId[projectUid] ?? null
  const visitId = selectedVisitId[projectUid] ?? null

  const widget = widgets.find((w) => w.id === widgetId)
  const config = (widget?.config ?? {}) as NotesConfig

  const [notes, setNotes] = useState<NoteRow[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedNoteId, setSelectedNoteId] = useState<number | null>(null)
  const [nameFilter, setNameFilter] = useState('')
  const [textSearch, setTextSearch] = useState('')
  const [sortNewestFirst, setSortNewestFirst] = useState(false)
  // Map: lowercase word → { setIndex } for color tracking
  const [activeHighlightWords, setActiveHighlightWords] = useState<
    Map<string, { setIndex: number }>
  >(new Map())
  const contentRef = useRef<HTMLDivElement>(null)

  // Dynamic badge color map: type string → palette class
  const badgeColorMap = useMemo(() => {
    const types = [...new Set(notes.map((n) => n.note_type).filter(Boolean))].sort()
    const map = new Map<string, string>()
    types.forEach((type, i) => {
      map.set(type, BADGE_PALETTE[i % BADGE_PALETTE.length])
    })
    return map
  }, [notes])

  // Load notes
  useEffect(() => {
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
  }, [dataSourceId, schemaMapping, patientId, visitId])

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
    // The SQL returns DESC by default; reverse if user wants oldest first
    return sortNewestFirst ? result : [...result].reverse()
  }, [filteredNotes, textSearch, sortNewestFirst])

  const selectedNote = notes.find((n) => n.note_id === selectedNoteId) ?? null

  // Build colored word list for highlighting
  const coloredWords = useMemo<ColoredWord[]>(() => {
    const words: ColoredWord[] = []
    // Text search tokens → yellow (index 0)
    if (textSearch.trim()) {
      for (const token of textSearch.trim().split(/\s+/)) {
        if (token) words.push({ word: token, colorIndex: SEARCH_COLOR_INDEX })
      }
    }
    // Active word set words → their set color
    for (const [word, { setIndex }] of activeHighlightWords) {
      words.push({ word, colorIndex: getWordSetColorIndex(setIndex) })
    }
    return words
  }, [textSearch, activeHighlightWords])

  const handleToggleWord = useCallback((word: string, setIndex: number) => {
    setActiveHighlightWords((prev) => {
      const next = new Map(prev)
      const lower = word.toLowerCase()
      if (next.has(lower)) {
        next.delete(lower)
      } else {
        next.set(lower, { setIndex })
      }
      return next
    })
  }, [])

  // For the popover: build a Set<string> of active lowercase words
  const activeWordsSet = useMemo(
    () => new Set(activeHighlightWords.keys()),
    [activeHighlightWords],
  )

  const handleAddWordSet = useCallback(
    (label: string, words: string[]) => {
      const current = config.wordSets ?? []
      updateWidgetConfig(widgetId, {
        ...config,
        wordSets: [...current, { label, words }],
      })
    },
    [widgetId, config, updateWidgetConfig],
  )

  const handleRemoveWordSet = useCallback(
    (index: number) => {
      const current = config.wordSets ?? []
      const removed = current[index]
      if (removed) {
        setActiveHighlightWords((prev) => {
          const next = new Map(prev)
          for (const w of removed.words) {
            next.delete(w.toLowerCase())
          }
          return next
        })
      }
      updateWidgetConfig(widgetId, {
        ...config,
        wordSets: current.filter((_, i) => i !== index),
      })
    },
    [widgetId, config, updateWidgetConfig],
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
        <div className="relative flex-1">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            placeholder={t('patient_data.notes_filter_name')}
            className="h-7 pl-7 text-xs"
          />
          {nameFilter && (
            <button
              onClick={() => setNameFilter('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setSortNewestFirst(!sortNewestFirst)}
          title={sortNewestFirst ? t('patient_data.notes_sort_oldest') : t('patient_data.notes_sort_newest')}
        >
          <ArrowDownUp size={12} />
        </Button>
        <div className="relative flex-1">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={textSearch}
            onChange={(e) => setTextSearch(e.target.value)}
            placeholder={t('patient_data.notes_search_text')}
            className="h-7 pl-7 text-xs"
          />
          {textSearch && (
            <button
              onClick={() => setTextSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <WordSetsPopover
          wordSets={config.wordSets ?? []}
          activeWords={activeWordsSet}
          onToggleWord={handleToggleWord}
          onAddSet={handleAddWordSet}
          onRemoveSet={handleRemoveWordSet}
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
              <div className="p-1">
                {displayNotes.map((note) => (
                  <button
                    key={note.note_id}
                    onClick={() => setSelectedNoteId(note.note_id)}
                    className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors ${
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
                      <NoteTypeBadge
                        type={note.note_type}
                        colorClass={badgeColorMap.get(note.note_type) ?? 'bg-muted text-muted-foreground'}
                      />
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
                      <NoteTypeBadge
                        type={selectedNote.note_type}
                        colorClass={badgeColorMap.get(selectedNote.note_type) ?? 'bg-muted text-muted-foreground'}
                      />
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

  // Plain text
  const paragraphs = text.split(/\n{2,}/)

  return (
    <div className="space-y-2">
      {paragraphs.map((para, i) => {
        const lines = para.split('\n')
        return (
          <div key={i}>
            {lines.map((line, j) => (
              <p key={j} className="text-xs leading-relaxed whitespace-pre-wrap">
                {coloredWords.length > 0
                  ? coloredHighlightSegments(line, coloredWords).map((seg, k) =>
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
                  : line}
              </p>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** Highlight words inside HTML with per-word colors. */
function highlightInHtml(html: string, coloredWords: ColoredWord[]): string {
  if (coloredWords.length === 0) return html

  const escaped = coloredWords
    .filter((cw) => cw.word.trim())
    .map((cw) => ({
      ...cw,
      pattern: cw.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    }))
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
