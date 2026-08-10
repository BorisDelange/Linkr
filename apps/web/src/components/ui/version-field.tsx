import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface VersionFieldProps {
  value: string
  onChange: (value: string) => void
}

/**
 * A minimal inline version input, shared across every element's add/edit dialog so
 * the field looks and behaves the same everywhere. The value is a free-text semver
 * (default '0.1.0', bumped by hand) — a portable field kept in exports/git.
 */
export function VersionField({ value, onChange }: VersionFieldProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor="element-version">
        {t('common.version')}
      </Label>
      <Input
        id="element-version"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0.1.0"
        className="w-28 text-right font-mono"
      />
    </div>
  )
}
