"""Plot Builder render: server-owned pandas program + spec validation.

The `_PLOT_PY` body is ported verbatim from the frontend plot-builder-server.ts
(`_PLOT_PY`) — it must stay in parity with the per-plot useMemo blocks in
PlotBuilderComponent.tsx. Only the (validated) spec varies per request; a viewer
never ships code, so it can't run arbitrary Python via the render endpoint.
"""

import json

# Enum-checked against the values used in plot-builder-server.ts / PlotBuilderComponent.tsx.
_ALLOWED_PLOT_TYPES = {"scatter", "line", "bar", "histogram", "pie", "boxplot", "violin"}
_ALLOWED_BIN_MODES = {"count", "width"}
_ALLOWED_ORIENTATIONS = {"vertical", "horizontal"}
_ALLOWED_AGGREGATIONS = {"first", "last", "mean", "median", "min", "max", "sum"}
_ALLOWED_OUTLIER_METHODS = {"none", "iqr", "sd", "percentile"}
_ALLOWED_CATEGORY_ORDERS = {"value-desc", "value-asc", "alpha", "data", "custom"}


def _opt_str(value, field: str):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"plot-builder spec.{field} must be a string or null")
    return value


def _num(value, field: str, default):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"plot-builder spec.{field} must be a number")
    return value


def validate_spec(spec: dict) -> dict:
    """Coerce + validate the client spec into the shape _PLOT_PY expects.
    Raises ValueError on a malformed spec so the route returns a clean 400.
    Preserves the EXACT key names buildPlotBuilderSpec emits."""
    if not isinstance(spec, dict):
        raise ValueError("plot-builder spec must be an object")

    plot_type = spec.get("plotType")
    if plot_type not in _ALLOWED_PLOT_TYPES:
        raise ValueError("plot-builder spec.plotType is invalid")

    bin_mode = spec.get("binMode", "count")
    if bin_mode not in _ALLOWED_BIN_MODES:
        raise ValueError("plot-builder spec.binMode is invalid")

    aggregation = spec.get("uniqueAggregation", "first")
    if aggregation not in _ALLOWED_AGGREGATIONS:
        raise ValueError("plot-builder spec.uniqueAggregation is invalid")

    outlier_method = spec.get("outlierMethod", "none")
    if outlier_method not in _ALLOWED_OUTLIER_METHODS:
        raise ValueError("plot-builder spec.outlierMethod is invalid")

    category_order = spec.get("categoryOrder")
    if category_order is not None and category_order not in _ALLOWED_CATEGORY_ORDERS:
        raise ValueError("plot-builder spec.categoryOrder is invalid")

    custom_order = spec.get("categoryOrderCustom") or []
    if not isinstance(custom_order, list) or not all(isinstance(v, str) for v in custom_order):
        raise ValueError("plot-builder spec.categoryOrderCustom must be a list of strings")

    return {
        "plotType": plot_type,
        "x": _opt_str(spec.get("x"), "x"),
        "y": _opt_str(spec.get("y"), "y"),
        "hist": _opt_str(spec.get("hist"), "hist"),
        "xType": _opt_str(spec.get("xType"), "xType"),
        "yType": _opt_str(spec.get("yType"), "yType"),
        "group": _opt_str(spec.get("group"), "group"),
        "uniquePer": _opt_str(spec.get("uniquePer"), "uniquePer"),
        "uniqueAggregation": aggregation,
        "excludeNA": bool(spec.get("excludeNA", True)),
        "outlierMethod": outlier_method,
        # Clamped: a negative coefficient would invert the fence and drop everything.
        "outlierCoef": max(0, _num(spec.get("outlierCoef"), "outlierCoef", 1.5)),
        "binMode": bin_mode,
        "bins": _num(spec.get("bins"), "bins", 20),
        "binWidth": _num(spec.get("binWidth"), "binWidth", 5),
        "decimals": _num(spec.get("decimals"), "decimals", 1),
        "xAxisStartZero": bool(spec.get("xAxisStartZero", False)),
        # Null = each plot path keeps its own default order (see _linkr_print_plot).
        "categoryOrder": category_order,
        "categoryOrderCustom": custom_order,
        # Histogram drag-to-zoom: re-bin only this value range, so zooming reveals
        # finer structure rather than redrawing the same bars wider.
        "zoomLo": None if spec.get("zoomLo") is None else _num(spec.get("zoomLo"), "zoomLo", 0),
        "zoomHi": None if spec.get("zoomHi") is None else _num(spec.get("zoomHi"), "zoomHi", 0),
    }


def build_code(spec: dict) -> str:
    # Embed the spec as a JSON string parsed at runtime — a JSON object literal
    # isn't valid Python (true/false/null), so json.loads() is required.
    embedded = json.dumps(json.dumps(spec))
    return f"{_PLOT_PY}\n_linkr_print_plot(dataset, _json.loads({embedded}))\n"


_PLOT_PY = r"""
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
    # The same parser as _linkr_num_series, so a column both judge alike: a
    # non-ISO date ("30/06/2024") is categorical rather than an empty axis.
    ts = _pd.to_datetime(s, errors="coerce", utc=True, format="ISO8601")
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
        return [{"bin": _linkr_fmt_bin(vmin, date_mode, decimals), "count": len(values), "lo": vmin, "hi": vmin}]
    start, bw, count = _linkr_bin_params(vmin, vmax, bin_mode, bins_cfg, bin_width_cfg, start_at_zero)
    # lo/hi are each bar's real numeric edges: the label is rounded for display and
    # can't be parsed back, but drag-to-zoom needs the true bounds to re-bin.
    buckets = [{"bin": _linkr_fmt_bin(start + i * bw, date_mode, decimals), "count": 0,
                "lo": start + i * bw, "hi": start + (i + 1) * bw} for i in range(count)]
    for v in values:
        idx = int(_math.floor((v - start) / bw))
        if idx < 0: idx = 0
        if idx >= count: idx = count - 1
        buckets[idx]["count"] += 1
    return buckets

def _linkr_histogram_grouped(df, xcol, gcol, bin_mode, bins_cfg, bin_width_cfg, group_names, start_at_zero, decimals):
    import pandas as _pd
    _nums = _linkr_num_series(df[xcol])
    all_vals = _nums.dropna().tolist()
    if not all_vals:
        return []
    vmin = min(all_vals); vmax = max(all_vals)
    date_mode = _linkr_is_date_range(all_vals)
    if vmin == vmax:
        entry = {"bin": _linkr_fmt_bin(vmin, date_mode, decimals), "lo": vmin, "hi": vmin}
        for g in group_names: entry[g] = 0
        return [entry]
    start, bw, count = _linkr_bin_params(vmin, vmax, bin_mode, bins_cfg, bin_width_cfg, start_at_zero)
    buckets = []
    for i in range(count):
        entry = {"bin": _linkr_fmt_bin(start + i * bw, date_mode, decimals),
                 "lo": start + i * bw, "hi": start + (i + 1) * bw}
        for g in group_names: entry[g] = 0
        buckets.append(entry)
    # Vectorised bin assignment + a groupby, rather than iterrows() with a per-value
    # conversion: on a date column that was seconds, not milliseconds.
    _idx = ((_nums - start) // bw).clip(0, count - 1)
    _groups = df[gcol].astype(str).where(df[gcol].notna(), "")
    _pairs = _pd.DataFrame({"i": _idx, "g": _groups})[_nums.notna()]
    for (i, g), n in _pairs.groupby(["i", "g"]).size().items():
        entry = buckets[int(i)]
        if g in entry:
            entry[g] += int(n)
    return buckets

def _linkr_num_series(col):
    # Vectorised _linkr_to_num: same result (datetimes as MILLISECONDS, matching the
    # bin bounds), without a Python call and a to_datetime parse per row.
    import pandas as _pd
    if _pd.api.types.is_datetime64_any_dtype(col):
        return _linkr_epoch_ms(col)
    num = _pd.to_numeric(col, errors="coerce")
    if num.notna().any() or len(col) == 0:
        return num
    # All-unparseable as numbers: it may still be date strings. utc=True keeps
    # mixed offsets (a DST change) in one dtype, naive strings reading as UTC as
    # before; ISO8601 parses each value on its own instead of the first one's format.
    stripped = col.map(lambda v: v.strip() if isinstance(v, str) else v)
    parsed = _pd.to_datetime(stripped, errors="coerce", utc=True, format="ISO8601")
    if parsed.notna().any():
        return _linkr_epoch_ms(parsed)
    return num

def _linkr_epoch_ms(col):
    # Unit-safe: a Parquet timestamp reads as datetime64[us], not [ns].
    return col.dt.as_unit("ms").astype("int64").where(col.notna())

# Scatter/line draw one SVG element per point in the browser; past a few thousand
# the chart stalls on every redraw. Mirror of plot-sampling.ts in
# apps/web/src/features/projects/lab/datasets/analyses/ (same cap and strategies).
_LINKR_MAX_PLOT_POINTS = 5000

def _linkr_sample_points(frame, sorted_line, max_points=_LINKR_MAX_PLOT_POINTS):
    n = len(frame)
    if n <= max_points:
        return frame
    if sorted_line:
        # Evenly spaced along the sorted X, so the line keeps its full span.
        return frame.iloc[[k * n // max_points for k in range(max_points)]]
    # A stride would alias with any periodic row order (interleaved groups, repeated
    # visits); a seeded random pick doesn't, and stays the same on every render.
    return frame.sample(n=max_points, random_state=0).sort_index()

def _linkr_is_categorical(df, col):
    total = 0; numeric = 0
    for v in df[col]:
        if v is None or v == "": continue
        total += 1
        if not _math.isnan(_linkr_to_num(v)): numeric += 1
        if total >= 200: break
    if total == 0: return False
    return numeric / total < 0.5

def _linkr_categorical(df, col, order, custom):
    counts = {}
    for v in df[col]:
        if v is None or v == "": continue
        k = str(v)
        counts[k] = counts.get(k, 0) + 1
    items = _linkr_order_categories(list(counts.items()), lambda kv: kv[0], lambda kv: kv[1], order, custom)
    return [{"bin": k, "count": c} for k, c in items]

def _linkr_categorical_grouped(df, col, gcol, group_names, order, custom):
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
    items = _linkr_order_categories(list(counts.items()), lambda kv: kv[0],
                                    lambda kv: sum(kv[1][n] for n in group_names), order, custom)
    out = []
    for k, entry in items:
        row = {"bin": k}
        row.update(entry)
        out.append(row)
    return out

def _linkr_alpha_key(name):
    # Approximates Intl.Collator(undefined, {numeric: true, sensitivity: "base"}) in
    # plot-category-order.ts: case and accents ignored, digit runs compared as
    # numbers, so "Class 2" < "Class 10".
    import re as _re
    import unicodedata as _ud
    folded = "".join(c for c in _ud.normalize("NFKD", name) if not _ud.combining(c)).casefold()
    return tuple((0, int(part), "") if part.isdigit() else (1, 0, part)
                 for part in _re.findall(r"\d+|\D+", folded))

def _linkr_order_categories(items, name_of, value_of, order, custom=()):
    # Mirror of orderCategories in plot-category-order.ts. Items arrive in first-
    # appearance order and every sort is stable, so ties keep that order. Callers
    # cap the category count AFTER this.
    if order == "value-desc":
        return sorted(items, key=lambda it: -value_of(it))
    if order == "value-asc":
        return sorted(items, key=value_of)
    if order == "alpha":
        return sorted(items, key=lambda it: _linkr_alpha_key(name_of(it)))
    if order == "custom":
        by_name = {}
        for it in items:
            by_name.setdefault(name_of(it), it)
        head = []; placed = set()
        for name in custom:
            if name in by_name and name not in placed:
                head.append(by_name[name]); placed.add(name)
        rest = [it for it in items if name_of(it) not in placed]
        return head + sorted(rest, key=lambda it: -value_of(it))
    return list(items)

def _linkr_percentile(sorted_vals, p):
    # Linear interpolation between ranks, matching percentile() in
    # apps/web/src/lib/column-stats.ts so both ends fence on the same value.
    if not sorted_vals:
        return 0.0
    idx = (p / 100.0) * (len(sorted_vals) - 1)
    lo = int(_math.floor(idx))
    hi = int(_math.ceil(idx))
    if lo == hi:
        return float(sorted_vals[lo])
    return float(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (idx - lo))

def _linkr_outlier_bounds(values, method, coef):
    # Inclusive (lo, hi) fence, or None when nothing should be excluded. Mirror of
    # outlierBounds in apps/web/src/lib/outliers.ts - keep both in step.
    vals = [float(v) for v in values if v is not None and not _math.isnan(float(v))]
    if method == "none" or not vals:
        return None
    s = sorted(vals)
    if method == "iqr":
        q1 = _linkr_percentile(s, 25)
        q3 = _linkr_percentile(s, 75)
        iqr = q3 - q1
        if iqr <= 0:
            return None
        return (q1 - coef * iqr, q3 + coef * iqr)
    if method == "sd":
        n = len(s)
        mean = sum(s) / n
        sd = _math.sqrt(sum((v - mean) ** 2 for v in s) / n)
        if sd <= 0:
            return None
        return (mean - coef * sd, mean + coef * sd)
    p = min(max(coef, 0), 50)
    if p <= 0:
        return None
    return (_linkr_percentile(s, p), _linkr_percentile(s, 100 - p))

def _linkr_boxplot_stats(values):
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    q1 = _linkr_percentile(s, 25)
    med = _linkr_percentile(s, 50)
    q3 = _linkr_percentile(s, 75)
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
            # Only the columns the plot actually reads need aggregating — the source
            # can carry 100+ columns and the old per-column, per-group reduce made
            # this O(groups × columns) (seconds on a real dataset). Aggregate the
            # needed numeric columns VECTORISED (one groupby per column), and take
            # `first` for the rest, matching the JS aggregateByEntity semantics
            # (numeric → the chosen stat; non-numeric → first).
            needed = {up}
            for key in ("x", "y", "hist", "group"):
                c = spec.get(key)
                if c and c in df.columns:
                    needed.add(c)
            agg_cols = [c for c in needed if c != up]
            gb = df.groupby(up, sort=False)
            # Base frame: `first` of every needed column (preserves non-numeric).
            out = gb[agg_cols].first().reset_index() if agg_cols else gb.size().reset_index()[[up]]
            fn = {"mean": "mean", "median": "median", "min": "min",
                  "max": "max", "sum": "sum"}.get(ua)
            if fn:
                for c in agg_cols:
                    nums = _pd.to_numeric(df[c], errors="coerce")
                    # A column with no numeric values keeps its `first` (non-numeric);
                    # otherwise overlay the vectorised stat over numeric entries.
                    if nums.notna().any():
                        by = nums.groupby(df[up], sort=False)
                        # min_count: an entity with no value stays missing, not 0.
                        stat = by.sum(min_count=1) if fn == "sum" else by.agg(fn)
                        out[c] = out[up].map(stat).where(lambda s: s.notna(), out[c])
            df = out

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

    # Outlier exclusion, mirroring apps/web/src/lib/outliers.ts (outlierBounds): fences
    # per numeric axis over the NA-filtered rows, then keep a row only if every bounded
    # axis is inside its own fence. A degenerate spread (zero IQR/SD) excludes nothing
    # rather than everything. The dropped count travels back so the chart can say so.
    outlier_method = spec.get("outlierMethod", "none")
    outlier_coef = spec.get("outlierCoef", 1.5)
    outliers_excluded = 0
    if outlier_method != "none":
        before = len(df)
        mask = _pd.Series(True, index=df.index)
        for col in [c for c in (x, y) if c and c in df.columns]:
            nums = _pd.to_numeric(df[col], errors="coerce")
            bounds = _linkr_outlier_bounds(nums.dropna(), outlier_method, outlier_coef)
            if bounds is None:
                continue
            lo, hi = bounds
            # A non-numeric cell has no fence to fail; NA handling stays excludeNA's job.
            mask &= nums.isna() | ((nums >= lo) & (nums <= hi))
        df = df[mask]
        outliers_excluded = before - len(df)

    # group names (sorted string set over non-null values).
    group_names = None
    if group and group in df.columns:
        vals = set()
        for v in df[group]:
            if v is not None:
                vals.add(str(v))
        group_names = sorted(vals)

    result = {"plotType": plot_type, "groupNames": group_names, "outliersExcluded": outliers_excluded}

    # Null keeps each path's own default: counts by descending count, box/violin and
    # bars that average a Y or split by a group in data order.
    cat_order = spec.get("categoryOrder")
    cat_custom = spec.get("categoryOrderCustom") or []

    if plot_type in ("scatter", "line"):
        if not x or not y or x not in df.columns or y not in df.columns:
            print(_json.dumps({**result, "series": []})); return
        pts = _pd.DataFrame({
            "x": _linkr_num_series(df[x]).astype("float64"),
            "y": _linkr_num_series(df[y]).astype("float64"),
        })
        grouped = bool(group_names) and group in df.columns
        if grouped:
            pts["g"] = df[group].astype(str)
        pts = pts.dropna(subset=["x", "y"])
        if plot_type == "line":
            # Stable sort so equal x keep their row order, like the per-series sort did.
            pts = pts.sort_values("x", kind="mergesort")
        total = len(pts)
        # Sampled over all series at once, so each group keeps its share of the points.
        pts = _linkr_sample_points(pts, plot_type == "line")
        if total > len(pts):
            result["pointsTotal"] = total
        def _points(frame):
            return [{"x": xv, "y": yv} for xv, yv in zip(frame["x"].tolist(), frame["y"].tolist())]
        if grouped:
            series = [{"name": g, "data": _points(pts[pts["g"] == g])} for g in group_names]
        else:
            series = [{"name": "all", "data": _points(pts)}]
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
                items = _linkr_order_categories(list(agg.items()), lambda kv: kv[0],
                                                lambda kv: kv[1][0] / kv[1][1], cat_order or "data", cat_custom)
                data = [{"name": k, "value": s / c} for k, (s, c) in items[:30]]
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
            # Ordered on the category's mean over all its rows, whatever their group.
            def _overall_mean(kv):
                parts = kv[1].values()
                return sum(p[0] for p in parts) / sum(p[1] for p in parts)
            items = _linkr_order_categories(list(agg.items()), lambda kv: kv[0], _overall_mean,
                                            cat_order or "data", cat_custom)
            data = []
            for k, groups in items[:30]:
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
            items = _linkr_order_categories(list(counts.items()), lambda kv: kv[0], lambda kv: kv[1],
                                            cat_order or "value-desc", cat_custom)
            data = [{"name": k, "count": c} for k, c in items[:30]]
            print(_json.dumps({**result, "data": data, "series": ["count"], "colorByCategory": color_by_cat})); return
        agg = {}
        for _, row in df.iterrows():
            k = str(row[x]) if row[x] is not None else ""
            g = str(row[eff_group]) if row[eff_group] is not None else ""
            inner = agg.setdefault(k, {})
            inner[g] = inner.get(g, 0) + 1
        items = _linkr_order_categories(list(agg.items()), lambda kv: kv[0], lambda kv: sum(kv[1].values()),
                                        cat_order or "data", cat_custom)
        data = []
        for k, groups in items[:30]:
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
                data = _linkr_categorical(df, hist, cat_order or "value-desc", cat_custom)
                print(_json.dumps({**result, "data": data, "series": ["count"], "isCategorical": True, "colorByCategory": color_by_cat})); return
            data = _linkr_categorical_grouped(df, hist, eff_group, eff_group_names, cat_order or "value-desc", cat_custom)
            print(_json.dumps({**result, "data": data, "series": eff_group_names, "isCategorical": True, "colorByCategory": color_by_cat})); return
        # Drag-to-zoom: restrict to the selected value range and re-bin THOSE values,
        # so the zoom shows finer structure rather than the same bars drawn wider.
        # Mirrors the client path in PlotBuilderComponent.tsx.
        zoom_lo = spec.get("zoomLo"); zoom_hi = spec.get("zoomHi")
        if zoom_lo is not None and zoom_hi is not None:
            # Must go through _linkr_to_num, the same conversion the bins use: it maps
            # datetimes to MILLISECONDS, while pd.to_numeric on a datetime column
            # yields nanoseconds. Mixing the two put the bounds off by 10^6 and
            # filtered every row away, leaving an empty chart.
            _hnum = _linkr_num_series(df[hist])
            df = df[_hnum.notna() & (_hnum >= zoom_lo) & (_hnum <= zoom_hi)]
            # Asking for more bins than the range holds distinct values would leave
            # every other bar empty - a comb implying gaps that are not in the data.
            _distinct = int(_linkr_num_series(df[hist]).nunique())
            if _distinct > 0:
                bins_cfg = max(1, min(bins_cfg, _distinct))
            # Padding the axis to 0 inside a zoom would pull the view back out.
            saz = False
        if not eff_group_names or eff_group not in df.columns:
            values = _linkr_num_series(df[hist]).dropna().tolist()
            data = _linkr_histogram(values, bin_mode, bins_cfg, bin_width_cfg, saz, decimals)
            print(_json.dumps({**result, "data": data, "series": ["count"], "isCategorical": False, "colorByCategory": color_by_cat})); return
        data = _linkr_histogram_grouped(df, hist, eff_group, bin_mode, bins_cfg, bin_width_cfg, eff_group_names, saz, decimals)
        print(_json.dumps({**result, "data": data, "series": eff_group_names, "isCategorical": False, "colorByCategory": color_by_cat})); return

    if plot_type == "pie":
        # Same per-category count as the categorical histogram, largest slice first
        # unless another order was chosen.
        if not hist or hist not in df.columns:
            print(_json.dumps({**result, "data": [], "series": ["count"]})); return
        data = _linkr_categorical(df, hist, cat_order or "value-desc", cat_custom)
        print(_json.dumps({**result, "data": data, "series": ["count"]})); return

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
            for name, vals in groups.items():
                stats = _linkr_boxplot_stats(vals)
                if stats:
                    data.append({"name": name, "stats": stats, "values": vals})
            # Ordered before the cap, so a sorted chart keeps its top medians.
            data = _linkr_order_categories(data, lambda d: d["name"], lambda d: d["stats"]["median"],
                                           cat_order or "data", cat_custom)[:20]
        print(_json.dumps({**result, "data": data})); return

    print(_json.dumps({**result, "data": []}))
"""
