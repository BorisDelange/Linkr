import { useState, useRef, useEffect } from 'react'

interface EditableCellProps {
  value: unknown
  onChange: (value: string) => void
}

export function EditableCell({ value, onChange }: EditableCellProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const displayValue = value === null || value === undefined ? '' : String(value)

  const handleSave = () => {
    setEditing(false)
    if (draft !== displayValue) {
      onChange(draft)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="h-full w-full border-0 bg-background px-2 py-1 text-xs outline-none ring-1 ring-primary"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave()
          if (e.key === 'Escape') setEditing(false)
          e.stopPropagation()
        }}
      />
    )
  }

  return (
    <div
      className="truncate px-2 py-1 text-xs cursor-default"
      onDoubleClick={() => {
        setDraft(displayValue)
        setEditing(true)
      }}
      title={displayValue}
    >
      {displayValue === '' ? <span className="text-muted-foreground/50 italic">null</span> : displayValue}
    </div>
  )
}
