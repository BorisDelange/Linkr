import { useState, type ComponentProps } from 'react'
import { Input } from '@/components/ui/input'

/**
 * Keeps what is typed locally and hands it over on blur or Enter. Every commit
 * rebuilds the whole mapping and re-renders every block, so committing per
 * keystroke made typing lag; it also keeps a rename from re-keying the block
 * under the cursor.
 */
function useDraft(value: string, onCommit: (v: string) => void) {
  const [draft, setDraft] = useState(value)
  // Follow a change made elsewhere (a Reset, a revert), not only our own commits.
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setDraft(value)
  }
  const commit = () => {
    if (draft !== value) onCommit(draft)
  }
  return { draft, setDraft, commit }
}

type DraftInputProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string
  onCommit: (v: string) => void
}

export function DraftInput({ value, onCommit, onBlur, onKeyDown, ...rest }: DraftInputProps) {
  const { draft, setDraft, commit } = useDraft(value, onCommit)
  return (
    <Input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        commit()
        onBlur?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        onKeyDown?.(e)
      }}
    />
  )
}
