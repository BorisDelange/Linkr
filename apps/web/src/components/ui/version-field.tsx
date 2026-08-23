import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { bumpVersion, type BumpType } from '@/lib/semver'

interface VersionFieldProps {
  value: string
  onChange: (value: string) => void
}

/** Widest first: a major bump is the biggest claim, so it reads left to right. */
const BUMPS: BumpType[] = ['major', 'minor', 'patch']

/**
 * The version input shared by every element's add/edit dialog. Free-text semver
 * (default '0.1.0') — a portable field kept in exports/git.
 *
 * The three bump buttons each show the number they would produce, so choosing a
 * bump never means doing the arithmetic. Taken from the plugin dialog, which had
 * the only good version UI in the app.
 */
export function VersionField({ value, onChange }: VersionFieldProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      {/* The same 3-column grid as the bump row below, so the input lines up
          with the "patch" button rather than sitting at some fixed width that
          drifts as the dialog resizes. The label spans the first two columns. */}
      <div className="grid grid-cols-3 items-center gap-1.5">
        <Label htmlFor="element-version" className="col-span-2">{t('common.version')}</Label>
        <Input
          id="element-version"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.1.0"
          className="h-7 text-right font-mono text-xs"
        />
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {BUMPS.map((type) => (
          <Button
            key={type}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(bumpVersion(value, type))}
            className="h-auto flex-col gap-0 py-1.5"
          >
            <span className="font-medium">{t(`common.bump_${type}`)}</span>
            <span className="text-[10px] text-muted-foreground">{bumpVersion(value, type)}</span>
          </Button>
        ))}
      </div>
    </div>
  )
}
