import { useMemo, useEffect, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { MapContainer, TileLayer, CircleMarker, Tooltip as LeafletTooltip, useMap } from 'react-leaflet'
import type { LatLngBoundsExpression } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { cn } from '@/lib/utils'
import { resolveColor, getLucideIcon, resolvePalette, DEFAULT_COLOR } from '@/lib/plugins/shared-styles'
import { isServerMode } from '@/lib/api-client'
import { renderOnServer } from '@/lib/api/execution'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import { buildMapSpec } from './map-server'

interface MapServerRow {
  lat: number
  lon: number
  colorCat: string | null
  sizeVal: number | null
  label: string | null
  popup: { key: string; value: string }[] | null
}
interface MapServerData {
  rows: MapServerRow[]
  colorCats: string[]
  sizeMin: number | null
  sizeMax: number | null
}

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

/** Tell Leaflet to recompute its size when the container resizes (e.g. widget resize on the
 *  dashboard grid), so tiles that were outside the old viewport get loaded. */
function ResizeHandler() {
  const map = useMap()
  useEffect(() => {
    const container = map.getContainer()
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(container)
    return () => ro.disconnect()
  }, [map])
  return null
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MapComponent({ config, columns, rows, compact, datasetFileId, datasetFilters }: ComponentPluginProps) {
  const { t } = useTranslation()
  const server = isServerMode()

  const title = (config.title as string) ?? ''
  const centerTitle = (config.centerTitle as boolean) ?? true
  const basemap = (config.basemap as string) ?? 'osm'
  const showLegend = (config.showLegend as boolean) ?? true
  const cardIcon = (config.cardIcon as string) ?? '__none__'
  const cardColorName = (config.cardColor as string) ?? 'none'
  const bgColorName = (config.bgColor as string) ?? 'none'
  const titleColorName = (config.titleColor as string) ?? 'auto'

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
  const customPaletteStr = (config.customPalette as string) ?? ''

  const opacity = opacityPct / 100
  const palette = useMemo(() => resolvePalette(paletteName, customPaletteStr), [paletteName, customPaletteStr])
  const baseColor = resolveColor(markerColorName)

  const colById = useMemo(() => new Map(columns.map(c => [c.id, c])), [columns])

  // Server mode: the backend extracts the per-row plotting fields (valid coords +
  // popup values) + category/size metadata. Palette + radius resolution stay here.
  const spec = server && datasetFileId && latCol && lonCol
    ? buildMapSpec(columns, config)
    : null
  const specKey = spec ? JSON.stringify(spec) : null
  const filtersKey = JSON.stringify(datasetFilters ?? null)
  const [serverData, setServerData] = useState<MapServerData | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  useEffect(() => {
    if (!server || !datasetFileId || !spec) return
    let cancelled = false
    renderOnServer('map', spec, { datasetFileId, datasetFilters })
      .then((out) => {
        if (cancelled) return
        if (out.stderr) { setServerError(out.stderr); return }
        try {
          setServerData(JSON.parse(out.stdout.trim()) as MapServerData)
          setServerError(null)
        } catch { setServerError(out.stdout || 'Failed to parse result') }
      })
      .catch((e) => { if (!cancelled) setServerError(String(e)) })
    return () => { cancelled = true }
  }, [server, datasetFileId, specKey, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Map each distinct category value to a palette color
  const colorScale = useMemo(() => {
    if (!colorCol) return null
    const cats = server
      ? (serverData?.colorCats ?? [])
      : Array.from(new Set(rows.map(r => String(r[colorCol] ?? '')).filter(v => v !== ''))).sort()
    const map = new Map<string, string>()
    cats.forEach((c, i) => map.set(c, palette[i % palette.length]))
    return map
  }, [server, serverData, colorCol, rows, palette])

  // Scale numeric size column into a pixel radius range
  const sizeScale = useMemo(() => {
    if (!sizeCol) return null
    if (server) {
      if (serverData?.sizeMin == null || serverData?.sizeMax == null) return null
      return { min: serverData.sizeMin, max: serverData.sizeMax }
    }
    const vals = rows.map(r => toNumeric(r[sizeCol])).filter(v => !isNaN(v))
    if (vals.length === 0) return null
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    return { min, max }
  }, [server, serverData, sizeCol, rows])

  const points = useMemo<MapPoint[]>(() => {
    if (!latCol || !lonCol) return []
    const out: MapPoint[] = []
    const defColor = markerColorName === 'none' ? DEFAULT_COLOR.hex : baseColor.hex
    const radiusFor = (v: number | null): number => {
      if (v != null && !isNaN(v) && sizeScale && sizeScale.max > sizeScale.min) {
        const norm = (v - sizeScale.min) / (sizeScale.max - sizeScale.min)
        return pointSize + norm * pointSize * 2.5
      }
      return pointSize
    }
    // Server mode: iterate the prepared rows; the client still resolves color + radius.
    if (server) {
      for (const r of serverData?.rows ?? []) {
        const color = colorScale ? colorScale.get(r.colorCat ?? '') ?? defColor : defColor
        out.push({
          lat: r.lat, lon: r.lon, color, radius: radiusFor(r.sizeVal),
          label: r.label ?? undefined,
          popup: r.popup ?? undefined,
        })
      }
      return out
    }
    for (const r of rows) {
      const lat = toNumeric(r[latCol])
      const lon = toNumeric(r[lonCol])
      if (isNaN(lat) || isNaN(lon)) continue
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue

      // resolveColor maps 'none'/unknown names to a neutral hex; fall back to the design-system default.
      let color = defColor
      if (colorScale) color = colorScale.get(String(r[colorCol!] ?? '')) ?? color

      const radius = radiusFor(sizeCol ? toNumeric(r[sizeCol]) : null)

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
  }, [server, serverData, latCol, lonCol, rows, baseColor, markerColorName, colorScale, colorCol, sizeScale, sizeCol, pointSize, labelCol, popupCols, colById])

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
  if (server && serverError) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
        <p className="whitespace-pre-wrap">{serverError}</p>
      </div>
    )
  }
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

  // Card colors, mirroring the KPI / Plot Builder plugins.
  const hasCardColor = cardColorName !== 'none' && cardColorName !== ''
  const cardColor = resolveColor(cardColorName)
  const bgColor = bgColorName !== 'none' && bgColorName !== '' ? resolveColor(bgColorName) : null
  const titleColor = titleColorName !== 'auto' ? resolveColor(titleColorName) : null

  const header = (Icon || title) ? (
    <div className={cn('flex items-center gap-2', compact ? 'px-4 pt-3 pb-1' : 'mb-2', centerTitle && 'justify-center')}>
      {Icon && (
        // eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data
        <Icon
          size={compact ? 16 : 18}
          className={hasCardColor ? cardColor.text : 'text-muted-foreground'}
          style={hasCardColor && cardColor.isCustom ? { color: cardColor.hex } : undefined}
        />
      )}
      {title && (
        <span
          className={cn('text-xs font-medium truncate', titleColor ? titleColor.text : 'text-muted-foreground', !compact && !titleColor && 'text-sm text-foreground/80')}
          style={titleColor?.isCustom ? { color: titleColor.hex } : undefined}
        >
          {title}
        </span>
      )}
    </div>
  ) : null

  // Background styles (independent of the main color), as in the other plugins.
  const bgStyle: CSSProperties = {}
  let bgClasses = ''
  if (bgColor) {
    if (bgColor.isCustom) bgStyle.backgroundColor = `${bgColor.hex}10`
    else bgClasses = bgColor.bg
  }

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
        {/* crossOrigin makes tiles load via CORS so they pass the page's COEP:credentialless
            policy (required for WebR/Pyodide); CARTO and OSM both send Access-Control-Allow-Origin. */}
        {tile && <TileLayer key={basemap} url={tile.url} attribution={tile.attribution} crossOrigin="anonymous" />}
        <FitBounds bounds={bounds} />
        <ResizeHandler />
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
      <div className={cn('flex h-full flex-col', bgClasses)} style={bgStyle}>
        {header}
        <div className="min-h-0 flex-1 px-2 pb-2">{mapBody}</div>
      </div>
    )
  }

  return (
    <div className={cn('flex h-full flex-col gap-2 p-4', bgClasses)} style={bgStyle}>
      {header}
      <div className="min-h-0 flex-1">{mapBody}</div>
    </div>
  )
}
