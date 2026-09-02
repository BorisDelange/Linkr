import { TriangleAlert } from 'lucide-react'

/**
 * Why the value in the field above can't be committed. Renders nothing when
 * there is no error, so callers can pass a nullable message straight through.
 */
export function FieldError({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <p className="flex items-center gap-1 text-xs text-destructive">
      <TriangleAlert size={12} />
      {message}
    </p>
  )
}
