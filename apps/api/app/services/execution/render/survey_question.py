"""Survey question render: server-owned pandas program + spec validation.

The `_SURVEY_PY` body must stay in parity with `summarizeQuestion` in
apps/web/src/lib/survey/survey-analysis.ts — it emits the same `QuestionSummary`
JSON, so SurveyQuestionBlock renders identically whether the numbers were
computed in the browser or here.

The denominator rules are the whole point of this analysis and are easy to get
subtly wrong, so they are restated here rather than left implicit:

- percentages are over the respondents who ANSWERED the question, never over all
  rows: a blank is non-response, which is a finding of its own;
- a multiple-choice question counts a respondent ONCE however many boxes they
  ticked, so its percentages legitimately sum past 100%;
- for multiple choice, a row with no box ticked is treated as non-response. The
  data genuinely cannot distinguish "answered, chose nothing" from "never saw
  the question", so the convention is fixed here and stated in the UI.

Unlike the other renders, the spec carries the QUESTION (its choices, and the
column each one-hot choice lives in) rather than just column names: that
grouping is exactly what a flat table cannot express.
"""

import json

# What kind of summary to compute. Anything else is rejected before reaching the
# Python, so an unknown kind can't select a code path that doesn't exist.
_ALLOWED_KINDS = {"select_one", "select_multiple", "numeric", "text"}


def validate_spec(spec: dict) -> dict:
    """Coerce + validate the client spec into the shape _SURVEY_PY expects:
    {kind: str, column: str|None, choices: [{code: str, label: str, column?: str}]}.
    Raises ValueError on a malformed spec so the route returns a clean 400."""
    if not isinstance(spec, dict):
        raise ValueError("survey-question spec must be an object")

    kind = spec.get("kind")
    if kind not in _ALLOWED_KINDS:
        raise ValueError("survey-question spec.kind is not a known question kind")

    column = spec.get("column")
    if column is not None and not isinstance(column, str):
        raise ValueError("survey-question spec.column must be a string or null")

    raw_choices = spec.get("choices") or []
    if not isinstance(raw_choices, list):
        raise ValueError("survey-question spec.choices must be a list")

    choices = []
    for c in raw_choices:
        if not isinstance(c, dict) or not isinstance(c.get("code"), str):
            raise ValueError("survey-question spec.choices entries must be {code, label}")
        entry = {"code": c["code"], "label": str(c.get("label") or c["code"])}
        col = c.get("column")
        if col is not None:
            if not isinstance(col, str):
                raise ValueError("survey-question spec.choices[].column must be a string")
            entry["column"] = col
        choices.append(entry)

    # A one-hot question is defined by its per-choice columns; without them there
    # is nothing to count, and silently falling back to a single column would
    # produce a plausible-looking but wrong chart.
    if kind == "select_multiple" and not any("column" in c for c in choices):
        raise ValueError("survey-question spec.choices must carry a column for select_multiple")
    if kind != "select_multiple" and not column:
        raise ValueError("survey-question spec.column is required for this kind")

    return {"kind": kind, "column": column, "choices": choices}


def build_code(spec: dict) -> str:
    # Embed the spec as a JSON string parsed at runtime — a JSON object literal
    # isn't valid Python (true/false/null), so json.loads() is required.
    embedded = json.dumps(json.dumps(spec))
    return f"{_SURVEY_PY}\n_linkr_print_survey(dataset, _json.loads({embedded}))\n"


_SURVEY_PY = r"""
import json as _json
import math as _math

def _linkr_blank(v):
    # Parity with isBlank(): null/NaN/whitespace only. 0 and False are ANSWERS.
    if v is None:
        return True
    try:
        if isinstance(v, float) and _math.isnan(v):
            return True
    except Exception:
        pass
    if isinstance(v, str):
        return v.strip() == ""
    return False

def _linkr_ticked(v):
    # Parity with isTicked(): exports disagree on the truthy token, so accept the
    # common spellings rather than trusting one. Note 2 is NOT ticked — with
    # LimeSurvey's Y/N conversion on, 1 = yes but 2 = no.
    if v is True:
        return True
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        try:
            if isinstance(v, float) and _math.isnan(v):
                return False
        except Exception:
            pass
        return float(v) == 1.0
    if isinstance(v, str):
        return v.strip().lower() in ("1", "y", "true", "checked", "yes", "oui")
    return False

_LINKR_YES = ("true", "yes", "oui", "y", "o", "vrai")
_LINKR_NO = ("false", "no", "non", "n", "faux")

def _linkr_match_key(v):
    # Parity with matchKey(): fold the yes/no spellings to one token so a cell
    # spelled "oui", a coerced True, and a declared code "non" all land on the
    # same key. Without it one question splits into two rival pairs, one at zero.
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        s = str(int(v))
    else:
        s = str(v).strip()
    lower = s.lower()
    if lower in _LINKR_YES:
        return "true"
    if lower in _LINKR_NO:
        return "false"
    return s

def _linkr_num(v):
    # Parity with toNumber(): tolerate the decimal comma French exports produce.
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        try:
            if isinstance(v, float) and _math.isnan(v):
                return None
        except Exception:
            pass
        return float(v) if _math.isfinite(float(v)) else None
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return None
        try:
            f = float(s.replace(",", "."))
        except ValueError:
            return None
        return f if _math.isfinite(f) else None
    return None

def _linkr_rate(part, whole):
    return (part / whole) if whole > 0 else 0.0

def _linkr_quantile(sorted_vals, p):
    # R type 7, matching quantile() on the client.
    n = len(sorted_vals)
    if n == 0:
        return None
    if n == 1:
        return sorted_vals[0]
    pos = (n - 1) * p
    lo = int(_math.floor(pos))
    hi = int(_math.ceil(pos))
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (pos - lo) * (sorted_vals[hi] - sorted_vals[lo])

def _linkr_describe(values):
    if len(values) == 0:
        return None
    s = sorted(values)
    n = len(s)
    total = _math.fsum(s)
    mean = total / n
    var = (_math.fsum((v - mean) ** 2 for v in s) / (n - 1)) if n > 1 else 0.0
    return {
        "n": n,
        "min": s[0],
        "max": s[n - 1],
        "mean": mean,
        "median": _linkr_quantile(s, 0.5),
        "q1": _linkr_quantile(s, 0.25),
        "q3": _linkr_quantile(s, 0.75),
        "sum": total,
        "sd": _math.sqrt(var),
    }

_LINKR_MAX_VALUES = 50000

def _linkr_summary(total, respondents, counts, extra=None):
    out = {
        "total": total,
        "respondents": respondents,
        "missing": total - respondents,
        "responseRate": _linkr_rate(respondents, total),
        "counts": counts,
    }
    if extra:
        out.update(extra)
    return out

def _linkr_print_survey(dataset, spec):
    kind = spec.get("kind")
    column = spec.get("column")
    choices = spec.get("choices") or []
    total = int(len(dataset))

    if kind == "select_multiple":
        cols = [c for c in choices if c.get("column") in dataset.columns]
        if not cols:
            print(_json.dumps({"error": "no_column"}))
            return
        tally = [0] * len(choices)
        respondents = 0
        selections = 0
        series = {c["column"]: dataset[c["column"]].tolist() for c in cols}
        for i in range(total):
            ticks = 0
            for idx, c in enumerate(choices):
                col = c.get("column")
                if col is None or col not in series:
                    continue
                if _linkr_ticked(series[col][i]):
                    tally[idx] += 1
                    ticks += 1
            # A respondent counts once however many boxes they ticked; a row with
            # no tick is non-response, not a respondent who chose nothing.
            if ticks > 0:
                respondents += 1
                selections += ticks
        counts = [
            {
                "code": c["code"],
                "label": c["label"],
                "count": tally[i],
                "proportion": _linkr_rate(tally[i], respondents),
            }
            for i, c in enumerate(choices)
        ]
        print(_json.dumps(_linkr_summary(total, respondents, counts, {
            "selections": selections,
            "meanSelections": _linkr_rate(selections, respondents),
        })))
        return

    if column not in dataset.columns:
        print(_json.dumps({"error": "no_column"}))
        return
    values = dataset[column].tolist()

    if kind == "numeric":
        nums = []
        for v in values:
            n = _linkr_num(v)
            if n is not None:
                nums.append(n)
        stats = _linkr_describe(nums)
        # The raw values travel too: the histogram bins them client-side, and in
        # server mode there are no rows on the client to bin. Capped because this
        # crosses the wire and a histogram cannot show more detail than its bins
        # anyway — the stats above are computed on the full set, uncapped.
        print(_json.dumps(_linkr_summary(total, len(nums), [], {
            "stats": stats,
            "values": nums[:_LINKR_MAX_VALUES],
        })))
        return

    if kind == "text":
        # Free text is counted like a choice question: a text answer often is one
        # in disguise (a facility name repeated across respondents). A column
        # where every answer is unique simply yields a flat list.
        tally = {}
        respondents = 0
        for v in values:
            if _linkr_blank(v):
                continue
            respondents += 1
            key = str(v).strip()
            tally[key] = tally.get(key, 0) + 1
        counts = [
            {
                "code": k,
                "label": k,
                "count": n,
                "proportion": _linkr_rate(n, respondents),
            }
            for k, n in sorted(tally.items(), key=lambda kv: -kv[1])
        ]
        print(_json.dumps(_linkr_summary(total, respondents, counts, {
            "distinctAnswers": len(counts),
        })))
        return

    # select_one (also a scale or a yes/no): count the distinct values of the one
    # column. Declared choices set the ORDER and supply the labels; a value that
    # is not in the choice list is still reported, so dirty data stays visible.
    tally = {}
    respondents = 0
    for v in values:
        if _linkr_blank(v):
            continue
        respondents += 1
        key = _linkr_match_key(v)
        tally[key] = tally.get(key, 0) + 1

    counts = []
    seen = set()
    for c in choices:
        key = _linkr_match_key(c["code"])
        n = tally.get(key, 0)
        seen.add(key)
        counts.append({
            "code": c["code"],
            "label": c["label"],
            "count": n,
            "proportion": _linkr_rate(n, respondents),
        })
    for key, n in tally.items():
        if key in seen:
            continue
        counts.append({
            "code": key,
            "label": key,
            "count": n,
            "proportion": _linkr_rate(n, respondents),
        })
    print(_json.dumps(_linkr_summary(total, respondents, counts)))
"""
