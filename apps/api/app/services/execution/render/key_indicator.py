"""Key Indicator render: server-owned pandas program + spec validation.

The `_KPI_PY` body is ported verbatim from the frontend key-indicator-server.ts
(`_KPI_PY`) — it must stay in parity with the front-only compute in
KeyIndicatorComponent.tsx (numericResult / proportionResult / MiniChart).
Only the spec (chosen column + aggregation options + chart settings) varies per
request.
"""

import json

# The aggregate the big number uses; "none" hides it, "proportion" switches to
# the categorical branch. Anything else is rejected early so an unknown value
# can't reach the Python.
_ALLOWED_AGGREGATE = {
    "mean", "median", "min", "max", "sum", "count",
    "sd", "q1", "q3", "iqr", "proportion", "none",
}
# uniqueAggregation reduces one row per entity: first/last pick the row, the rest
# are numeric reductions handled by _linkr_agg. "any" only applies to a proportion
# (entity matches when one of its rows holds the target); elsewhere it reads as first.
_ALLOWED_UNIQUE_AGG = {"first", "last", "mean", "median", "min", "max", "sum", "any"}
_ALLOWED_CHART = {"none", "histogram", "boxplot", "bar", "pie"}


def validate_spec(spec: dict) -> dict:
    """Coerce + validate the client spec into the shape _KPI_PY expects:
    {column: {name: str, numeric: bool}|None, uniquePer: str|None,
     uniqueAggregation: str, aggregate: str, targetValue: str, excludeNA: bool,
     chartType: str, chartBins: int, xAxisStartZero: bool, decimals: int}.
    Raises ValueError on a malformed spec so the route returns a clean 400."""
    if not isinstance(spec, dict):
        raise ValueError("key-indicator spec must be an object")

    raw_col = spec.get("column")
    if raw_col is None:
        column = None
    elif isinstance(raw_col, dict) and isinstance(raw_col.get("name"), str):
        column = {"name": raw_col["name"], "numeric": bool(raw_col.get("numeric"))}
    else:
        raise ValueError("key-indicator spec.column must be {name, numeric} or null")

    unique_per = spec.get("uniquePer")
    if unique_per is not None and not isinstance(unique_per, str):
        raise ValueError("key-indicator spec.uniquePer must be a string or null")

    unique_agg = spec.get("uniqueAggregation", "first")
    if unique_agg not in _ALLOWED_UNIQUE_AGG:
        unique_agg = "first"

    aggregate = spec.get("aggregate", "mean")
    if aggregate not in _ALLOWED_AGGREGATE:
        raise ValueError("key-indicator spec.aggregate is not a known aggregate")

    chart_type = spec.get("chartType", "none")
    if chart_type not in _ALLOWED_CHART:
        chart_type = "none"

    target_value = spec.get("targetValue")
    target_value = "" if target_value is None else str(target_value)

    try:
        chart_bins = int(spec.get("chartBins", 15))
    except (TypeError, ValueError):
        chart_bins = 15
    # Clamp ≥1: chartBins=0 makes the bin-width `(vmax-vmin)/bins` a div-by-zero in
    # _KPI_PY → an uncaught 500 instead of a clean chart.
    chart_bins = max(1, chart_bins)
    try:
        decimals = int(spec.get("decimals", 1))
    except (TypeError, ValueError):
        decimals = 1
    # Clamp ≥0: a negative decimals raises ValueError in format(v, ".%df" % d).
    decimals = max(0, decimals)

    return {
        "column": column,
        "uniquePer": unique_per,
        "uniqueAggregation": unique_agg,
        "aggregate": aggregate,
        "targetValue": target_value,
        "excludeNA": bool(spec.get("excludeNA", True)),
        "chartType": chart_type,
        "chartBins": chart_bins,
        "xAxisStartZero": bool(spec.get("xAxisStartZero", False)),
        "decimals": decimals,
    }


def build_code(spec: dict) -> str:
    # Embed the spec as a JSON string parsed at runtime — a JSON object literal
    # isn't valid Python (true/false/null), so json.loads() is required.
    embedded = json.dumps(json.dumps(spec))
    return f"{_KPI_PY}\n_linkr_print_kpi(dataset, _json.loads({embedded}))\n"


_KPI_PY = r"""
import json as _json
import math as _math

def _linkr_is_empty(v):
    if v is None:
        return True
    try:
        if isinstance(v, float) and _math.isnan(v):
            return True
    except Exception:
        pass
    s = str(v).strip().lower()
    return s in ("", "na", "nan", "null", "none")

def _linkr_fmt_num(val, decimals=1):
    if val is None:
        return "—"
    return format(val, ".%df" % decimals)

def _linkr_agg(nums, fn):
    import pandas as _pd
    if len(nums) == 0:
        return None
    s = _pd.Series(nums, dtype="float64")
    if fn == "mean": return float(s.mean())
    if fn == "median": return float(s.median())
    if fn == "min": return float(s.min())
    if fn == "max": return float(s.max())
    if fn == "sum": return float(s.sum())
    if fn == "count": return float(len(s))
    if fn == "sd": return float(s.std(ddof=0))
    if fn == "q1": return float(s.quantile(0.25))
    if fn == "q3": return float(s.quantile(0.75))
    if fn == "iqr": return float(s.quantile(0.75) - s.quantile(0.25))
    return None

def _linkr_nice_step(raw_step):
    if raw_step <= 0:
        return 1.0
    magnitude = _math.pow(10, _math.floor(_math.log10(raw_step)))
    residual = raw_step / magnitude
    if residual <= 1: return magnitude
    if residual <= 2: return 2 * magnitude
    if residual <= 5: return 5 * magnitude
    return 10 * magnitude

def _linkr_hist(values, bins, start_at_zero, decimals):
    if len(values) == 0:
        return []
    vmin = min(values)
    vmax = max(values)
    if vmin == vmax:
        return [{"label": _linkr_fmt_num(vmin, decimals), "count": len(values)}]
    if start_at_zero and vmin > 0:
        vmin = 0
    raw_step = (vmax - vmin) / bins
    step = _linkr_nice_step(raw_step)
    nice_min = _math.floor(vmin / step) * step
    nice_max = _math.ceil(vmax / step) * step
    n_bins = int(round((nice_max - nice_min) / step))
    if n_bins <= 0:
        n_bins = 1
    buckets = [{"label": _linkr_fmt_num(nice_min + i * step, decimals), "count": 0} for i in range(n_bins)]
    for v in values:
        idx = int(_math.floor((v - nice_min) / step))
        if idx >= n_bins: idx = n_bins - 1
        if idx < 0: idx = 0
        buckets[idx]["count"] += 1
    return buckets

_LINKR_BOOL_STR = {"true": "true", "false": "false", "True": "true", "False": "false",
                   "TRUE": "true", "FALSE": "false"}

def _linkr_str(series):
    # Comparison form of a cell. pandas renders booleans "True"/"False" while the
    # Target value dropdown (DuckDB CAST AS VARCHAR) and the front (String(v)) both
    # produce "true"/"false" — so a dropdown-chosen boolean could never match here.
    # Lower-case the boolean literals only: a string column holding "True" as text
    # keeps its own casing.
    s = series.astype(str)
    return s.map(lambda v: _LINKR_BOOL_STR.get(v, v))

def _linkr_target_str(value):
    return _LINKR_BOOL_STR.get(value, value)

def _linkr_freq(series):
    counts = _linkr_str(series).value_counts().head(10)
    return [{"name": str(k), "value": int(v)} for k, v in counts.items()]

def _linkr_boxplot_stats(values):
    # Tukey whiskers (Q1-1.5*IQR / Q3+1.5*IQR, pulled back to real data), matching
    # computeBoxplotStats in PlotBuilderComponent.tsx so both plugins draw the same
    # box for the same column. allStats' raw min/max would let one extreme value
    # flatten the box to a sliver.
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    q1 = s[int(_math.floor(n * 0.25))]
    med = s[int(_math.floor(n * 0.5))]
    q3 = s[int(_math.floor(n * 0.75))]
    iqr = q3 - q1
    return {
        "min": max(s[0], q1 - 1.5 * iqr),
        "q1": q1,
        "median": med,
        "q3": q3,
        "max": min(s[-1], q3 + 1.5 * iqr),
        "mean": sum(s) / n,
    }

def _linkr_print_any_row_proportion(df, name, unique_per, target):
    # Long tables (one row per event): an entity matches when ANY of its rows holds
    # the target, and an entity with no value at all stays in the denominator as a
    # non-match. Mirror of anyRowProportion() in KeyIndicatorComponent.tsx.
    import pandas as _pd
    keys = df[unique_per]
    values = df[name]
    filled = values[~values.map(_linkr_is_empty)]
    filled_str = _linkr_str(filled)
    # No target: any non-empty value is a match.
    resolved = target
    hit = _pd.Series(False, index=df.index)
    hit.loc[filled.index] = (filled_str == resolved).to_numpy() if resolved else True
    known = keys.notna()
    per_entity = hit[known].groupby(keys[known], sort=False).any()
    total = int(len(per_entity))
    if total == 0:
        print(_json.dumps({"error": "no_data"}))
        return
    match_count = int(per_entity.sum())
    print(_json.dumps({
        "isProportion": True,
        "result": (match_count / total) * 100,
        "n": total,
        "matchCount": match_count,
        "resolvedTarget": resolved,
        "chart": None,
    }))

def _linkr_print_kpi(dataset, spec):
    import pandas as _pd
    col = spec.get("column")
    if not col or col["name"] not in dataset.columns:
        print(_json.dumps({"error": "no_column"}))
        return
    name = col["name"]
    numeric = col["numeric"]
    unique_per = spec.get("uniquePer")
    unique_agg = spec.get("uniqueAggregation", "first")
    aggregate = spec.get("aggregate", "mean")
    target = _linkr_target_str(str(spec.get("targetValue") or ""))
    exclude_na = spec.get("excludeNA", True)
    chart_type = spec.get("chartType", "none")

    df = dataset

    if unique_per and unique_per in df.columns and unique_agg == "any":
        if aggregate == "proportion":
            _linkr_print_any_row_proportion(df, name, unique_per, target)
            return
        unique_agg = "first"

    # aggregateByEntity: one row per entity. first/last pick the row; numeric aggs
    # (mean/median/min/max/sum) reduce numeric columns, non-numeric keep first.
    # Only the metric column is read below, so only it is reduced: a per-group Python
    # reduce over every column took minutes (and gigabytes) on a wide dataset.
    if unique_per and unique_per in df.columns:
        cols = [unique_per] + ([name] if name != unique_per and name in df.columns else [])
        df = df.loc[df[unique_per].notna(), cols]
        gb = df.groupby(unique_per, sort=False)
        if unique_agg == "last":
            out = gb.last().reset_index()
        else:
            out = gb.first().reset_index()
            if unique_agg != "first" and name != unique_per and name in df.columns:
                nums = _pd.to_numeric(df[name], errors="coerce")
                # Entities with no numeric value keep their first (non-numeric) one.
                if nums.notna().any():
                    stat = nums.groupby(df[unique_per], sort=False).agg(unique_agg)
                    out[name] = out[unique_per].map(stat).where(lambda s: s.notna(), out[name])
        df = out

    series = df[name]
    # metricRows: optionally drop NA/empty of the chosen column.
    if exclude_na:
        mask = ~series.map(_linkr_is_empty)
        metric_series = series[mask]
    else:
        metric_series = series
    metric_n = len(metric_series)

    is_proportion = aggregate == "proportion"

    if is_proportion:
        raw = metric_series[metric_series.notna()]
        raw_str = _linkr_str(raw)
        total = len(raw_str)
        if total == 0:
            print(_json.dumps({"error": "no_data"}))
            return
        resolved_target = target
        if not resolved_target:
            vc = raw_str.value_counts()
            resolved_target = str(vc.index[0]) if len(vc) else ""
        match_count = int((raw_str == resolved_target).sum())
        pct = (match_count / total) * 100
        result = {
            "isProportion": True,
            "result": pct,
            "n": total,
            "matchCount": match_count,
            "resolvedTarget": resolved_target,
        }
    else:
        nonnull_series = series[~series.map(_linkr_is_empty)]
        nonnull = len(nonnull_series)
        target_matches = int((_linkr_str(nonnull_series) == target).sum()) if target else 0
        nums = list(_pd.to_numeric(nonnull_series, errors="coerce").dropna())
        if aggregate == "count":
            res = float(target_matches) if target else float(nonnull if exclude_na else metric_n)
        else:
            res = _linkr_agg(nums, aggregate)
        all_stats = {
            "n": float(nonnull),
            "mean": _linkr_agg(nums, "mean"),
            "median": _linkr_agg(nums, "median"),
            "sd": _linkr_agg(nums, "sd") if len(nums) > 0 else None,
            "min": _linkr_agg(nums, "min"),
            "max": _linkr_agg(nums, "max"),
            "q1": _linkr_agg(nums, "q1"),
            "q3": _linkr_agg(nums, "q3"),
            "iqr": _linkr_agg(nums, "iqr"),
        }
        result = {
            "isProportion": False,
            "result": res,
            "allStats": all_stats,
            "nonNull": nonnull,
            "targetMatches": target_matches,
            "target": target,
        }

    # Chart data (already aggregated: histogram bins or top-10 frequency counts).
    chart = None
    if chart_type == "histogram":
        vals = list(_pd.to_numeric(metric_series[~metric_series.map(_linkr_is_empty)], errors="coerce").dropna())
        chart = {"type": "histogram", "data": _linkr_hist(vals, int(spec.get("chartBins", 15)), bool(spec.get("xAxisStartZero", False)), int(spec.get("decimals", 1)))}
    elif chart_type == "boxplot":
        vals = list(_pd.to_numeric(metric_series[~metric_series.map(_linkr_is_empty)], errors="coerce").dropna())
        stats = _linkr_boxplot_stats(vals)
        # `data` stays empty: the box is described by `stats`, not by a series. The
        # client gates the chart on stats for this type.
        chart = {"type": "boxplot", "data": [], "stats": stats} if stats else None
    elif chart_type in ("bar", "pie"):
        raw = metric_series[metric_series.notna()]
        chart = {"type": chart_type, "data": _linkr_freq(raw)}
    result["chart"] = chart
    print(_json.dumps(result))
"""
