import type { DatasetColumn } from '@/types'

/**
 * Build the pandas code that computes the Plot Builder chart data server-side and
 * prints a PlotServerData JSON matching the shapes the sub-plots consume front-only.
 * Faithful parity with the per-plot useMemo blocks in PlotBuilderComponent.tsx.
 *
 * Data volume: bar/histogram/boxplot are true aggregates (small). scatter/line and
 * violin ship per-row/per-category values — allowed here (secured client per product
 * decision), matching front-only parity exactly.
 */
export function buildPlotBuilderCode(columns: DatasetColumn[], config: Record<string, unknown>): string {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const colName = (id: string | undefined): string | null => (id ? byId.get(id)?.name ?? null : null)
  const colType = (id: string | undefined): string | null => (id ? byId.get(id)?.type ?? null : null)

  const plotType = (config.plotType as string) ?? 'scatter'
  const histogramOrientation = (config.histogramOrientation as string) ?? 'vertical'
  const xId = config.xColumn as string | undefined
  const yId = config.yColumn as string | undefined
  const groupId = config.groupColumn as string | undefined
  const isHorizontalHistogram = plotType === 'histogram' && histogramOrientation === 'horizontal'
  const histId = isHorizontalHistogram ? yId : xId

  const spec = {
    plotType,
    x: colName(xId),
    y: colName(yId),
    hist: colName(histId),
    xType: colType(xId),
    yType: colType(yId),
    group: groupId && byId.get(groupId) ? colName(groupId) : null,
    uniquePer: config.uniquePer ? colName(config.uniquePer as string) : null,
    uniqueAggregation: (config.uniqueAggregation as string) ?? 'first',
    excludeNA: (config.excludeNA as boolean) ?? true,
    binMode: (config.binMode as string) ?? 'count',
    bins: (config.bins as number) ?? 20,
    binWidth: (config.binWidth as number) ?? 5,
    decimals: (config.decimals as number) ?? 1,
    xAxisStartZero: (config.xAxisStartZero as boolean) ?? false,
  }

  const specStr = JSON.stringify(JSON.stringify(spec))
  return `${_PLOT_PY}\n_linkr_print_plot(dataset, _json.loads(${specStr}))\n`
}

const _PLOT_PY = String.raw`
import json as _json
import math as _math

def _linkr_to_num(v):
    if v is None:
        return float("nan")
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    try:
        return float(s)
    except Exception:
        pass
    import pandas as _pd
    ts = _pd.to_datetime(s, errors="coerce")
    if _pd.isna(ts):
        return float("nan")
    return float(ts.value // 1_000_000)

def _linkr_is_date_range(vals):
    if not vals:
        return False
    mid = vals[len(vals) // 2]
    return 1e11 < mid < 1e14

def _linkr_fmt_bin(val, date_mode, decimals=1):
    if date_mode:
        import pandas as _pd
        return _pd.to_datetime(val, unit="ms").strftime("%b %-d, %Y")
    return format(val, ",.%df" % decimals)

def _linkr_bin_params(vmin, vmax, bin_mode, bins_cfg, bin_width_cfg, start_at_zero):
    eff_min = 0 if (start_at_zero and vmin > 0) else vmin
    if bin_mode == "width" and bin_width_cfg > 0:
        bw = bin_width_cfg
        aligned_min = _math.floor(eff_min / bw) * bw
        aligned_max = _math.ceil(vmax / bw) * bw
        n = max(1, int(round((aligned_max - aligned_min) / bw)))
        return aligned_min, bw, n
    rng = vmax - eff_min
    return eff_min, rng / bins_cfg, bins_cfg

def _linkr_histogram(values, bin_mode, bins_cfg, bin_width_cfg, start_at_zero, decimals):
    if not values:
        return []
    vmin = min(values); vmax = max(values)
    date_mode = _linkr_is_date_range(values)
    if vmin == vmax:
        return [{"bin": _linkr_fmt_bin(vmin, date_mode, decimals), "count": len(values)}]
    start, bw, count = _linkr_bin_params(vmin, vmax, bin_mode, bins_cfg, bin_width_cfg, start_at_zero)
    buckets = [{"bin": _linkr_fmt_bin(start + i * bw, date_mode, decimals), "count": 0} for i in range(count)]
    for v in values:
        idx = int(_math.floor((v - start) / bw))
        if idx < 0: idx = 0
        if idx >= count: idx = count - 1
        buckets[idx]["count"] += 1
    return buckets

def _linkr_histogram_grouped(df, xcol, gcol, bin_mode, bins_cfg, bin_width_cfg, group_names, start_at_zero, decimals):
    all_vals = [_linkr_to_num(v) for v in df[xcol]]
    all_vals = [v for v in all_vals if not _math.isnan(v)]
    if not all_vals:
        return []
    vmin = min(all_vals); vmax = max(all_vals)
    date_mode = _linkr_is_date_range(all_vals)
    if vmin == vmax:
        entry = {"bin": _linkr_fmt_bin(vmin, date_mode, decimals)}
        for g in group_names: entry[g] = 0
        return [entry]
    start, bw, count = _linkr_bin_params(vmin, vmax, bin_mode, bins_cfg, bin_width_cfg, start_at_zero)
    buckets = []
    for i in range(count):
        entry = {"bin": _linkr_fmt_bin(start + i * bw, date_mode, decimals)}
        for g in group_names: entry[g] = 0
        buckets.append(entry)
    for _, row in df.iterrows():
        v = _linkr_to_num(row[xcol])
        if _math.isnan(v): continue
        idx = int(_math.floor((v - start) / bw))
        if idx < 0: idx = 0
        if idx >= count: idx = count - 1
        g = str(row[gcol]) if row[gcol] is not None else ""
        if g in buckets[idx]:
            buckets[idx][g] += 1
    return buckets

def _linkr_is_categorical(df, col):
    total = 0; numeric = 0
    for v in df[col]:
        if v is None or v == "": continue
        total += 1
        if not _math.isnan(_linkr_to_num(v)): numeric += 1
        if total >= 200: break
    if total == 0: return False
    return numeric / total < 0.5

def _linkr_categorical(df, col):
    counts = {}
    for v in df[col]:
        if v is None or v == "": continue
        k = str(v)
        counts[k] = counts.get(k, 0) + 1
    items = sorted(counts.items(), key=lambda kv: -kv[1])
    return [{"bin": k, "count": c} for k, c in items]

def _linkr_categorical_grouped(df, col, gcol, group_names):
    counts = {}
    for _, row in df.iterrows():
        v = row[col]
        if v is None or v == "": continue
        k = str(v)
        g = str(row[gcol]) if row[gcol] is not None else ""
        if g not in group_names: continue
        if k not in counts:
            counts[k] = {n: 0 for n in group_names}
        counts[k][g] += 1
    items = sorted(counts.items(), key=lambda kv: -sum(kv[1][n] for n in group_names))
    out = []
    for k, entry in items:
        row = {"bin": k}
        row.update(entry)
        out.append(row)
    return out

def _linkr_boxplot_stats(values):
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    q1 = s[int(_math.floor(n * 0.25))]
    med = s[int(_math.floor(n * 0.5))]
    q3 = s[int(_math.floor(n * 0.75))]
    iqr = q3 - q1
    wlow = max(s[0], q1 - 1.5 * iqr)
    whigh = min(s[-1], q3 + 1.5 * iqr)
    return {"min": wlow, "q1": q1, "median": med, "q3": q3, "max": whigh, "mean": sum(values) / n}

def _linkr_agg_num(nums, fn):
    if not nums: return nums[0] if nums else None
    import pandas as _pd
    sr = _pd.Series(nums, dtype="float64")
    if fn == "mean": return float(sr.mean())
    if fn == "median": return float(sr.median())
    if fn == "min": return float(sr.min())
    if fn == "max": return float(sr.max())
    if fn == "sum": return float(sr.sum())
    return float(nums[0])

def _linkr_print_plot(dataset, spec):
    import pandas as _pd
    df = dataset
    plot_type = spec["plotType"]

    # aggregateByEntity (uniquePer) — parity with shared-styles.aggregateByEntity.
    up = spec.get("uniquePer")
    ua = spec.get("uniqueAggregation", "first")
    if up and up in df.columns:
        df = df[df[up].notna()]
        if ua == "first":
            df = df.groupby(up, sort=False, as_index=False).first()
        elif ua == "last":
            df = df.groupby(up, sort=False, as_index=False).last()
        else:
            cols = list(df.columns)
            def _reduce(g):
                out = {}
                for c in cols:
                    if c == up:
                        out[c] = g[c].iloc[0]; continue
                    nums = list(_pd.to_numeric(g[c], errors="coerce").dropna())
                    out[c] = _linkr_agg_num(nums, ua) if nums else g[c].iloc[0]
                return _pd.Series(out)
            df = df.groupby(up, sort=False, group_keys=False)[cols].apply(_reduce).reset_index(drop=True)

    x = spec.get("x"); y = spec.get("y"); hist = spec.get("hist"); group = spec.get("group")
    exclude_na = spec.get("excludeNA", True)

    # excludeNA: drop rows where the used X and/or Y is NA/empty/'na'.
    def _empty(v):
        return v is None or v == "" or str(v).strip().lower() == "na"
    if exclude_na:
        mask = _pd.Series(True, index=df.index)
        if x and x in df.columns:
            mask &= ~df[x].map(_empty)
        if y and y in df.columns:
            mask &= ~df[y].map(_empty)
        df = df[mask]

    # group names (sorted string set over non-null values).
    group_names = None
    if group and group in df.columns:
        vals = set()
        for v in df[group]:
            if v is not None:
                vals.add(str(v))
        group_names = sorted(vals)

    result = {"plotType": plot_type, "groupNames": group_names}

    if plot_type in ("scatter", "line"):
        if not x or not y or x not in df.columns or y not in df.columns:
            print(_json.dumps({**result, "series": []})); return
        series = []
        if not group_names or group not in df.columns:
            pts = []
            for _, row in df.iterrows():
                xv = _linkr_to_num(row[x]); yv = _linkr_to_num(row[y])
                if not (_math.isnan(xv) or _math.isnan(yv)):
                    pts.append({"x": xv, "y": yv})
            if plot_type == "line":
                pts.sort(key=lambda p: p["x"])
            series.append({"name": "all", "data": pts})
        else:
            for g in group_names:
                sub = df[df[group].astype(str) == g]
                pts = []
                for _, row in sub.iterrows():
                    xv = _linkr_to_num(row[x]); yv = _linkr_to_num(row[y])
                    if not (_math.isnan(xv) or _math.isnan(yv)):
                        pts.append({"x": xv, "y": yv})
                if plot_type == "line":
                    pts.sort(key=lambda p: p["x"])
                series.append({"name": g, "data": pts})
        print(_json.dumps({**result, "series": series})); return

    if plot_type == "bar":
        if not x or x not in df.columns:
            print(_json.dumps({**result, "data": [], "series": []})); return
        color_by_cat = bool(group) and group == x
        eff_group = None if color_by_cat else group
        eff_group_names = None if color_by_cat else group_names
        if y and y in df.columns:
            if not eff_group_names or eff_group not in df.columns:
                agg = {}
                for _, row in df.iterrows():
                    k = str(row[x]) if row[x] is not None else ""
                    val = _linkr_to_num(row[y])
                    if _math.isnan(val): continue
                    e = agg.setdefault(k, [0.0, 0])
                    e[0] += val; e[1] += 1
                data = [{"name": k, "value": s / c} for k, (s, c) in list(agg.items())[:30]]
                print(_json.dumps({**result, "data": data, "series": ["value"], "colorByCategory": color_by_cat})); return
            agg = {}
            for _, row in df.iterrows():
                k = str(row[x]) if row[x] is not None else ""
                g = str(row[eff_group]) if row[eff_group] is not None else ""
                val = _linkr_to_num(row[y])
                if _math.isnan(val): continue
                inner = agg.setdefault(k, {})
                e = inner.setdefault(g, [0.0, 0])
                e[0] += val; e[1] += 1
            data = []
            for k, groups in list(agg.items())[:30]:
                entry = {"name": k}
                for g in eff_group_names:
                    gv = groups.get(g)
                    entry[g] = (gv[0] / gv[1]) if gv else 0
                data.append(entry)
            print(_json.dumps({**result, "data": data, "series": eff_group_names, "colorByCategory": color_by_cat})); return
        # count mode
        if not eff_group_names or eff_group not in df.columns:
            counts = {}
            for v in df[x]:
                k = str(v) if v is not None else ""
                counts[k] = counts.get(k, 0) + 1
            data = [{"name": k, "count": c} for k, c in sorted(counts.items(), key=lambda kv: -kv[1])[:30]]
            print(_json.dumps({**result, "data": data, "series": ["count"], "colorByCategory": color_by_cat})); return
        agg = {}
        for _, row in df.iterrows():
            k = str(row[x]) if row[x] is not None else ""
            g = str(row[eff_group]) if row[eff_group] is not None else ""
            inner = agg.setdefault(k, {})
            inner[g] = inner.get(g, 0) + 1
        data = []
        for k, groups in list(agg.items())[:30]:
            entry = {"name": k}
            for g in eff_group_names:
                entry[g] = groups.get(g, 0)
            data.append(entry)
        print(_json.dumps({**result, "data": data, "series": eff_group_names, "colorByCategory": color_by_cat})); return

    if plot_type == "histogram":
        if not hist or hist not in df.columns:
            print(_json.dumps({**result, "data": [], "series": [], "isCategorical": False})); return
        color_by_cat = bool(group) and group == hist
        eff_group = None if color_by_cat else group
        eff_group_names = None if color_by_cat else group_names
        bin_mode = spec.get("binMode", "count"); bins_cfg = int(spec.get("bins", 20))
        bin_width_cfg = spec.get("binWidth", 5); saz = bool(spec.get("xAxisStartZero", False))
        decimals = int(spec.get("decimals", 1))
        is_cat = _linkr_is_categorical(df, hist)
        if is_cat:
            if not eff_group_names or eff_group not in df.columns:
                data = _linkr_categorical(df, hist)
                print(_json.dumps({**result, "data": data, "series": ["count"], "isCategorical": True, "colorByCategory": color_by_cat})); return
            data = _linkr_categorical_grouped(df, hist, eff_group, eff_group_names)
            print(_json.dumps({**result, "data": data, "series": eff_group_names, "isCategorical": True, "colorByCategory": color_by_cat})); return
        if not eff_group_names or eff_group not in df.columns:
            values = [v for v in (_linkr_to_num(v) for v in df[hist]) if not _math.isnan(v)]
            data = _linkr_histogram(values, bin_mode, bins_cfg, bin_width_cfg, saz, decimals)
            print(_json.dumps({**result, "data": data, "series": ["count"], "isCategorical": False, "colorByCategory": color_by_cat})); return
        data = _linkr_histogram_grouped(df, hist, eff_group, bin_mode, bins_cfg, bin_width_cfg, eff_group_names, saz, decimals)
        print(_json.dumps({**result, "data": data, "series": eff_group_names, "isCategorical": False, "colorByCategory": color_by_cat})); return

    if plot_type in ("boxplot", "violin"):
        val_col = y if y else x
        cat_col = x if y else None
        if not val_col or val_col not in df.columns:
            print(_json.dumps({**result, "data": []})); return
        data = []
        if not cat_col or cat_col not in df.columns:
            vals = [v for v in (_linkr_to_num(v) for v in df[val_col]) if not _math.isnan(v)]
            stats = _linkr_boxplot_stats(vals)
            if stats:
                data.append({"name": val_col, "stats": stats, "values": vals})
        else:
            groups = {}
            for _, row in df.iterrows():
                cat = str(row[cat_col]) if row[cat_col] is not None else ""
                val = _linkr_to_num(row[val_col])
                if _math.isnan(val): continue
                groups.setdefault(cat, []).append(val)
            for name, vals in list(groups.items())[:20]:
                stats = _linkr_boxplot_stats(vals)
                if stats:
                    data.append({"name": name, "stats": stats, "values": vals})
        print(_json.dumps({**result, "data": data})); return

    print(_json.dumps({**result, "data": []}))
`
