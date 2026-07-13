"""Map render: server-owned pandas program + spec validation.

The `_MAP_PY` body is ported verbatim from the frontend map-server.ts (`_MAP_PY`)
— it must stay in parity with the points useMemo in MapComponent.tsx. Only the spec
(resolved column names + popup fields) varies per request.
"""

import json


def validate_spec(spec: dict) -> dict:
    """Coerce + validate the client spec into the shape _MAP_PY expects:
    {lat, lon, color, size, label: str|None, popup: [str]}.
    Raises ValueError on a malformed spec so the route returns a clean 400."""
    if not isinstance(spec, dict):
        raise ValueError("map spec must be an object")

    def _opt_str(key: str) -> str | None:
        v = spec.get(key)
        if v is not None and not isinstance(v, str):
            raise ValueError(f"map spec.{key} must be a string or null")
        return v

    raw_popup = spec.get("popup") or []
    if not isinstance(raw_popup, list) or not all(isinstance(c, str) for c in raw_popup):
        raise ValueError("map spec.popup must be a list of strings")

    return {
        "lat": _opt_str("lat"),
        "lon": _opt_str("lon"),
        "color": _opt_str("color"),
        "size": _opt_str("size"),
        "label": _opt_str("label"),
        "popup": list(raw_popup),
    }


def build_code(spec: dict) -> str:
    # Embed the spec as a JSON string parsed at runtime — a JSON object literal
    # isn't valid Python (true/false/null), so json.loads() is required.
    embedded = json.dumps(json.dumps(spec))
    return f"{_MAP_PY}\n_linkr_print_map(dataset, _json.loads({embedded}))\n"


_MAP_PY = r"""
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
"""
