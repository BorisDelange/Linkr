import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Table2 } from 'lucide-react'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { SchemaBrowser } from '@/features/warehouse/databases/SchemaBrowser'
import { PipelineDbPicker } from './PipelineDbPicker'
import { useRoleSchemas } from './use-role-schemas'

/** Database last looked at, per pipeline, so leaving the tab and coming back
 *  lands on it again instead of resetting to the source. */
const lastPickedByPipeline = new Map<string, string>()

interface Props {
  pipelineId: string
  /** Database to show on arrival — set when the scripts tab sends the user here. */
  initialDataSourceId?: string
}

export function EtlSchemasTab({ pipelineId, initialDataSourceId }: Props) {
  const { t } = useTranslation()
  const { etlPipelines } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const pipeline = etlPipelines.find((p) => p.id === pipelineId)
  const { roleOf, dataSourceIdOf } = useRoleSchemas(pipeline)

  // The pipeline's own databases: its two roles plus the ATHENA reference of its
  // mapping project. Unrelated workspace databases are not addressable here.
  const databases = useMemo(() => (
    [...new Set([
      pipeline?.sourceDataSourceId,
      pipeline?.targetDataSourceId,
      dataSourceIdOf('vocab'),
    ].filter(Boolean) as string[])]
      .map((id) => dataSources.find((ds) => ds.id === id))
      .filter((ds): ds is NonNullable<typeof ds> => !!ds)
  ), [pipeline?.sourceDataSourceId, pipeline?.targetDataSourceId, dataSourceIdOf, dataSources])

  // The pick outlives this component: the tab is unmounted whenever the user
  // looks at another one, so component state alone sent them back to the source
  // database (and re-ran the whole schema load) on every return.
  const [picked, setPicked] = useState<string | null>(() => lastPickedByPipeline.get(pipelineId) ?? null)

  // A NEW "Browse schema" request wins over the remembered pick — that is the
  // user asking for a specific database right now. Comparing the prop against
  // the request already honoured (adjust-state-on-prop-change, no effect) means
  // merely coming back to the tab, with the same request unchanged, leaves the
  // pick alone.
  const [honoured, setHonoured] = useState(initialDataSourceId)
  if (initialDataSourceId !== honoured) {
    setHonoured(initialDataSourceId)
    if (initialDataSourceId) setPicked(initialDataSourceId)
  }

  const candidates = [
    picked ?? undefined,
    initialDataSourceId,
    pipeline?.sourceDataSourceId,
  ]
  const selectedId = candidates.find((id) => id && databases.some((ds) => ds.id === id))
    ?? databases[0]?.id

  // The RESOLVED id, not the raw pick: a fallback the user then keeps browsing
  // is what they should find again, and a pick whose database has since gone
  // must not be remembered.
  useEffect(() => {
    if (selectedId) lastPickedByPipeline.set(pipelineId, selectedId)
  }, [pipelineId, selectedId])

  if (!selectedId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Table2 size={32} className="mx-auto text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">{t('etl.profiling_no_source')}</p>
        </div>
      </div>
    )
  }

  const role = roleOf(selectedId)

  return (
    // No `key`: remounting on every database change threw away the table list,
    // the selected table and the loaded stats, so switching back and forth paid
    // for the whole load again. SchemaBrowser resets what belongs to the
    // database on its own when the id changes.
    <SchemaBrowser
      dataSourceId={selectedId}
      tableQualifier={role ? `${role}.` : undefined}
      toolbarExtra={
        <PipelineDbPicker
          databases={databases}
          selectedId={selectedId}
          onSelect={setPicked}
          roleOf={roleOf}
        />
      }
    />
  )
}
