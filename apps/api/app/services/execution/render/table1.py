"""Descriptive table render: server-owned pandas program + spec validation.

The `_TABLE1_PY` body must stay in parity with `buildDescriptiveTable` in
apps/web/src/lib/stats/descriptive-table.ts — it emits the same `DescriptiveTable`
JSON, so PublicationTable renders identically whether the numbers were computed
in the browser or here.

The denominators are the whole point of this table and are easy to get subtly
wrong, so they are restated here rather than left implicit:

- a level's percentage is over the rows that ANSWERED the variable, never over
  the group total: over the total, a variable with 30% missing shows levels
  summing to 70%, which reads as an arithmetic mistake rather than as missing
  data;
- the missing row is the one exception — its denominator IS the group total,
  since that is exactly what makes it missing;
- a row whose GROUP value is missing becomes its own group rather than being
  dropped, which would silently change every other column's denominator.

Labels arrive in the spec rather than being derived here: they can come from a
locale the server knows nothing about, and both ends must print the same words.
"""

import json

_ALLOWED_STATS = {"median_iqr", "mean_sd", "min_max", "range"}


def validate_spec(spec: dict) -> dict:
    """Coerce + validate the client spec into the shape _TABLE1_PY expects.
    Raises ValueError on a malformed spec so the route returns a clean 400."""
    if not isinstance(spec, dict):
        raise ValueError("table1 spec must be an object")

    raw_selected = spec.get("selected") or []
    if not isinstance(raw_selected, list):
        raise ValueError("table1 spec.selected must be a list")
    selected = []
    for c in raw_selected:
        if not isinstance(c, dict) or not isinstance(c.get("name"), str):
            raise ValueError("table1 spec.selected entries need a string name")
        selected.append({
            "name": c["name"],
            "label": str(c.get("label") or c["name"]),
            "numeric": bool(c.get("numeric")),
        })

    group = spec.get("group")
    if group is not None:
        if not isinstance(group, dict) or not isinstance(group.get("name"), str):
            raise ValueError("table1 spec.group must be {name, label} or null")
        group = {"name": group["name"], "label": str(group.get("label") or group["name"])}

    stat = spec.get("stat")
    if stat not in _ALLOWED_STATS:
        stat = "median_iqr"

    max_levels = spec.get("maxLevels")
    max_levels = int(max_levels) if isinstance(max_levels, (int, float)) else 0

    return {
        "selected": selected,
        "group": group,
        "stat": stat,
        "showMissing": spec.get("showMissing") is not False,
        "missingLabel": str(spec.get("missingLabel") or "Missing"),
        "maxLevels": max(0, max_levels),
        "othersLabel": str(spec.get("othersLabel") or "Other"),
    }


def build_code(spec: dict) -> str:
    # Embed the spec as a JSON string parsed at runtime — a JSON object literal
    # isn't valid Python (true/false/null), so json.loads() is required.
    embedded = json.dumps(json.dumps(spec))
    return f"{_TABLE1_PY}\n_linkr_print_table1(dataset, _json.loads({embedded}))\n"


_TABLE1_PY = r'''
import json as _json
import math as _math

_LINKR_DASH = "—"

def _linkr_missing(v):
    # Parity with isMissing(): null/NaN/blank and the NA spellings exports use.
    if v is None:
        return True
    try:
        if isinstance(v, float) and _math.isnan(v):
            return True
    except Exception:
        pass
    return str(v).strip().lower() in ("", "null", "na", "nan")

def _linkr_num(v):
    # Parity with toNum(): tolerate the decimal comma French exports produce.
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return f if _math.isfinite(f) else None
    try:
        f = float(str(v).strip().replace(",", "."))
    except ValueError:
        return None
    return f if _math.isfinite(f) else None

def _linkr_quantile(sorted_vals, p):
    # R type 7, matching quantile() on the client.
    n = len(sorted_vals)
    if n == 0:
        return float("nan")
    if n == 1:
        return sorted_vals[0]
    pos = (n - 1) * p
    lo = int(_math.floor(pos))
    hi = int(_math.ceil(pos))
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (pos - lo) * (sorted_vals[hi] - sorted_vals[lo])

def _linkr_fmt(n, digits=1):
    # Parity with fmt(): integers stay integral, never a trailing ".0".
    if n is None or not _math.isfinite(n):
        return _LINKR_DASH
    if float(n).is_integer():
        return str(int(n))
    # Python's f-string formatting rounds half to EVEN, JS toFixed() rounds half
    # UP: 3.25 prints "3.2" here and "3.3" there. An IQR of [3.25, 7.75] is the
    # ordinary case, not a corner one, so the halves are forced up explicitly.
    scale = 10 ** digits
    scaled = n * scale
    nearest = _math.floor(abs(scaled) + 0.5) * (1 if scaled >= 0 else -1)
    return f"{nearest / scale:.{digits}f}"

def _linkr_numeric_cell(values, stat):
    nums = []
    for v in values:
        if _linkr_missing(v):
            continue
        n = _linkr_num(v)
        if n is not None:
            nums.append(n)
    if not nums:
        return _LINKR_DASH
    nums.sort()
    if stat == "mean_sd":
        mean = _math.fsum(nums) / len(nums)
        # Sample SD (n-1), matching the client.
        var = (_math.fsum((v - mean) ** 2 for v in nums) / (len(nums) - 1)) if len(nums) > 1 else 0.0
        return f"{_linkr_fmt(mean)} ± {_linkr_fmt(_math.sqrt(var))}"
    if stat == "min_max":
        return f"{_linkr_fmt(nums[0])} / {_linkr_fmt(nums[-1])}"
    if stat == "range":
        return _linkr_fmt(nums[-1] - nums[0])
    med = _linkr_quantile(nums, 0.5)
    q1 = _linkr_quantile(nums, 0.25)
    q3 = _linkr_quantile(nums, 0.75)
    return f"{_linkr_fmt(med)} [{_linkr_fmt(q1)}–{_linkr_fmt(q3)}]"

def _linkr_count_cell(count, answered):
    if answered == 0:
        return _LINKR_DASH
    # round() in Python banker-rounds; the client's Math.round does not, so go
    # through floor(x + 0.5) to keep 0.5 cases identical on both ends.
    pct = int(_math.floor((count / answered) * 100 + 0.5))
    return f"{count} ({pct}%)"

def _linkr_print_table1(dataset, spec):
    selected = spec.get("selected") or []
    group = spec.get("group")
    stat = spec.get("stat") or "median_iqr"
    show_missing = spec.get("showMissing") is not False
    missing_label = spec.get("missingLabel") or "Missing"
    max_levels = int(spec.get("maxLevels") or 0)
    others_label = spec.get("othersLabel") or "Other"

    total = int(len(dataset))
    cols = set(dataset.columns)

    # Split into groups. A missing group value is its own group.
    grouped = {}
    if group and group.get("name") in cols:
        gvals = dataset[group["name"]].tolist()
        for i in range(total):
            key = _LINKR_DASH if _linkr_missing(gvals[i]) else str(gvals[i]).strip()
            grouped.setdefault(key, []).append(i)
        groups = sorted(grouped.keys())
    else:
        grouped = {"": list(range(total))}
        groups = None

    keys = groups if groups is not None else [""]
    group_sizes = {k: len(grouped.get(k, [])) for k in keys}

    out_rows = []
    for var in selected:
        name = var["name"]
        if name not in cols:
            continue
        series = dataset[name].tolist()

        answered = {}
        for k in keys:
            answered[k] = [series[i] for i in grouped.get(k, []) if not _linkr_missing(series[i])]
        answered_total = sum(len(answered[k]) for k in keys)

        if var.get("numeric"):
            out_rows.append({
                "id": name,
                "label": var["label"],
                "indent": False,
                "n": answered_total,
                "cells": {k: {"text": _linkr_numeric_cell(answered[k], stat)} for k in keys},
            })
        else:
            overall = {}
            for k in keys:
                for v in answered[k]:
                    key = str(v).strip()
                    overall[key] = overall.get(key, 0) + 1
            # Frequency order, ties by value so both ends agree on the layout.
            levels = [lv for lv, _ in sorted(overall.items(), key=lambda kv: (-kv[1], kv[0]))]
            others = []
            if max_levels > 0 and len(levels) > max_levels:
                others = levels[max_levels:]
                levels = levels[:max_levels]

            out_rows.append({
                "id": name,
                "label": var["label"],
                "indent": False,
                "n": answered_total,
                "cells": {k: {"text": ""} for k in keys},
            })
            for level in levels:
                cells = {}
                for k in keys:
                    n_in = sum(1 for v in answered[k] if str(v).strip() == level)
                    cells[k] = {"text": _linkr_count_cell(n_in, len(answered[k]))}
                out_rows.append({
                    "id": f"{name}::{level}",
                    "label": level,
                    "indent": True,
                    "n": overall.get(level, 0),
                    "cells": cells,
                })
            if others:
                other_set = set(others)
                cells = {}
                for k in keys:
                    n_in = sum(1 for v in answered[k] if str(v).strip() in other_set)
                    cells[k] = {"text": _linkr_count_cell(n_in, len(answered[k]))}
                out_rows.append({
                    "id": f"{name}::__others__",
                    "label": others_label,
                    "indent": True,
                    "n": sum(overall.get(o, 0) for o in others),
                    "cells": cells,
                })

        if show_missing:
            per_group = [group_sizes.get(k, 0) - len(answered[k]) for k in keys]
            if any(m > 0 for m in per_group):
                cells = {}
                for idx, k in enumerate(keys):
                    m = per_group[idx]
                    cells[k] = {
                        "text": _LINKR_DASH if m == 0 else _linkr_count_cell(m, group_sizes.get(k, 0))
                    }
                out_rows.append({
                    "id": f"{name}::__missing__",
                    "label": missing_label,
                    "indent": True,
                    "n": sum(per_group),
                    "cells": cells,
                })

    print(_json.dumps({
        "rows": out_rows,
        "groups": groups,
        "groupSizes": group_sizes,
        "total": total,
    }))
'''
