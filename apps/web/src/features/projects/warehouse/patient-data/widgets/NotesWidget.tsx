import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Search, X, Plus, Trash2, ChevronDown } from 'lucide-react'
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
import { buildNotesQuery } from '@/lib/duckdb/patient-data-queries'

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
// Fuzzy-ish matching helper
// ---------------------------------------------------------------------------

/** Simple case-insensitive substring match — returns true if all query tokens appear in text. */
function fuzzyMatch(text: string, query: string): boolean {
  if (!query.trim()) return true
  const lower = text.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((token) => lower.includes(token))
}

// ---------------------------------------------------------------------------
// Highlight helper
// ---------------------------------------------------------------------------

/** Split text around matches and return segments for rendering. */
function highlightSegments(
  text: string,
  words: string[],
): Array<{ text: string; highlight: boolean }> {
  if (words.length === 0) return [{ text, highlight: false }]

  // Build a single regex for all words
  const escaped = words
    .filter((w) => w.trim())
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (escaped.length === 0) return [{ text, highlight: false }]

  const regex = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts: Array<{ text: string; highlight: boolean }> = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), highlight: false })
    }
    parts.push({ text: match[0], highlight: true })
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), highlight: false })
  }

  return parts.length > 0 ? parts : [{ text, highlight: false }]
}

// ---------------------------------------------------------------------------
// Type badge colors
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<string, string> = {
  'Admission note': 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  'Discharge summary': 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  'Progress note': 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  'Nursing note': 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  'Consultation note': 'bg-pink-500/15 text-pink-700 dark:text-pink-400',
  'Operative note': 'bg-red-500/15 text-red-700 dark:text-red-400',
  'Death note': 'bg-gray-500/15 text-gray-700 dark:text-gray-400',
}

function getTypeBadgeClass(type: string): string {
  return TYPE_COLORS[type] ?? 'bg-muted text-muted-foreground'
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NoteTypeBadge({ type }: { type: string }) {
  if (!type) return null
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight ${getTypeBadgeClass(type)}`}
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
  onToggleWord: (word: string) => void
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

          {/* Existing sets */}
          {wordSets.map((ws, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{ws.label}</span>
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
                    onClick={() => onToggleWord(word)}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                      activeWords.has(word.toLowerCase())
                        ? 'bg-cyan-500/20 text-cyan-700 dark:text-cyan-400'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    }`}
                  >
                    {word}
                  </button>
                ))}
              </div>
            </div>
          ))}

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
  const { t } = useTranslation()
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
  const [activeHighlightWords, setActiveHighlightWords] = useState<Set<string>>(
    new Set(),
  )
  const contentRef = useRef<HTMLDivElement>(null)

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
          const noteRows = (rows as NoteRow[]) ?? []
          setNotes(noteRows)
          // Auto-select first note
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

  // Text search — further filter notes that contain the search text
  const displayNotes = useMemo(() => {
    if (!textSearch.trim()) return filteredNotes
    return filteredNotes.filter((n) => fuzzyMatch(n.note_text, textSearch))
  }, [filteredNotes, textSearch])

  const selectedNote = notes.find((n) => n.note_id === selectedNoteId) ?? null

  // All highlight words: text search tokens + active word set words
  const allHighlightWords = useMemo(() => {
    const words: string[] = []
    if (textSearch.trim()) {
      words.push(...textSearch.trim().split(/\s+/))
    }
    for (const w of activeHighlightWords) {
      words.push(w)
    }
    return words.filter(Boolean)
  }, [textSearch, activeHighlightWords])

  const handleToggleWord = useCallback((word: string) => {
    setActiveHighlightWords((prev) => {
      const next = new Set(prev)
      const lower = word.toLowerCase()
      if (next.has(lower)) {
        next.delete(lower)
      } else {
        next.add(lower)
      }
      return next
    })
  }, [])

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
      // Also remove active highlight words from this set
      const removed = current[index]
      if (removed) {
        setActiveHighlightWords((prev) => {
          const next = new Set(prev)
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

  const formatDate = (d: string) => {
    try {
      return new Date(d).toLocaleDateString()
    } catch {
      return d
    }
  }

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
          activeWords={activeHighlightWords}
          onToggleWord={handleToggleWord}
          onAddSet={handleAddWordSet}
          onRemoveSet={handleRemoveWordSet}
        />
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {displayNotes.length}/{notes.length}
        </span>
      </div>

      {/* Content: sidebar + viewer */}
      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <ScrollArea className="w-56 shrink-0 border-r">
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
                  <NoteTypeBadge type={note.note_type} />
                </div>
              </button>
            ))}
          </div>
        </ScrollArea>

        {/* Document viewer */}
        <div ref={contentRef} className="flex-1 overflow-auto p-4">
          {selectedNote ? (
            <div>
              {/* Header */}
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
              {/* Note text */}
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <NoteTextRenderer
                  text={selectedNote.note_text}
                  highlightWords={allHighlightWords}
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
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Note text renderer — handles plain text and HTML, with highlighting
// ---------------------------------------------------------------------------

function NoteTextRenderer({
  text,
  highlightWords,
}: {
  text: string
  highlightWords: string[]
}) {
  // Check if text looks like HTML
  const isHtml = /<[a-z][\s\S]*>/i.test(text)

  if (isHtml && highlightWords.length === 0) {
    // Render HTML directly (trusted content from our own generated notes)
    return <div dangerouslySetInnerHTML={{ __html: text }} />
  }

  if (isHtml && highlightWords.length > 0) {
    // For HTML with highlights, we inject <mark> tags into the HTML
    const highlighted = highlightInHtml(text, highlightWords)
    return <div dangerouslySetInnerHTML={{ __html: highlighted }} />
  }

  // Plain text — split into paragraphs and highlight
  const paragraphs = text.split(/\n{2,}/)

  return (
    <div className="space-y-2">
      {paragraphs.map((para, i) => {
        const lines = para.split('\n')
        return (
          <div key={i}>
            {lines.map((line, j) => (
              <p key={j} className="text-xs leading-relaxed whitespace-pre-wrap">
                {highlightWords.length > 0
                  ? highlightSegments(line, highlightWords).map((seg, k) =>
                      seg.highlight ? (
                        <mark
                          key={k}
                          className="bg-yellow-200 dark:bg-yellow-500/30 rounded-sm px-0.5"
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

/** Highlight words inside HTML by injecting <mark> tags (only in text nodes, not in tags). */
function highlightInHtml(html: string, words: string[]): string {
  if (words.length === 0) return html

  const escaped = words
    .filter((w) => w.trim())
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (escaped.length === 0) return html

  const regex = new RegExp(`(${escaped.join('|')})`, 'gi')

  // Split on HTML tags to only process text parts
  const parts = html.split(/(<[^>]*>)/)
  return parts
    .map((part) => {
      if (part.startsWith('<')) return part // HTML tag — leave as-is
      return part.replace(
        regex,
        '<mark class="bg-yellow-200 dark:bg-yellow-500/30 rounded-sm px-0.5">$1</mark>',
      )
    })
    .join('')
}
