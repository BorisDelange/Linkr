import { useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { MapContainer, TileLayer, CircleMarker, Tooltip as LeafletTooltip, useMap } from 'react-leaflet'
import type { LatLngBoundsExpression } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { cn } from '@/lib/utils'
import { resolveColor, getLucideIcon, CHART_PALETTES, DEFAULT_COLOR } from '@/lib/plugins/shared-styles'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'

const TILE_LAYERS: Record<string, { url: string; attribution: string }> = {
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
  },
  'carto-light': {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap, &copy; CARTO',
  },
  'carto-dark': {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap, &copy; CARTO',
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumeric(val: unknown): number {
  if (val == null) return NaN
  if (typeof val === 'number') return val
  const n = Number(String(val).trim())
  return isNaN(n) ? NaN : n
}

interface MapPoint {
  lat: number
  lon: number
  color: string
  radius: number
  label?: string
  popup?: { key: string; value: string }[]
}

/** Imperatively fit the map to the data bounds whenever they change. */
function FitBounds({ bounds }: { bounds: LatLngBoundsExpression | null }) {
  const map = useMap()
  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 })
  }, [bounds, map])
  return null
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MapComponent({ config, columns, rows, compact }: ComponentPluginProps) {
  const { t } = useTranslation()

  const title = (config.title as string) ?? ''
  const basemap = (config.basemap as string) ?? 'osm'
  const showLegend = (config.showLegend as boolean) ?? true
  const cardIcon = (config.cardIcon as string) ?? '__none__'

  const latCol = config.latColumn as string | undefined
  const lonCol = config.lonColumn as string | undefined
  const colorCol = config.colorColumn as string | undefined
  const sizeCol = config.sizeColumn as string | undefined
  const labelCol = config.labelColumn as string | undefined
  const popupCols = (config.popupColumns as string[] | undefined) ?? []

  const markerColorName = (config.markerColor as string) ?? 'blue'
  const pointSize = (config.pointSize as number) ?? 6
  const opacityPct = (config.opacity as number) ?? 80
  const paletteName = (config.colorPalette as string) ?? 'default'

  const opacity = opacityPct / 100
  const palette = CHART_PALETTES[paletteName] ?? CHART_PALETTES.default
  const baseColor = resolveColor(markerColorName)

  const colById = useMemo(() => new Map(columns.map(c => [c.id, c])), [columns])

  // Map each distinct category value to a palette color
  const colorScale = useMemo(() => {
    if (!colorCol) return null
    const cats = Array.from(new Set(rows.map(r => String(r[colorCol] ?? '')).filter(v => v !== ''))).sort()
    const map = new Map<string, string>()
    cats.forEach((c, i) => map.set(c, palette[i % palette.length]))
    return map
  }, [colorCol, rows, palette])

  // Scale numeric size column into a pixel radius range
  const sizeScale = useMemo(() => {
    if (!sizeCol) return null
    const vals = rows.map(r => toNumeric(r[sizeCol])).filter(v => !isNaN(v))
    if (vals.length === 0) return null
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    return { min, max }
  }, [sizeCol, rows])

  const points = useMemo<MapPoint[]>(() => {
    if (!latCol || !lonCol) return []
    const out: MapPoint[] = []
    for (const r of rows) {
      const lat = toNumeric(r[latCol])
      const lon = toNumeric(r[lonCol])
      if (isNaN(lat) || isNaN(lon)) continue
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue

      // resolveColor maps 'none'/unknown names to a neutral hex; fall back to the design-system default.
      let color = markerColorName === 'none' ? DEFAULT_COLOR.hex : baseColor.hex
      if (colorScale) color = colorScale.get(String(r[colorCol!] ?? '')) ?? color

      let radius = pointSize
      if (sizeScale && sizeCol) {
        const v = toNumeric(r[sizeCol])
        if (!isNaN(v) && sizeScale.max > sizeScale.min) {
          const norm = (v - sizeScale.min) / (sizeScale.max - sizeScale.min)
          radius = pointSize + norm * pointSize * 2.5
        }
      }

      const popup = popupCols.length > 0
        ? popupCols.map(cid => ({ key: colById.get(cid)?.name ?? cid, value: String(r[cid] ?? '') }))
        : undefined

      out.push({
        lat, lon, color, radius,
        label: labelCol ? String(r[labelCol] ?? '') : undefined,
        popup,
      })
    }
    return out
  }, [latCol, lonCol, rows, baseColor, markerColorName, colorScale, colorCol, sizeScale, sizeCol, pointSize, labelCol, popupCols, colById])

  const bounds = useMemo<LatLngBoundsExpression | null>(() => {
    if (points.length === 0) return null
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat
      if (p.lat > maxLat) maxLat = p.lat
      if (p.lon < minLon) minLon = p.lon
      if (p.lon > maxLon) maxLon = p.lon
    }
    return [[minLat, minLon], [maxLat, maxLon]]
  }, [points])

  // --- Validation / empty states ---
  if (!latCol || !lonCol) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
        {t('datasets.map_select_coords', 'Select latitude and longitude columns to begin.')}
      </div>
    )
  }

  const hasIcon = cardIcon !== '__none__' && cardIcon !== ''
  const Icon = hasIcon ? getLucideIcon(cardIcon) : null
  const tile = TILE_LAYERS[basemap]

  const header = (Icon || title) ? (
    <div className={cn('flex items-center gap-2', compact ? 'px-4 pt-3 pb-1' : 'mb-2')}>
      {Icon && <Icon size={compact ? 16 : 18} className="text-muted-foreground" />}
      {title && (
        <span className={cn('text-xs font-medium truncate text-muted-foreground', !compact && 'text-sm text-foreground/80')}>
          {title}
        </span>
      )}
    </div>
  ) : null

  const mapBody = (
    <div className="relative h-full w-full overflow-hidden rounded-md">
      {points.length === 0 && (
        <div className="absolute inset-0 z-[500] flex items-center justify-center bg-background/60 text-xs text-muted-foreground">
          {t('datasets.map_no_points', 'No valid coordinates to display.')}
        </div>
      )}
      <MapContainer
        center={[46.6, 2.5]}
        zoom={5}
        scrollWheelZoom
        className="h-full w-full"
        style={{ background: '#e8eef2' }}
        attributionControl={!compact}
      >
        {tile && <TileLayer url={tile.url} attribution={tile.attribution} />}
        <FitBounds bounds={bounds} />
        {points.map((p, i) => (
          <CircleMarker
            key={i}
            center={[p.lat, p.lon]}
            radius={p.radius}
            pathOptions={{ color: p.color, fillColor: p.color, fillOpacity: opacity, weight: 1 }}
          >
            {(p.popup || p.label) && (
              <LeafletTooltip direction="top" offset={[0, -2]} opacity={1}>
                <div style={{ fontSize: 11, lineHeight: 1.5 }}>
                  {p.label && <div style={{ fontWeight: 600 }}>{p.label}</div>}
                  {p.popup?.map((f, j) => (
                    <div key={j}><span style={{ opacity: 0.7 }}>{f.key}:</span> {f.value}</div>
                  ))}
                </div>
              </LeafletTooltip>
            )}
          </CircleMarker>
        ))}
      </MapContainer>
      {showLegend && colorScale && colorScale.size > 0 && (
        <div className="absolute bottom-2 right-2 z-[500] max-h-[40%] overflow-auto rounded-md border bg-background/90 px-2 py-1.5 text-[10px] shadow-sm backdrop-blur">
          {Array.from(colorScale.entries()).map(([cat, col]) => (
            <div key={cat} className="flex items-center gap-1.5 py-px">
              <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: col }} />
              <span className="truncate">{cat || '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  if (compact) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="min-h-0 flex-1 px-2 pb-2">{mapBody}</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      {header}
      <div className="min-h-0 flex-1">{mapBody}</div>
    </div>
  )
}
