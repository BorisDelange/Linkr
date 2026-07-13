"""Kaplan-Meier render: server-owned pandas/lifelines program + spec validation.

The `_KM_PY` body is ported verbatim from the frontend kaplan-meier-server.ts
(`_KM_PY`) — it must stay in parity with computeKMResult in KaplanMeierComponent.tsx.
Only the spec (time/event/group columns + confidence level) varies per request.
"""

import json


def validate_spec(spec: dict) -> dict:
    """Coerce + validate the client spec into the shape _KM_PY expects:
    {time: str, event: str, group: str|None, confidenceLevel: float}.
    Raises ValueError on a malformed spec so the route returns a clean 400."""
    if not isinstance(spec, dict):
        raise ValueError("kaplan-meier spec must be an object")
    time = spec.get("time")
    event = spec.get("event")
    if not isinstance(time, str) or not time:
        raise ValueError("kaplan-meier spec.time must be a non-empty string")
    if not isinstance(event, str) or not event:
        raise ValueError("kaplan-meier spec.event must be a non-empty string")
    group = spec.get("group")
    if group is not None and not isinstance(group, str):
        raise ValueError("kaplan-meier spec.group must be a string or null")
    raw_conf = spec.get("confidenceLevel")
    if raw_conf is None:
        conf = 95.0
    else:
        try:
            conf = float(raw_conf)
        except (TypeError, ValueError):
            raise ValueError("kaplan-meier spec.confidenceLevel must be a number")
        # confidenceLevel is a PERCENTAGE (0–100): _KM_PY computes alpha = 1 - conf/100,
        # matching the component (config.confidenceLevel ?? 95). Keep that scale — do
        # not rescale to a (0,1) fraction. Reject non-finite / out-of-range values.
        if conf != conf or conf in (float("inf"), float("-inf")):
            raise ValueError("kaplan-meier spec.confidenceLevel must be finite")
        conf = min(max(conf, 1e-6), 100.0)
    return {"time": time, "event": event, "group": group, "confidenceLevel": conf}


def build_code(spec: dict) -> str:
    # Embed the spec as a JSON string parsed at runtime — a JSON object literal
    # isn't valid Python (true/false/null), so json.loads() is required.
    embedded = json.dumps(json.dumps(spec))
    return f"{_KM_PY}\n_linkr_print_km(dataset, _json.loads({embedded}))\n"


_KM_PY = r"""
import json as _json
import math as _math
# lifelines/scipy emit warnings to stderr on valid fits; silence them so a
# non-empty stderr isn't shown as a fatal error when a real result was produced.
import warnings as _warnings
_warnings.filterwarnings("ignore")

def _km_not_missing(v):
    return v is not None and v != "" and str(v).lower() != "null"

def _linkr_print_km(dataset, spec):
    import pandas as _pd
    import numpy as _np
    from lifelines import KaplanMeierFitter
    from lifelines.statistics import multivariate_logrank_test
    from scipy import stats as _sps

    tname = spec.get("time"); ename = spec.get("event"); gname = spec.get("group")
    conf = spec.get("confidenceLevel", 95)
    alpha = 1 - conf / 100
    zcrit = _sps.norm.ppf(1 - alpha / 2)

    if not tname or not ename or tname not in dataset.columns or ename not in dataset.columns:
        print(_json.dumps(None)); return

    warnings = []
    times = []; events = []; groups = []
    n_missing = 0
    for _, row in dataset.iterrows():
        traw = row[tname]; eraw = row[ename]
        if not _km_not_missing(traw) or not _km_not_missing(eraw):
            n_missing += 1; continue
        try:
            t = float(traw)
        except Exception:
            n_missing += 1; continue
        if _math.isnan(t) or t < 0:
            n_missing += 1; continue
        es = str(eraw).lower().strip()
        ev = 1 if es in ("1", "true", "yes") else 0
        g = str(row[gname]) if (gname and _km_not_missing(row[gname])) else "(All)"
        times.append(t); events.append(ev); groups.append(g)

    if n_missing > 0:
        warnings.append("%d row(s) excluded (missing/invalid values)" % n_missing)
    if not times:
        print(_json.dumps({"groups": [], "logRank": None, "warnings": warnings + ["No valid observations"]}))
        return

    df = _pd.DataFrame({"t": times, "e": events, "g": groups})
    group_names = sorted(df["g"].unique().tolist())

    out_groups = []
    for name in group_names:
        sub = df[df["g"] == name]
        T = sub["t"].to_numpy(); E = sub["e"].to_numpy()
        kmf = KaplanMeierFitter()
        # log(-log) CI to match the browser's transformation.
        kmf.fit(T, E, alpha=alpha, ci_labels=["lo", "hi"])
        et = kmf.event_table  # index=time, cols: removed, observed, censored, at_risk, entrance
        sf = kmf.survival_function_.iloc[:, 0]
        try:
            ci = kmf.confidence_interval_
            ci_lo_col = ci.iloc[:, 0]; ci_hi_col = ci.iloc[:, 1]
        except Exception:
            ci_lo_col = None; ci_hi_col = None

        steps = [{"time": 0, "nRisk": int(len(sub)), "nEvent": 0, "nCensor": 0,
                  "survival": 1.0, "ciLow": 1.0, "ciHigh": 1.0}]
        for tt in et.index:
            if tt == 0:
                # lifelines puts an origin row; skip it (we already emitted the S=1 origin).
                if float(et.loc[tt, "observed"]) == 0 and float(et.loc[tt, "censored"]) == 0:
                    continue
            n_risk = int(et.loc[tt, "at_risk"])
            n_event = int(et.loc[tt, "observed"])
            n_censor = int(et.loc[tt, "censored"])
            s = float(sf.loc[tt]) if tt in sf.index else steps[-1]["survival"]
            lo = float(ci_lo_col.loc[tt]) if ci_lo_col is not None and tt in ci_lo_col.index else s
            hi = float(ci_hi_col.loc[tt]) if ci_hi_col is not None and tt in ci_hi_col.index else s
            if _math.isnan(lo): lo = s
            if _math.isnan(hi): hi = s
            steps.append({"time": float(tt), "nRisk": n_risk, "nEvent": n_event,
                          "nCensor": n_censor, "survival": max(0.0, s),
                          "ciLow": max(0.0, min(1.0, lo)), "ciHigh": max(0.0, min(1.0, hi))})

        # Median = smallest time where S <= 0.5; CI from the step CI bounds crossing 0.5.
        median = None; med_lo = None; med_hi = None
        for st in steps:
            if st["survival"] <= 0.5:
                median = st["time"]; break
        if median is not None:
            for st in steps:
                if st["ciHigh"] <= 0.5:
                    med_lo = st["time"]; break
            for st in steps:
                if st["ciLow"] <= 0.5:
                    med_hi = st["time"]; break

        out_groups.append({
            "name": name, "steps": steps,
            "medianSurvival": median, "medianCiLow": med_lo, "medianCiHigh": med_hi,
            "totalN": int(len(sub)), "totalEvents": int(E.sum()),
        })

    log_rank = None
    if len(group_names) >= 2:
        try:
            res = multivariate_logrank_test(df["t"], df["g"], df["e"])
            log_rank = {"chiSquare": float(res.test_statistic), "df": int(len(group_names) - 1),
                        "pValue": float(res.p_value)}
        except Exception:
            log_rank = None

    print(_json.dumps({"groups": out_groups, "logRank": log_rank, "warnings": warnings}))
"""
