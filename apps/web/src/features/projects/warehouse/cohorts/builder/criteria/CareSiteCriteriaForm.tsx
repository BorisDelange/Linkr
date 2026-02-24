import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronsUpDown, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { queryDataSource } from '@/lib/duckdb/engine'
import type { CareSiteCriteriaConfig, SchemaMapping } from '@/types'

interface CareSiteCriteriaFormProps {
  config: CareSiteCriteriaConfig
  onChange: (config: CareSiteCriteriaConfig) => void
  dataSourceId?: string
  schemaMapping?: SchemaMapping
}

export function CareSiteCriteriaForm({ config, onChange, dataSourceId, schemaMapping }: CareSiteCriteriaFormProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [availableValues, setAvailableValues] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  // Fetch distinct care site values when level or data source changes
  useEffect(() => {
    if (!dataSourceId || !schemaMapping) return

    const fetchValues = async () => {
      setLoading(true)
      try {
        const sql = buildCareSiteQuery(config.careSiteLevel, schemaMapping)
        if (!sql) {
          setAvailableValues([])
          return
        }
        const rows = await queryDataSource(dataSourceId, sql)
        const values = rows
          .map((r) => String(r.care_site_label ?? ''))
          .filter((v) => v.length > 0)
        setAvailableValues(values)
      } catch {
        setAvailableValues([])
      } finally {
        setLoading(false)
      }
    }

    fetchValues()
  }, [dataSourceId, schemaMapping, config.careSiteLevel])

  const toggleValue = (value: string) => {
    const values = config.values.includes(value)
      ? config.values.filter((v) => v !== value)
      : [...config.values, value]
    onChange({ ...config, values })
  }

  const filteredValues = search
    ? availableValues.filter((v) => v.toLowerCase().includes(search.toLowerCase()))
    : availableValues

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.care_site_level')}</Label>
        <Select
          value={config.careSiteLevel}
          onValueChange={(v) => onChange({ ...config, careSiteLevel: v as 'visit' | 'visit_detail', values: [] })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="visit" className="text-xs">
              {t('cohorts.level_visit')}
            </SelectItem>
            <SelectItem value="visit_detail" className="text-xs">
              {t('cohorts.level_visit_detail')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.care_site_values')}</Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-between h-auto min-h-8 text-xs font-normal"
            >
              <span className="flex-1 text-left truncate">
                {config.values.length > 0
                  ? config.values.join(', ')
                  : t('cohorts.care_site_placeholder')}
              </span>
              <ChevronsUpDown size={12} className="shrink-0 opacity-50 ml-1" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
            <div className="p-2 border-b">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('cohorts.care_site_search')}
                className="h-7 text-xs"
              />
            </div>
            <div className="max-h-48 overflow-auto p-1">
              {loading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 size={14} className="animate-spin text-muted-foreground" />
                </div>
              ) : filteredValues.length > 0 ? (
                filteredValues.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleValue(value)}
                    className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-xs hover:bg-muted/50 text-left"
                  >
                    <Checkbox
                      checked={config.values.includes(value)}
                      className="size-3.5"
                      tabIndex={-1}
                    />
                    <span className="truncate">{value}</span>
                  </button>
                ))
              ) : (
                <p className="text-xs text-muted-foreground text-center py-3">
                  {t('cohorts.care_site_no_values')}
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
        {config.values.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {config.values.map((v) => (
              <span
                key={v}
                className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {v}
                <button
                  type="button"
                  onClick={() => toggleValue(v)}
                  className="hover:text-foreground"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function buildCareSiteQuery(level: 'visit' | 'visit_detail', mapping: SchemaMapping): string | null {
  if (level === 'visit') {
    const vt = mapping.visitTable
    if (!vt?.careSiteColumn || !vt?.table) return null
    if (vt.careSiteNameTable && vt.careSiteNameIdColumn && vt.careSiteNameColumn) {
      return `SELECT DISTINCT "${vt.careSiteNameColumn}" AS care_site_label FROM "${vt.careSiteNameTable}" WHERE "${vt.careSiteNameIdColumn}" IN (SELECT DISTINCT "${vt.careSiteColumn}" FROM "${vt.table}" WHERE "${vt.careSiteColumn}" IS NOT NULL) ORDER BY 1`
    }
    return `SELECT DISTINCT "${vt.careSiteColumn}" AS care_site_label FROM "${vt.table}" WHERE "${vt.careSiteColumn}" IS NOT NULL ORDER BY 1`
  } else {
    const vdt = mapping.visitDetailTable
    if (!vdt?.unitColumn || !vdt?.table) return null
    if (vdt.unitNameTable && vdt.unitNameIdColumn && vdt.unitNameColumn) {
      return `SELECT DISTINCT "${vdt.unitNameColumn}" AS care_site_label FROM "${vdt.unitNameTable}" WHERE "${vdt.unitNameIdColumn}" IN (SELECT DISTINCT "${vdt.unitColumn}" FROM "${vdt.table}" WHERE "${vdt.unitColumn}" IS NOT NULL) ORDER BY 1`
    }
    return `SELECT DISTINCT "${vdt.unitColumn}" AS care_site_label FROM "${vdt.table}" WHERE "${vdt.unitColumn}" IS NOT NULL ORDER BY 1`
  }
}
