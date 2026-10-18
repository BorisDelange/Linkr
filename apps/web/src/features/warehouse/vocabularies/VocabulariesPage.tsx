import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { ArrowLeft, BookMarked, Library } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { EntryPointCard } from '@/components/ui/entry-point-card'
import { PageContainer, PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { paths } from '@/lib/paths'
import { getStorage } from '@/lib/storage'
import { findLibrary, vocabularyDataSourceIdFor } from '@/lib/vocabulary-library/resolve'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { DatabaseConnectionConfig } from '@/types'
import { VocabularyBrowser } from '@/features/warehouse/concept-mapping/components/VocabularyBrowser'
import { ConceptSetsBrowser } from './ConceptSetsBrowser'
import { DataDictionariesPanel } from './DataDictionariesPanel'
import { VocabularyLibraryPanel } from './VocabularyLibraryPanel'

type Section = 'home' | 'ohdsi' | 'dictionaries'
type SectionTab = 'browse' | 'library'

/**
 * The workspace's reference terminologies: the OHDSI vocabulary library and the
 * data dictionaries. Every mapping project, ETL and the Concepts page read them.
 * The landing (…/vocabularies) leads to one page per kind, each with a Browse
 * tab and a tab managing what is imported; the tab lives in `?tab=`.
 */
export function VocabulariesPage({ section = 'home' }: { section?: Section }) {
  const { wsUid } = useResolvedParams()
  if (!wsUid) return null
  if (section === 'home') return <VocabulariesHome workspaceId={wsUid} />
  return <VocabularySection workspaceId={wsUid} section={section} />
}

function VocabulariesHome({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const library = useDataSourceStore((s) => findLibrary(s.dataSources, workspaceId))
  const vocabularyCount = ((library?.connectionConfig as DatabaseConnectionConfig | undefined)?.vocabularies ?? []).length
  const [dictionaryCount, setDictionaryCount] = useState(0)

  useEffect(() => {
    getStorage().dataDictionaries.getByWorkspace(workspaceId)
      .then((list) => setDictionaryCount(list.length))
      .catch(() => setDictionaryCount(0))
  }, [workspaceId])

  return (
    <PageContainer width="3xl">
      <PageHeader title={t('vocabularies.title')} description={t('vocabularies.description')} />
      <div className="mt-8 grid grid-cols-2 gap-4">
        <EntryPointCard
          icon={Library}
          accent="vocabularies"
          title={t('vocabularies.ohdsi_title')}
          description={t('vocabularies.ohdsi_widget_description')}
          openLabel={t('vocabularies.ohdsi_widget_open')}
          count={vocabularyCount}
          onClick={() => navigate(paths.warehouseVocabularies(workspaceId, 'ohdsi'))}
        />
        <EntryPointCard
          icon={BookMarked}
          accent="concepts"
          title={t('data_dictionaries.title')}
          description={t('vocabularies.dictionaries_widget_description')}
          openLabel={t('vocabularies.dictionaries_widget_open')}
          count={dictionaryCount}
          onClick={() => navigate(paths.warehouseVocabularies(workspaceId, 'dictionaries'))}
        />
      </div>
    </PageContainer>
  )
}

function VocabularySection({ workspaceId, section }: { workspaceId: string; section: 'ohdsi' | 'dictionaries' }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { can } = useMyWorkspaceRole(workspaceId)
  const canWrite = can('workspace-settings:write')
  const tab: SectionTab = searchParams.get('tab') === 'library' ? 'library' : 'browse'
  const setTab = (next: SectionTab) => setSearchParams(next === 'browse' ? {} : { tab: next }, { replace: true })
  const vocabularyId = useDataSourceStore((s) => vocabularyDataSourceIdFor({ workspaceId }, s.dataSources))

  const ohdsi = section === 'ohdsi'

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        className="shrink-0 px-6 pt-6 pb-2"
        above={(
          <button
            type="button"
            onClick={() => navigate(paths.warehouseVocabularies(workspaceId))}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft size={13} />
            {t('common.back')}
          </button>
        )}
        title={ohdsi ? t('vocabularies.ohdsi_title') : t('data_dictionaries.title')}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as SectionTab)} className="flex min-h-0 flex-1 flex-col px-6">
        <TabsList className="mx-auto w-fit shrink-0">
          <TabsTrigger value="browse">{ohdsi ? t('vocabularies.tab_concepts') : t('vocabularies.tab_concept_sets')}</TabsTrigger>
          <TabsTrigger value="library">{ohdsi ? t('vocabularies.tab_library') : t('vocabularies.tab_dictionaries')}</TabsTrigger>
        </TabsList>

        <TabsContent value="browse" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-5xl pt-2">
            {!ohdsi ? (
              <ConceptSetsBrowser workspaceId={workspaceId} />
            ) : vocabularyId ? (
              <VocabularyBrowser dataSourceId={vocabularyId} />
            ) : (
              <Card>
                <EmptyState
                  icon={Library}
                  title={t('vocabulary_library.empty_title')}
                  description={t('vocabulary_library.empty_description')}
                  action={(
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSearchParams(canWrite ? { tab: 'library', import: '1' } : { tab: 'library' }, { replace: true })}
                    >
                      {t('vocabularies.go_to_library')}
                    </Button>
                  )}
                />
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="library" className="min-h-0 flex-1 overflow-auto pb-6">
          {ohdsi
            ? <VocabularyLibraryPanel workspaceId={workspaceId} canWrite={canWrite} />
            : <DataDictionariesPanel workspaceId={workspaceId} canWrite={canWrite} />}
        </TabsContent>
      </Tabs>
    </div>
  )
}
