import { useMemo, useState } from 'react'
import { CircleMarker, Marker, Tooltip as LeafletTooltip, useMap, useMapEvents } from 'react-leaflet'
import { divIcon, type Map as LeafletMap } from 'leaflet'
import { DEFAULT_COLOR } from '@/lib/plugins/shared-styles'
import { buildClusterIndex, clusterBackground, clusterDiameter, type MapPoint } from './map-clusters'

const compactCount = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

interface View { bbox: [number, number, number, number]; zoom: number }

function readView(map: LeafletMap): View {
  // Padded by half a screen so a pan doesn't reveal an empty edge before moveend.
  const b = map.getBounds().pad(0.5)
  return {
    bbox: [Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())],
    zoom: Math.round(map.getZoom()),
  }
}

function PointMarker({ point, opacity }: { point: MapPoint; opacity: number }) {
  return (
    <CircleMarker
      center={[point.lat, point.lon]}
      radius={point.radius}
      pathOptions={{ color: point.color, fillColor: point.color, fillOpacity: opacity, weight: 1 }}
    >
      {(point.popup || point.label) && (
        <LeafletTooltip direction="top" offset={[0, -2]} opacity={1}>
          <div style={{ fontSize: 11, lineHeight: 1.5 }}>
            {point.label && <div style={{ fontWeight: 600 }}>{point.label}</div>}
            {point.popup?.map((f, j) => (
              <div key={j}><span style={{ opacity: 0.7 }}>{f.key}:</span> {f.value}</div>
            ))}
          </div>
        </LeafletTooltip>
      )}
    </CircleMarker>
  )
}

/** Every point as its own marker: fine for a few hundred, unusable for tens of thousands. */
function AllPoints({ points, opacity }: { points: MapPoint[]; opacity: number }) {
  return <>{points.map((p, i) => <PointMarker key={i} point={p} opacity={opacity} />)}</>
}

/** Points grouped by screen proximity at the current zoom: one bubble (count, color
 *  shares) per group, recomputed on every move. Clicking a bubble zooms until it splits. */
function ClusteredPoints({ points, opacity }: { points: MapPoint[]; opacity: number }) {
  const map = useMap()
  const index = useMemo(() => buildClusterIndex(points), [points])
  const [view, setView] = useState(() => readView(map))
  useMapEvents({ moveend: () => setView(readView(map)) })
  const items = useMemo(() => index.getClusters(view.bbox, view.zoom), [index, view])

  return (
    <>
      {items.map((item) => {
        const [lon, lat] = item.geometry.coordinates
        const props = item.properties
        if (!('cluster' in props) || !props.cluster) {
          const i = (props as { index: number }).index
          return <PointMarker key={`p${i}`} point={points[i]} opacity={opacity} />
        }
        const count = props.point_count
        const background = clusterBackground((props as unknown as { colors: Record<string, number> }).colors, points[0]?.color ?? DEFAULT_COLOR.hex)
        const size = clusterDiameter(count)
        const icon = divIcon({
          className: '',
          iconSize: [size, size],
          html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${background};opacity:${Math.max(opacity, 0.75)};border:2px solid rgba(255,255,255,.85);box-shadow:0 1px 3px rgba(0,0,0,.3);color:#fff;text-shadow:0 0 3px rgba(0,0,0,.6);font:600 11px/1 Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center">${compactCount.format(count)}</div>`,
        })
        return (
          <Marker
            key={`c${props.cluster_id}`}
            position={[lat, lon]}
            icon={icon}
            eventHandlers={{
              click: () => map.flyTo([lat, lon], Math.min(index.getClusterExpansionZoom(props.cluster_id), map.getMaxZoom())),
            }}
          />
        )
      })}
    </>
  )
}

export function MapPointsLayer({ points, opacity, cluster }: { points: MapPoint[]; opacity: number; cluster: boolean }) {
  return cluster ? <ClusteredPoints points={points} opacity={opacity} /> : <AllPoints points={points} opacity={opacity} />
}
