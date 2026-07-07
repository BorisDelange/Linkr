import type { DatasetColumn } from '@/types'

/**
 * Build the pandas code that computes Table 1 server-side and prints the same
 * Table1Data JSON the client computes from rows. Executed via /execute with the
 * dataset (already renamed id→name, filtered) injected as `dataset`, so only the
 * small aggregate crosses the wire — never the rows. Must stay in parity with
 * computeTable1 / computeMetrics in Table1Component.tsx.
 */
export function buildTable1Code(
  columns: DatasetColumn[],
  selectedColumnIds: string[],
  groupByColumnId: string | null,
  metrics: string[],
): string {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const selected = selectedColumnIds
    .map((id) => byId.get(id))
    .filter((c): c is DatasetColumn => !!c)
    .map((c) => ({ name: c.name, numeric: c.type === 'number' }))
  const groupName = groupByColumnId ? byId.get(groupByColumnId)?.name ?? null : null

  // Embed the spec as a JSON string parsed at runtime — a JSON object literal
  // isn't valid Python (true/false/null), so json.loads() is required.
  const spec = JSON.stringify(JSON.stringify({ selected, group: groupName, metrics }))
  return `${_TABLE1_PY}\n_linkr_print_table1(dataset, _json.loads(${spec}))\n`
}

const _TABLE1_PY = String.raw`
import json as _json
import math as _math

def _linkr_fmt(v, decimals=2):
    if v is None or (isinstance(v, float) and _math.isnan(v)):
        return "—"
    if float(v).is_integer() and abs(v) < 1e6:
        return format(int(v), ",")
    if abs(v) >= 1e6:
        return "%.2e" % v
    return f"%.{decimals}f" % v

_DASH = "—"

def _linkr_metrics(series, total_n, numeric, metrics):
    import pandas as pd
    nonnull = series[series.notna() & (series.astype(str).str.lower() != "null") & (series.astype(str) != "")]
    missing = total_n - len(nonnull)
    out = {}
    if "n" in metrics:
        out["n"] = str(len(nonnull))
    if "missing" in metrics:
        out["missing"] = f"{missing} ({missing / total_n * 100:.1f}%)" if missing > 0 and total_n else _DASH
    if numeric:
        nums = pd.to_numeric(nonnull, errors="coerce").dropna()
        has = len(nums) > 0
        if "mean_sd" in metrics:
            out["mean_sd"] = f"{_linkr_fmt(nums.mean())} ± {_linkr_fmt(nums.std(ddof=0))}" if has else _DASH
        if "median_iqr" in metrics:
            out["median_iqr"] = (f"{_linkr_fmt(nums.median())} [{_linkr_fmt(nums.quantile(0.25))}–{_linkr_fmt(nums.quantile(0.75))}]" if has else _DASH)
        if "min_max" in metrics:
            out["min_max"] = f"{_linkr_fmt(nums.min())} / {_linkr_fmt(nums.max())}" if has else _DASH
        if "range" in metrics:
            out["range"] = _linkr_fmt(nums.max() - nums.min()) if has else _DASH
        if "categories" in metrics:
            out["categories"] = _DASH
    else:
        for m in ("mean_sd", "median_iqr", "min_max", "range"):
            if m in metrics:
                out[m] = _DASH
        if "categories" in metrics:
            counts = nonnull.astype(str).value_counts().head(10)
            out["categories"] = ("; ".join(f"{c}: {n} ({n / total_n * 100:.1f}%)" for c, n in counts.items()) if len(counts) and total_n else _DASH)
    return out

def _linkr_print_table1(dataset, spec):
    selected = spec["selected"]
    metrics = spec["metrics"]
    group = spec.get("group")
    if not selected:
        print(_json.dumps({"headers": [], "metricKeys": [], "rows": [], "groupNames": None}))
        return
    if not group or group not in dataset.columns:
        total_n = len(dataset)
        rows = [{"variable": c["name"],
                 "values": _linkr_metrics(dataset[c["name"]], total_n, c["numeric"], metrics)}
                for c in selected if c["name"] in dataset.columns]
        print(_json.dumps({"headers": ["Variable"] + metrics, "metricKeys": metrics,
                           "rows": rows, "groupNames": None}))
        return
    keys = dataset[group].astype(str).where(dataset[group].notna(), "(Missing)")
    group_names = sorted(keys.unique().tolist())
    headers = ["Variable"]
    metric_keys = []
    for g in group_names:
        for m in metrics:
            headers.append(f"{g} - {m}")
            metric_keys.append(f"{g}::{m}")
    rows = []
    for c in selected:
        if c["name"] not in dataset.columns:
            continue
        values = {}
        for g in group_names:
            sub = dataset[keys == g]
            gm = _linkr_metrics(sub[c["name"]], len(sub), c["numeric"], metrics)
            for m in metrics:
                values[f"{g}::{m}"] = gm.get(m, _DASH)
        rows.append({"variable": c["name"], "values": values})
    print(_json.dumps({"headers": headers, "metricKeys": metric_keys,
                       "rows": rows, "groupNames": group_names}))
`
