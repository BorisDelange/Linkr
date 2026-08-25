import { useTranslation } from 'react-i18next'
import { FileText, Info, Pencil, Puzzle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { localized } from '@/lib/localized'
import type { PluginListItem } from '@/stores/plugin-editor-store'
import type { EntityLicense, LocalizedString } from '@/types'

interface Props {
  plugin: PluginListItem
  /** A plain string is a legacy, single-language readme; `localized` reads both. */
  readme: LocalizedString | string | undefined
  license: EntityLicense | null
  onEditReadme: () => void
  onSeeLicense: () => void
}

/**
 * The plugin's front page: its README beside the identity card, laid out like
 * every other entity overview.
 */
export function PluginOverviewTab({ plugin, readme, license, onEditReadme, onSeeLicense }: Props) {
  const { i18n } = useTranslation()
  const { resolveAttachmentUrls } = useReadmeAttachments('user-plugin', plugin.id)

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      {/* The README gets the room, with the identity card beside it. `self-start`
          on the second column: the readme stretches to full height and scrolls
          inside itself, while About keeps the height its content needs. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <PluginReadmePreview
          readme={localized(readme, i18n.language)}
          resolveUrls={resolveAttachmentUrls}
          onEdit={onEditReadme}
        />
        <div className="flex flex-col gap-4 self-start">
          <PluginIdentityCard plugin={plugin} license={license} onSeeLicense={onSeeLicense} />
        </div>
      </div>
    </div>
  )
}

/** The README, as much of it as fits, with a way through to edit it. */
function PluginReadmePreview({
  readme,
  resolveUrls,
  onEdit,
}: {
  readme: string
  resolveUrls: (md: string) => string
  onEdit: () => void
}) {
  const { t } = useTranslation()
  // Rewrite attachments/<file> paths to blob URLs so images render, as the
  // README tab does before handing the markdown to the renderer.
  const resolved = resolveUrls(readme)

  return (
    <div className="flex min-h-0 flex-col rounded-xl border bg-card p-5 pr-2 shadow-sm">
      <div className="flex shrink-0 items-center justify-between pr-3">
        <div className="flex items-center gap-2">
          <FileText size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('common.readme')}</h3>
        </div>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={onEdit}>
          <Pencil size={12} />
          {t('common.edit')}
        </Button>
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-3">
        {readme.trim() ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              urlTransform={urlTransform}
            >
              {resolved}
            </ReactMarkdown>
          </div>
        ) : (
          <button
            type="button"
            onClick={onEdit}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            {t('plugins.readme_empty_hint')}
          </button>
        )}
      </div>
    </div>
  )
}

/** What this plugin is, who made it, when, and under what licence. */
function PluginIdentityCard({
  plugin,
  license,
  onSeeLicense,
}: {
  plugin: PluginListItem
  license: EntityLicense | null
  onSeeLicense: () => void
}) {
  const { t, i18n } = useTranslation()
  const { manifest } = plugin
  const description = localized(manifest.description, i18n.language)

  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-4 rounded-xl border bg-card p-5 pb-0 shadow-sm">
      <div className="flex items-center gap-2">
        <Info size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('databases.detail_about')}</h3>
      </div>

      {description && <p className="text-xs break-words text-muted-foreground">{description}</p>}

      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="outline">
          <Puzzle size={11} />
          {manifest.scope === 'warehouse'
            ? t('plugins.scope_warehouse')
            : t('plugins.scope_lab')}
        </Badge>
        {manifest.category && <Badge variant="secondary">{manifest.category}</Badge>}
        {(manifest.languages ?? []).map((lang) => (
          <Badge key={lang} variant="secondary">
            {lang === 'python' ? 'Python' : 'R'}
          </Badge>
        ))}
        {manifest.version && <Badge variant="outline">v{manifest.version}</Badge>}
      </div>

      <CardMetaFooter
        stacked
        createdById={plugin.createdById}
        createdBy={plugin.createdBy}
        createdByDetails={plugin.createdByDetails}
        organization={plugin.organization}
        createdAt={plugin.createdAt}
        updatedAt={plugin.updatedAt}
        license={license ?? undefined}
        showLicenseWhenEmpty
        onOpenLicense={onSeeLicense}
      />
    </div>
  )
}
