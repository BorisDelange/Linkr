"""SPC render: server-owned pandas program + spec validation.

The `_SPC_PY` body is a port of the frontend `lib/spc/` modules — it MUST stay in
parity with computeSpc() and the builders it calls (spc-aggregate.ts,
spc-limits.ts, spc-rules.ts). The JSON it prints is the SpcResult the component
renders, so a divergence shows up as a chart that changes when a workspace moves
between client and server mode.

Only the spec (column names + options) varies per request; the program itself is
held here so a viewer can never send Python through the render route.
"""

import json

_PERIODS = ("day", "week", "month", "quarter", "year")
_STATISTIC_TYPES = ("auto", "proportion", "rate", "measurement", "rare-event")
_CHART_TYPES = ("auto", "p", "p-prime", "np", "u", "u-prime", "c", "i-mr", "ewma", "g", "t")
_DENOMINATORS = ("cases", "exposure-column", "patient-days", "device-days")
_AGGREGATIONS = ("mean", "median", "sum", "min", "max")
_RUNS_RULES = ("anhoj", "fixed", "none")


def _opt_str(spec: dict, key: str) -> str | None:
    value = spec.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"spc spec.{key} must be a string or null")
    return value or None


def _choice(spec: dict, key: str, allowed: tuple[str, ...], default: str) -> str:
    value = spec.get(key)
    if value is None:
        return default
    if not isinstance(value, str) or value not in allowed:
        raise ValueError(f"spc spec.{key} must be one of {', '.join(allowed)}")
    return value


def _number(spec: dict, key: str, default: float, low: float, high: float) -> float:
    value = spec.get(key)
    if value is None:
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"spc spec.{key} must be a number")
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError(f"spc spec.{key} must be finite")
    # Clamp rather than reject: the config panel enforces min/max as HTML
    # attributes only, so an out-of-range value is a UI gap, not a hostile spec.
    return min(max(number, low), high)


def validate_spec(spec: dict) -> dict:
    """Coerce + validate the client spec into the shape _SPC_PY expects.
    Raises ValueError on a malformed spec so the route returns a clean 400."""
    if not isinstance(spec, dict):
        raise ValueError("spc spec must be an object")

    date = spec.get("date")
    value = spec.get("value")
    if not isinstance(date, str) or not date:
        raise ValueError("spc spec.date must be a non-empty string")
    if not isinstance(value, str) or not value:
        raise ValueError("spc spec.value must be a non-empty string")

    event_values = spec.get("eventValues")
    if event_values is not None:
        if not isinstance(event_values, list) or not all(isinstance(v, str) for v in event_values):
            raise ValueError("spc spec.eventValues must be a list of strings or null")
        event_values = event_values or None

    target = spec.get("target")
    if target is not None:
        try:
            target = float(target)
        except (TypeError, ValueError):
            raise ValueError("spc spec.target must be a number or null")
        if target != target or target in (float("inf"), float("-inf")):
            raise ValueError("spc spec.target must be finite")

    return {
        "statisticType": _choice(spec, "statisticType", _STATISTIC_TYPES, "auto"),
        "chartType": _choice(spec, "chartType", _CHART_TYPES, "auto"),
        "date": date,
        "value": value,
        "period": _choice(spec, "period", _PERIODS, "month"),
        "eventValues": event_values,
        "denominatorMode": _choice(spec, "denominatorMode", _DENOMINATORS, "cases"),
        "exposure": _opt_str(spec, "exposure"),
        "admission": _opt_str(spec, "admission"),
        "discharge": _opt_str(spec, "discharge"),
        "deviceStart": _opt_str(spec, "deviceStart"),
        "deviceEnd": _opt_str(spec, "deviceEnd"),
        "deduplicateBy": _opt_str(spec, "deduplicateBy"),
        "aggregation": _choice(spec, "aggregation", _AGGREGATIONS, "median"),
        "rateBasis": _number(spec, "rateBasis", 1000, 1, 100000),
        "sigmaWidth": _number(spec, "sigmaWidth", 3, 1, 5),
        "lambda": _number(spec, "lambda", 0.2, 0.05, 1),
        "target": target,
        "runsRules": _choice(spec, "runsRules", _RUNS_RULES, "anhoj"),
        "runLength": int(_number(spec, "runLength", 6, 3, 12)),
        "baselineUntil": _opt_str(spec, "baselineUntil"),
    }


def build_code(spec: dict) -> str:
    # Embed the spec as a JSON string parsed at runtime — a JSON object literal
    # isn't valid Python (true/false/null), so json.loads() is required.
    embedded = json.dumps(json.dumps(spec))
    return f"{_SPC_PY}\n_linkr_print_spc(dataset, _json.loads({embedded}))\n"


_SPC_PY = r'''
import json as _json
import math as _math
import datetime as _dt

_DAY = _dt.timedelta(days=1)
# d2 for a moving range of 2: turns a mean moving range into a sigma estimate.
_D2_MR2 = 1.128
# Nelson's normalising exponent for the t-chart.
_T_EXP = 3.6
_RARE_EVENT_THRESHOLD = 5
_MIN_PERIODS = 8


def _spc_parse_date(value):
    """Leading YYYY-MM-DD of a date-ish cell, as a date. None when unusable."""
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    text = str(value).strip()
    if not text or text.lower() in ("nan", "nat", "none", "null"):
        return None
    try:
        return _dt.date(int(text[0:4]), int(text[5:7]), int(text[8:10]))
    except (ValueError, IndexError):
        return None


def _spc_to_number(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return None if (isinstance(value, float) and value != value) else float(value)
    text = str(value).strip().replace(",", ".")
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return None if number != number else number


def _spc_floor(day, period):
    if period == "day":
        return day
    if period == "week":
        return day - _dt.timedelta(days=day.weekday())
    if period == "month":
        return _dt.date(day.year, day.month, 1)
    if period == "quarter":
        return _dt.date(day.year, ((day.month - 1) // 3) * 3 + 1, 1)
    return _dt.date(day.year, 1, 1)


def _spc_next(day, period):
    start = _spc_floor(day, period)
    if period == "day":
        return start + _DAY
    if period == "week":
        return start + _dt.timedelta(days=7)
    if period == "month":
        return _dt.date(start.year + (start.month == 12), (start.month % 12) + 1, 1)
    if period == "quarter":
        month = start.month + 3
        return _dt.date(start.year + (month > 12), month - 12 if month > 12 else month, 1)
    return _dt.date(start.year + 1, 1, 1)


def _spc_grid(first, last, period):
    out = []
    cursor = _spc_floor(first, period)
    end = _spc_floor(last, period)
    guard = 0
    while cursor <= end and guard < 20000:
        out.append(cursor)
        cursor = _spc_next(cursor, period)
        guard += 1
    return out


def _spc_mean(values):
    finite = [v for v in values if v is not None and v == v]
    return sum(finite) / len(finite) if finite else 0.0


def _spc_sigma_mr(values):
    if len(values) < 2:
        return 0.0
    ranges = [abs(values[i] - values[i - 1]) for i in range(1, len(values))]
    return _spc_mean(ranges) / _D2_MR2


def _spc_is_event(cell, event_values):
    if cell is None:
        return False
    if not event_values:
        number = _spc_to_number(cell)
        if number is not None:
            return number != 0
        return str(cell).strip().lower() in ("true", "yes", "oui")
    return str(cell) in event_values


def _spc_rows(dataset):
    """The dataset as plain dicts — the port works on values, not on pandas."""
    return dataset.to_dict("records")


def _spc_dedupe(rows, key):
    if not key:
        return rows
    seen = set()
    out = []
    for row in rows:
        ident = row.get(key)
        if ident is None:
            continue
        text = str(ident)
        if text in seen:
            continue
        seen.add(text)
        out.append(row)
    return out


def _spc_aggregate_values(values, how):
    if not values:
        return 0.0
    if how == "sum":
        return float(sum(values))
    if how == "min":
        return float(min(values))
    if how == "max":
        return float(max(values))
    if how == "mean":
        return sum(values) / len(values)
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 0:
        return (ordered[mid - 1] + ordered[mid]) / 2
    return float(ordered[mid])


def _spc_variance(values):
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    return sum((v - mean) ** 2 for v in values) / (len(values) - 1)


def _spc_overlap_days(intervals, grid, period, open_end):
    out = {}
    for bucket in grid:
        bucket_end = _spc_next(bucket, period) - _DAY
        days = 0
        for start, end in intervals:
            stop = end or open_end
            lo = max(start, bucket)
            hi = min(stop, bucket_end)
            if hi >= lo:
                days += (hi - lo).days + 1
        out[bucket] = days
    return out


def _spc_collect_intervals(rows, start_col, end_col):
    out = []
    for row in rows:
        start = _spc_parse_date(row.get(start_col))
        if start is None:
            continue
        end = _spc_parse_date(row.get(end_col)) if end_col else None
        out.append((start, end))
    return out


def _spc_aggregate(rows, spec, statistic_type):
    date_col = spec["date"]
    value_col = spec["value"]
    period = spec["period"]
    event_values = spec["eventValues"]
    mode = spec["denominatorMode"]

    numerator_rows = _spc_dedupe(rows, spec["deduplicateBy"])
    dated = []
    for row in numerator_rows:
        day = _spc_parse_date(row.get(date_col))
        if day is not None:
            dated.append((row, day))
    if not dated:
        return []

    if statistic_type == "measurement":
        buckets = {}
        for row, day in dated:
            number = _spc_to_number(row.get(value_col))
            if number is None:
                continue
            buckets.setdefault(_spc_floor(day, period), []).append(number)
        points = []
        for bucket in sorted(buckets):
            values = buckets[bucket]
            points.append({
                "date": bucket.isoformat(),
                "y": _spc_aggregate_values(values, spec["aggregation"]),
                "n": len(values),
                "variance": _spc_variance(values),
            })
        return points

    events = {}
    for row, day in dated:
        if not _spc_is_event(row.get(value_col), event_values):
            continue
        bucket = _spc_floor(day, period)
        events[bucket] = events.get(bucket, 0) + 1

    denominators = {}
    if mode in ("patient-days", "device-days"):
        start_col = spec["admission"] if mode == "patient-days" else spec["deviceStart"]
        end_col = spec["discharge"] if mode == "patient-days" else spec["deviceEnd"]
        if not start_col:
            return []
        intervals = _spc_collect_intervals(numerator_rows, start_col, end_col)
        if not intervals:
            return []
        starts = [s for s, _ in intervals]
        ends = [e for _, e in intervals if e is not None]
        open_end = max(ends + starts + [d for _, d in dated])
        denominators = _spc_overlap_days(intervals, _spc_grid(min(starts), open_end, period), period, open_end)
    elif mode == "exposure-column":
        exposure = spec["exposure"]
        if not exposure:
            return []
        for row in numerator_rows:
            day = _spc_parse_date(row.get(date_col))
            number = _spc_to_number(row.get(exposure))
            if day is None or number is None:
                continue
            bucket = _spc_floor(day, period)
            denominators[bucket] = denominators.get(bucket, 0) + number
    else:
        for row in numerator_rows:
            day = _spc_parse_date(row.get(date_col))
            if day is None:
                continue
            bucket = _spc_floor(day, period)
            denominators[bucket] = denominators.get(bucket, 0) + 1

    points = []
    for bucket in sorted(denominators):
        n = denominators[bucket]
        if n > 0:
            points.append({"date": bucket.isoformat(), "y": events.get(bucket, 0), "n": n, "variance": None})
    return points


def _spc_intervals(rows, spec):
    stamps = []
    for row in _spc_dedupe(rows, spec["deduplicateBy"]):
        if not _spc_is_event(row.get(spec["value"]), spec["eventValues"]):
            continue
        day = _spc_parse_date(row.get(spec["date"]))
        if day is not None:
            stamps.append(day)
    stamps.sort()
    return [
        {"date": stamps[i].isoformat(), "y": float((stamps[i] - stamps[i - 1]).days), "n": 1, "variance": None}
        for i in range(1, len(stamps))
    ]


def _spc_detect_type(rows, value_col, mode):
    values = []
    for row in rows[:2000]:
        cell = row.get(value_col)
        if cell is not None and cell != "":
            values.append(cell)
    if not values:
        return "proportion"
    distinct = {str(v) for v in values}
    numeric = sum(1 for v in values if _spc_to_number(v) is not None)
    if numeric / len(values) > 0.8 and len(distinct) > 3:
        return "measurement"
    return "proportion" if mode == "cases" else "rate"


def _spc_suggest_chart(statistic_type, points):
    total_events = sum(p["y"] for p in points)
    if statistic_type == "measurement":
        return "i-mr"
    if statistic_type == "rare-event":
        return "g"
    if statistic_type == "rate":
        return "u" if total_events < _RARE_EVENT_THRESHOLD * len(points) else "u-prime"
    mean_n = (sum(p["n"] for p in points) / len(points)) if points else 0
    return "p-prime" if mean_n > 300 else "p"


def _spc_pooled_centre(points):
    total_n = sum(p["n"] for p in points)
    return (sum(p["y"] for p in points) / total_n) if total_n > 0 else 0.0


def _spc_laney_sigma_z(points, centre, sigma_of):
    if len(points) < 2:
        return 1.0
    z = []
    for p in points:
        sigma = sigma_of(p["n"])
        z.append(0.0 if not sigma else (p["y"] / p["n"] - centre) / sigma)
    sz = _spc_sigma_mr(z)
    return sz if (sz == sz and sz > 0) else 1.0


def _spc_point(p, value, centre, sigma, width, low, high, baseline):
    ucl = centre + width * sigma
    lcl = centre - width * sigma
    if high is not None:
        ucl = min(ucl, high)
    if low is not None:
        lcl = max(lcl, low)
    return {
        "date": p["date"],
        "value": value,
        "numerator": p["y"],
        "denominator": p["n"],
        "centre": centre,
        "ucl": ucl,
        "lcl": lcl,
        "signals": [],
        "baseline": baseline,
    }


def _spc_max_run(n):
    if n < 2:
        return None
    return int(round(_math.log2(n))) + 3


def _spc_min_crossings(n):
    if n < 3:
        return 0
    trials = n - 1
    return max(1, int(_math.floor(trials / 2 - 1.645 * (_math.sqrt(trials) / 2))))


def _spc_side(point):
    if point["value"] > point["centre"]:
        return 1
    if point["value"] < point["centre"]:
        return -1
    return 0


def _spc_flag_runs(points, max_run, out):
    if max_run is None:
        return
    start = 0
    side = 0

    def close(end):
        if side != 0 and end - start > max_run:
            for k in range(start, end):
                if _spc_side(points[k]) != 0:
                    out[k].append("shift")

    for i, point in enumerate(points):
        s = _spc_side(point)
        if s == 0:
            continue
        if s != side:
            close(i)
            side = s
            start = i
    close(len(points))


def _spc_flag_crossings(points, minimum, out):
    sides = [s for s in (_spc_side(p) for p in points) if s != 0]
    if len(sides) < 3:
        return
    crossings = sum(1 for i in range(1, len(sides)) if sides[i] != sides[i - 1])
    if crossings < minimum:
        for i in range(len(points)):
            out[i].append("few-crossings")


def _spc_flag_trend(points, k, out):
    if len(points) < k:
        return
    for i in range(len(points) - k + 1):
        up = all(points[j]["value"] > points[j - 1]["value"] for j in range(i + 1, i + k))
        down = all(points[j]["value"] < points[j - 1]["value"] for j in range(i + 1, i + k))
        if up or down:
            for j in range(i, i + k):
                out[j].append("trend")


def _spc_apply_rules(points, rule_set, run_length):
    out = [[] for _ in points]
    for i, p in enumerate(points):
        beyond = (p["ucl"] is not None and p["value"] > p["ucl"]) or (p["lcl"] is not None and p["value"] < p["lcl"])
        if beyond:
            out[i].append("beyond-limits")
    if rule_set == "anhoj":
        _spc_flag_runs(points, _spc_max_run(len(points)), out)
        _spc_flag_crossings(points, _spc_min_crossings(len(points)), out)
    elif rule_set == "fixed":
        _spc_flag_runs(points, run_length - 1, out)
        _spc_flag_trend(points, run_length, out)
    for i, p in enumerate(points):
        p["signals"] = out[i]


def _linkr_print_spc(dataset, spec):
    rows = _spc_rows(dataset)
    warnings = []

    statistic_type = spec["statisticType"]
    if statistic_type == "auto":
        statistic_type = _spc_detect_type(rows, spec["value"], spec["denominatorMode"])

    if statistic_type == "measurement" and spec["denominatorMode"] != "cases":
        warnings.append({"code": "option-ignored", "detail": spec["denominatorMode"]})

    basis = spec["rateBasis"]
    width = spec["sigmaWidth"]
    target = spec["target"]

    if statistic_type == "rare-event":
        points = _spc_intervals(rows, spec)
    else:
        points = _spc_aggregate(rows, spec, statistic_type)

    if not points:
        print(_json.dumps(None))
        return
    if len(points) < _MIN_PERIODS:
        warnings.append({"code": "too-few-periods", "detail": str(len(points))})

    chart_type = spec["chartType"]
    if chart_type == "auto":
        chart_type = _spc_suggest_chart(statistic_type, points)

    baseline_end = len(points)
    if spec["baselineUntil"]:
        cut = next((i for i, p in enumerate(points) if p["date"] > spec["baselineUntil"]), -1)
        baseline_end = len(points) if cut == -1 else cut
    if baseline_end < 2:
        warnings.append({"code": "baseline-too-short", "detail": str(baseline_end)})
        baseline_end = len(points)
    base = points[:baseline_end]

    if statistic_type != "rare-event" and chart_type in ("u", "u-prime", "p"):
        total_events = sum(p["y"] for p in points)
        if total_events < _RARE_EVENT_THRESHOLD * len(points):
            warnings.append({"code": "rare-events-prefer-g", "detail": str(total_events)})

    sigma_z = None
    y_unit = None

    if chart_type in ("p", "p-prime"):
        centre = target if target is not None else _spc_pooled_centre(base)
        sigma_of = lambda n: _math.sqrt(centre * (1 - centre) / n) if n > 0 else 0.0
        prime = chart_type == "p-prime"
        sigma_z = _spc_laney_sigma_z(base, centre, sigma_of) if prime else 1.0
        built = [
            _spc_point(p, (p["y"] / p["n"]) if p["n"] > 0 else 0.0, centre, sigma_of(p["n"]) * sigma_z,
                       width, 0.0, 1.0, i < baseline_end)
            for i, p in enumerate(points)
        ]
        if not prime:
            observed = _spc_laney_sigma_z(base, centre, sigma_of)
            if observed > 1.2:
                warnings.append({"code": "overdispersion-prefer-prime", "detail": "%.2f" % observed})
            sigma_z = None

    elif chart_type in ("u", "u-prime"):
        centre = target if target is not None else _spc_pooled_centre(base) * basis
        sigma_of = lambda n: _math.sqrt(centre * basis / n) if n > 0 else 0.0
        prime = chart_type == "u-prime"
        if prime:
            sigma_z = _spc_laney_sigma_z(
                base, centre / basis, lambda n: _math.sqrt(centre / (basis * n)) if n > 0 else 0.0)
        else:
            sigma_z = None
        factor = sigma_z if sigma_z is not None else 1.0
        built = [
            _spc_point(p, (p["y"] / p["n"]) * basis if p["n"] > 0 else 0.0, centre, sigma_of(p["n"]) * factor,
                       width, 0.0, None, i < baseline_end)
            for i, p in enumerate(points)
        ]
        y_unit = "/%g" % basis

    elif chart_type == "c":
        centre = target if target is not None else _spc_mean([p["y"] for p in base])
        sigma = _math.sqrt(max(centre, 0.0))
        built = [_spc_point(p, p["y"], centre, sigma, width, 0.0, None, i < baseline_end)
                 for i, p in enumerate(points)]

    elif chart_type == "np":
        n_bar = _spc_mean([p["n"] for p in base])
        p_bar = _spc_pooled_centre(base)
        centre = target if target is not None else n_bar * p_bar
        sigma = _math.sqrt(max(n_bar * p_bar * (1 - p_bar), 0.0))
        built = [_spc_point(p, p["y"], centre, sigma, width, 0.0, None, i < baseline_end)
                 for i, p in enumerate(points)]

    elif chart_type == "i-mr":
        values = [p["y"] for p in base]
        centre = target if target is not None else _spc_mean(values)
        sigma = _spc_sigma_mr(values)
        built = [_spc_point(p, p["y"], centre, sigma, width, None, None, i < baseline_end)
                 for i, p in enumerate(points)]

    elif chart_type == "g":
        centre = target if target is not None else _spc_mean([p["y"] for p in base])
        sigma = _math.sqrt(max(centre * (centre + 1), 0.0))
        built = [_spc_point(p, p["y"], centre, sigma, width, 0.0, None, i < baseline_end)
                 for i, p in enumerate(points)]

    elif chart_type == "t":
        to_y = lambda t: _math.pow(max(t, 0.0), 1 / _T_EXP)
        back = lambda y: _math.pow(max(y, 0.0), _T_EXP)
        ys = [to_y(p["y"]) for p in base]
        centre_y = to_y(target) if target is not None else _spc_mean(ys)
        sigma_y = _spc_sigma_mr(ys)
        centre = back(centre_y)
        built = [{
            "date": p["date"], "value": p["y"], "numerator": p["y"], "denominator": p["n"],
            "centre": centre, "ucl": back(centre_y + width * sigma_y),
            "lcl": back(max(centre_y - width * sigma_y, 0.0)),
            "signals": [], "baseline": i < baseline_end,
        } for i, p in enumerate(points)]

    else:  # ewma
        if statistic_type == "measurement":
            value_of = lambda p: p["y"]
        elif statistic_type == "rate":
            value_of = lambda p: (p["y"] / p["n"]) * basis if p["n"] > 0 else 0.0
        else:
            value_of = lambda p: (p["y"] / p["n"]) if p["n"] > 0 else 0.0
        centre = target if target is not None else _spc_mean([value_of(p) for p in base])
        if statistic_type == "proportion":
            variance_of = lambda p: (centre * (1 - centre) / p["n"]) if p["n"] > 0 else 0.0
            low, high = 0.0, 1.0
        elif statistic_type == "rate":
            variance_of = lambda p: (centre * basis / p["n"]) if p["n"] > 0 else 0.0
            low, high = 0.0, None
            y_unit = "/%g" % basis
        else:
            variance_of = lambda p: (p["variance"] / p["n"]) if (p["variance"] and p["n"] > 0) else 0.0
            low, high = None, None
        lam = spec["lambda"]
        z = centre
        var_z = 0.0
        built = []
        for i, p in enumerate(points):
            z = lam * value_of(p) + (1 - lam) * z
            var_z = lam * lam * variance_of(p) + (1 - lam) * (1 - lam) * var_z
            built.append(_spc_point(p, z, centre, _math.sqrt(max(var_z, 0.0)), width, low, high, i < baseline_end))

    _spc_apply_rules(built, spec["runsRules"], spec["runLength"])

    result = {
        "chartType": chart_type,
        "points": built,
        "centre": centre,
        "baselineCount": baseline_end,
        "warnings": warnings,
    }
    if sigma_z is not None:
        result["sigmaZ"] = sigma_z
    if y_unit is not None:
        result["yUnit"] = y_unit
    print(_json.dumps(result))
'''
