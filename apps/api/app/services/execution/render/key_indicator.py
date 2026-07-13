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
# are numeric reductions handled by _linkr_agg.
_ALLOWED_UNIQUE_AGG = {"first", "last", "mean", "median", "min", "max", "sum"}
_ALLOWED_CHART = {"none", "histogram", "bar", "pie"}


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

def _linkr_freq(series):
    counts = series.astype(str).value_counts().head(10)
    return [{"name": str(k), "value": int(v)} for k, v in counts.items()]

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
    target = str(spec.get("targetValue") or "")
    exclude_na = spec.get("excludeNA", True)
    chart_type = spec.get("chartType", "none")

    df = dataset

    # aggregateByEntity: one row per entity. first/last pick the row; numeric aggs
    # (mean/median/min/max/sum) reduce numeric columns, non-numeric keep first.
    if unique_per and unique_per in df.columns:
        df = df[df[unique_per].notna()]
        if unique_agg == "first":
            df = df.groupby(unique_per, sort=False, as_index=False).first()
        elif unique_agg == "last":
            df = df.groupby(unique_per, sort=False, as_index=False).last()
        else:
            cols = list(df.columns)
            def _reduce(g):
                out = {}
                for c in cols:
                    if c == unique_per:
                        out[c] = g[c].iloc[0]
                        continue
                    nums = _pd.to_numeric(g[c], errors="coerce").dropna()
                    if len(nums) > 0:
                        out[c] = _linkr_agg(list(nums), unique_agg)
                    else:
                        out[c] = g[c].iloc[0]
                return _pd.Series(out)
            df = (
                df.groupby(unique_per, sort=False, group_keys=False)[cols]
                .apply(_reduce)
                .reset_index(drop=True)
            )

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
        raw_str = raw.astype(str)
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
        target_matches = int((nonnull_series.astype(str) == target).sum()) if target else 0
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
    elif chart_type in ("bar", "pie"):
        raw = metric_series[metric_series.notna()]
        chart = {"type": chart_type, "data": _linkr_freq(raw)}
    result["chart"] = chart
    print(_json.dumps(result))
"""
