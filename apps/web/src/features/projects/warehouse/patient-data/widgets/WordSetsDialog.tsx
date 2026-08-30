import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EditableBadge } from '@/components/ui/editable-badge'
import {
  addWord,
  hasWord,
  labelTaken,
  removeWord,
  renameWord,
  type WordSet,
} from './word-sets'
import { WORD_SET_COLORS, wordSetColorIndex } from './word-set-colors'
import { WordSetColorButton } from './WordSetColorButton'

interface WordSetsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sets: WordSet[]
  /** Saved only on confirm, so Cancel really does discard the whole session. */
  onSave: (next: WordSet[]) => void
}

/**
 * Create, rename, delete word sets and the words inside them.
 *
 * Editing happens on a draft copy and lands on confirm: a set being reworded is
 * half-finished for as long as it takes to type, and saving each keystroke
 * would repaint the document under the user.
 */
export function WordSetsDialog({ open, onOpenChange, sets, onSave }: WordSetsDialogProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<WordSet[]>(sets)
  const [newSetLabel, setNewSetLabel] = useState('')
  // One in-progress word per set, keyed by id: two sets can be open at once and
  // a single shared input would carry text between them.
  const [newWords, setNewWords] = useState<Record<string, string>>({})

  // Reopening shows what is saved, not what a previous cancel left behind.
  useEffect(() => {
    if (open) {
      setDraft(sets)
      setNewSetLabel('')
      setNewWords({})
    }
    // `sets` is deliberately not a dependency: the draft must not be reset by a
    // save landing back on the widget while the dialog is still open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const update = (id: string, change: (set: WordSet) => WordSet) =>
    setDraft((prev) => prev.map((s) => (s.id === id ? change(s) : s)))

  const newLabelConflict = labelTaken(draft, newSetLabel)
  const canAddSet = !!newSetLabel.trim() && !newLabelConflict

  const addSet = () => {
    if (!canAddSet) return
    setDraft((prev) => [...prev, { id: crypto.randomUUID(), label: newSetLabel.trim(), words: [] }])
    setNewSetLabel('')
  }

  const commitWord = (set: WordSet) => {
    const typed = newWords[set.id] ?? ''
    if (!typed.trim() || hasWord(set.words, typed)) return
    update(set.id, (s) => ({ ...s, words: addWord(s.words, typed) }))
    setNewWords((prev) => ({ ...prev, [set.id]: '' }))
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      title={t('patient_data.notes_word_sets')}
      description={t('patient_data.notes_word_sets_description')}
      confirmLabel={t('common.save')}
      onConfirm={() => {
        onSave(draft)
        onOpenChange(false)
      }}
    >
      <div className="space-y-4 p-1">
        {draft.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t('patient_data.notes_no_word_sets')}
          </p>
        )}

        {draft.map((set, i) => {
          const colour = WORD_SET_COLORS[wordSetColorIndex(i, set.color)]
          const typed = newWords[set.id] ?? ''
          const duplicate = !!typed.trim() && hasWord(set.words, typed)
          const labelConflict = labelTaken(draft, set.label, set.id)
          return (
            <div key={set.id} className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                {/* The swatch is the same colour the words take in the document,
                    so the set is recognisable there without reading its name. */}
                <WordSetColorButton
                  setIndex={i}
                  value={set.color}
                  onChange={(color) => update(set.id, (s) => ({ ...s, color }))}
                />
                <Input
                  value={set.label}
                  onChange={(e) => update(set.id, (s) => ({ ...s, label: e.target.value }))}
                  placeholder={t('patient_data.notes_set_name')}
                  aria-invalid={labelConflict}
                  className="h-7 flex-1 text-xs"
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('common.delete')}
                  onClick={() => setDraft((prev) => prev.filter((s) => s.id !== set.id))}
                >
                  <Trash2 size={12} />
                </Button>
              </div>
              {labelConflict && (
                <p className="text-xs text-destructive">{t('patient_data.notes_set_name_taken')}</p>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                {set.words.map((word) => (
                  <EditableBadge
                    key={word}
                    label={word}
                    color={colour.badge}
                    onRename={(next) => update(set.id, (s) => ({ ...s, words: renameWord(s.words, word, next) }))}
                    onRemove={() => update(set.id, (s) => ({ ...s, words: removeWord(s.words, word) }))}
                  />
                ))}
                {set.words.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t('patient_data.notes_set_no_words')}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <Input
                  value={typed}
                  onChange={(e) => setNewWords((prev) => ({ ...prev, [set.id]: e.target.value }))}
                  placeholder={t('patient_data.notes_add_word')}
                  aria-invalid={duplicate}
                  // The shell submits on Enter; here Enter adds the word instead.
                  data-no-enter-submit
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitWord(set)
                    }
                  }}
                  className="h-7 flex-1 text-xs"
                />
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label={t('patient_data.notes_add_word')}
                  disabled={!typed.trim() || duplicate}
                  onClick={() => commitWord(set)}
                >
                  <Plus size={12} />
                </Button>
              </div>
              {duplicate && (
                <p className="text-xs text-muted-foreground">
                  {t('patient_data.notes_word_duplicate')}
                </p>
              )}
            </div>
          )
        })}

        <div className="flex items-center gap-1.5 border-t pt-3">
          <Input
            value={newSetLabel}
            onChange={(e) => setNewSetLabel(e.target.value)}
            placeholder={t('patient_data.notes_new_set_name')}
            aria-invalid={newLabelConflict}
            data-no-enter-submit
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addSet()
              }
            }}
            className="h-7 flex-1 text-xs"
          />
          <Button variant="outline" size="sm-tight" disabled={!canAddSet} onClick={addSet}>
            <Plus size={12} />
            {t('patient_data.notes_add_word_set')}
          </Button>
        </div>
        {newLabelConflict && (
          <p className="text-xs text-destructive">{t('patient_data.notes_set_name_taken')}</p>
        )}
      </div>
    </DialogShell>
  )
}
