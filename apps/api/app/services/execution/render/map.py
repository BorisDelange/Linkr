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

def _map_num_series(col):
    # Vectorised float(str(v).strip()): unparseable or missing -> NaN.
    import pandas as _pd
    if _pd.api.types.is_bool_dtype(col) or _pd.api.types.is_numeric_dtype(col):
        return col.astype("float64")
    return _pd.to_numeric(col.astype(str).str.strip(), errors="coerce")

def _map_str_list(col):
    # String(v ?? '') on the client: a missing value is "", not "None"/"nan"/"NaT".
    import pandas as _pd
    return ["" if _pd.isna(v) else str(v) for v in col.tolist()]

def _linkr_print_map(dataset, spec):
    df = dataset
    lat = spec.get("lat"); lon = spec.get("lon")
    color = spec.get("color"); size = spec.get("size")
    label = spec.get("label"); popup = spec.get("popup", [])
    if not lat or not lon or lat not in df.columns or lon not in df.columns:
        print(_json.dumps({"rows": [], "colorCats": [], "sizeMin": None, "sizeMax": None})); return

    has_color = bool(color) and color in df.columns
    has_size = bool(size) and size in df.columns
    has_label = bool(label) and label in df.columns
    popup_cols = [c for c in popup if c in df.columns]

    # Vectorised: iterrows() over tens of thousands of rows took seconds.
    la = _map_num_series(df[lat]); lo = _map_num_series(df[lon])
    keep = la.between(-90, 90) & lo.between(-180, 180)
    df = df[keep]
    las = la[keep].tolist(); los = lo[keep].tolist()
    n = len(las)
    cats = _map_str_list(df[color]) if has_color else [None] * n
    sizes = [None if _math.isnan(v) else v for v in _map_num_series(df[size]).tolist()] if has_size else [None] * n
    labels = _map_str_list(df[label]) if has_label else [None] * n
    popup_vals = [_map_str_list(df[c]) for c in popup_cols]

    out_rows = []
    for k in range(n):
        out_rows.append({
            "lat": las[k], "lon": los[k],
            "colorCat": cats[k],
            "sizeVal": sizes[k],
            "label": labels[k],
            "popup": [{"key": c, "value": popup_vals[j][k]} for j, c in enumerate(popup_cols)] if popup_cols else None,
        })
    size_vals = [v for v in sizes if v is not None]

    print(_json.dumps({
        "rows": out_rows,
        "colorCats": sorted({c for c in cats if c}) if has_color else [],
        "sizeMin": (min(size_vals) if size_vals else None),
        "sizeMax": (max(size_vals) if size_vals else None),
    }))
"""
