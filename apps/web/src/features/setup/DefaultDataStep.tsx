/**
 * Setup wizard, step 3 — the default data.
 *
 * Installing it is not a mechanism of its own: it is one catalog entry
 * (`DEFAULT_DATA_ENTRY_ID`, a curated workspace whose children are git links),
 * installed through the very same `useCatalogInstall` the Catalog page and the
 * import dialog use. Nothing here clones, parses or writes an entity — that path
 * exists once, in `lib/catalog/install.ts`, and this screen only chooses to run it.
 *
 * The choice is a checkbox rather than the catalog card: at setup the question is
 * "do you want demo content?", not "which of these entries do you want" — the user
 * has nothing yet to compare it against, and the card's version/author/size chrome
 * answers a question nobody is asking on their first screen. One button carries the
 * decision, and its label follows the checkbox so what happens on click is readable
 * without inferring it from a checkbox two lines up.
 *
 * The catalog is fetched on mount rather than behind a "Load catalog" click, since
 * reaching this step is already the request.
 *
 * Skipping is a first-class answer, and so is a catalog that cannot be reached: an
 * instance with no network must still finish setup, so every failure path here ends
 * in "continue with an empty instance" rather than a dead end.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, PackageOpen, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { CatalogInstallOutcome } from '@/features/catalog/CatalogInstallDialog'
import { useCatalogInstall } from '@/features/catalog/use-catalog-install'
import { useCatalog } from '@/hooks/use-catalog'
import {
  DEFAULT_DATA_ENTRY_ID,
  findDefaultDataEntry,
  recordDefaultDataDecision,
} from '@/lib/catalog/default-data'
import { useAppStore } from '@/stores/app-store'

interface DefaultDataStepProps {
  /** Leave the wizard — the instance is set up either way. */
  onDone: () => void
}

export function DefaultDataStep({ onDone }: DefaultDataStepProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  // `error` is deliberately not read: a catalog that failed to load and one that
  // publishes no default-data entry are the same thing here — an instance that
  // starts empty — and both are covered by `unavailable` below.
  const { entries, loaded, loading, load } = useCatalog()
  const [wanted, setWanted] = useState(true)
  /** Workspace the install created, once it has. Also the "done" flag for this step. */
  const [installedWorkspaceId, setInstalledWorkspaceId] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)

  // A workspace entry installs at instance level, so there is no target workspace
  // to pass — `useCatalogInstall` and `installWorkspaceEntry` both allow the empty
  // one for this type.
  const install = useCatalogInstall('', (id) => setInstalledWorkspaceId(id ?? ''))

  // Fetch on mount: see the header note. `load` is stable and `loaded` flips once,
  // so this runs at most once per mount.
  useEffect(() => {
    if (!loaded && !loading) void load()
  }, [loaded, loading, load])

  const entry = findDefaultDataEntry(entries)
  // Not `!!installedWorkspaceId`: a successful install that reported no id back
  // stores '' — falsy, yet the workspace is genuinely in.
  const didInstall = installedWorkspaceId !== null
  /** No entry to install (catalog unreachable, or it publishes none). */
  const unavailable = !loading && !entry
  const busy = !!install.busyId || leaving

  /** Record the decision, then leave. Recording is best-effort by design. */
  const finish = async (installed: boolean) => {
    setLeaving(true)
    await recordDefaultDataDecision(
      DEFAULT_DATA_ENTRY_ID,
      installed,
      installedWorkspaceId || undefined,
    )
    onDone()
  }

  /**
   * The single action. Install first when asked and not yet done, then leave —
   * so one button covers both the install and the exit rather than making the
   * user press a second one to confirm what they already chose.
   */
  const handleAction = async () => {
    if (wanted && entry && !didInstall) {
      await install.install(entry)
      return
    }
    await finish(didInstall)
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-1 flex items-center gap-2 text-sm font-medium text-foreground">
          <PackageOpen size={16} className="text-primary" />
          {t('setup.data_title')}
        </div>
        <p className="mb-4 text-justify text-xs text-muted-foreground">
          {t('setup.data_description')}
        </p>

        {loading && !loaded && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-4 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t('setup.data_loading')}
          </div>
        )}

        {/* An unreachable catalog is not an error to resolve here — it is simply an
            instance that starts empty. Say so, and let setup finish. */}
        {unavailable && (
          <p className="rounded-md border bg-muted/40 p-4 text-xs text-muted-foreground">
            {t('setup.data_unavailable')}
          </p>
        )}

        {entry && !didInstall && (
          <label
            className={`flex items-center gap-2 rounded-md border px-3 py-3 text-xs ${busy ? 'opacity-50' : 'cursor-pointer'}`}
          >
            <Checkbox
              checked={wanted}
              disabled={busy}
              onCheckedChange={(v) => setWanted(v === true)}
            />
            <span className="font-medium text-foreground">{t('setup.data_install')}</span>
          </label>
        )}

        {didInstall && (
          <div className="flex items-center gap-2 rounded-md border border-green-600/30 bg-green-600/5 p-4 text-xs text-foreground">
            <Check size={14} className="shrink-0 text-green-600" />
            {t('setup.data_installed')}
          </div>
        )}

        {/* The install reports a partial result as a `failure` with `partial` set —
            the workspace is in, some children are not. The outcome dialog says which;
            this only makes sure the step does not read as a clean success. */}
        {install.failure?.partial && (
          <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <TriangleAlert size={14} className="mt-px shrink-0 text-amber-600" />
            {t('setup.data_partial')}
          </div>
        )}

        <div className="flex items-center pt-5">
          <Button size="sm" className="ml-auto" onClick={() => void handleAction()} disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {/* The label states the outcome of the click, so the button reads on its
                own: installing, finishing, or starting empty. */}
            {install.busyId
              ? t('setup.data_installing')
              : wanted && entry && !didInstall
                ? t('setup.data_install_action')
                : didInstall
                  ? t('setup.data_finish')
                  : t('setup.data_skip')}
          </Button>
        </div>
      </CardContent>

      <CatalogInstallOutcome install={install} language={language} />
    </Card>
  )
}
