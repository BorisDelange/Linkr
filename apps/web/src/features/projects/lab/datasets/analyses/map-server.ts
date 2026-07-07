import type { DatasetColumn } from '@/types'

/**
 * Build the pandas code that extracts the map's per-row plotting fields server-side
 * and prints {rows: [{lat, lon, colorCat, sizeVal, label, popup}], colorCats, sizeMin,
 * sizeMax}. Only valid coordinates + a few popup fields cross the wire (allowed on the
 * secured client). Palette/radius resolution stays client-side. Parity with the points
 * useMemo in MapComponent (same coord validity + category/size derivation).
 */
export function buildMapCode(columns: DatasetColumn[], config: Record<string, unknown>): string {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const name = (id: unknown): string | null => (typeof id === 'string' ? byId.get(id)?.name ?? null : null)
  const popupCols = ((config.popupColumns as string[] | undefined) ?? [])
    .map((id) => ({ id, name: byId.get(id)?.name ?? id }))
    .filter((c) => byId.has(c.id))

  const spec = {
    lat: name(config.latColumn),
    lon: name(config.lonColumn),
    color: name(config.colorColumn),
    size: name(config.sizeColumn),
    label: name(config.labelColumn),
    popup: popupCols.map((c) => c.name),
  }
  const specStr = JSON.stringify(JSON.stringify(spec))
  return `${_MAP_PY}\n_linkr_print_map(dataset, _json.loads(${specStr}))\n`
}

const _MAP_PY = String.raw`
import json as _json
import math as _math

def _map_num(v):
    if v is None:
        return float("nan")
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip())
    except Exception:
        return float("nan")

def _linkr_print_map(dataset, spec):
    df = dataset
    lat = spec.get("lat"); lon = spec.get("lon")
    color = spec.get("color"); size = spec.get("size")
    label = spec.get("label"); popup = spec.get("popup", [])
    if not lat or not lon or lat not in df.columns or lon not in df.columns:
        print(_json.dumps({"rows": [], "colorCats": [], "sizeMin": None, "sizeMax": None})); return

    out_rows = []
    color_cats = set()
    size_vals = []
    has_color = bool(color) and color in df.columns
    has_size = bool(size) and size in df.columns
    has_label = bool(label) and label in df.columns
    popup_cols = [c for c in popup if c in df.columns]

    for _, r in df.iterrows():
        la = _map_num(r[lat]); lo = _map_num(r[lon])
        if _math.isnan(la) or _math.isnan(lo):
            continue
        if la < -90 or la > 90 or lo < -180 or lo > 180:
            continue
        color_cat = None
        if has_color:
            cv = r[color]
            color_cat = str(cv) if cv is not None else ""
            if color_cat != "":
                color_cats.add(color_cat)
        size_val = None
        if has_size:
            sv = _map_num(r[size])
            if not _math.isnan(sv):
                size_val = sv
                size_vals.append(sv)
        popup_fields = None
        if popup_cols:
            popup_fields = [{"key": c, "value": ("" if r[c] is None else str(r[c]))} for c in popup_cols]
        out_rows.append({
            "lat": la, "lon": lo,
            "colorCat": color_cat,
            "sizeVal": size_val,
            "label": (("" if r[label] is None else str(r[label])) if has_label else None),
            "popup": popup_fields,
        })

    print(_json.dumps({
        "rows": out_rows,
        "colorCats": sorted(color_cats),
        "sizeMin": (min(size_vals) if size_vals else None),
        "sizeMax": (max(size_vals) if size_vals else None),
    }))
`
