"""Cox proportional-hazards render: server-owned lifelines program + spec validation.

There is no client-side counterpart to keep in parity with, unlike the other
render kinds: fitting a Cox model means Newton-Raphson plus a covariance matrix,
and the browser build has no lifelines. The component shows the Cox tab as
unavailable outside server mode rather than carrying a second implementation.

Emits, on stdout, one JSON object:
  {coefficients: [...], nObs, nEvents, concordance, logLikelihood, aic,
   logLikelihoodRatioTest: {...}, proportionalHazards: [...], warnings: [...]}
"""

import json


def validate_spec(spec: dict) -> dict:
    """Coerce + validate the client spec into the shape _COX_PY expects:
    {time, event, predictors: [{name, numeric}], confidenceLevel}.
    Raises ValueError on a malformed spec so the route returns a clean 400."""
    if not isinstance(spec, dict):
        raise ValueError("cox spec must be an object")
    time = spec.get("time")
    event = spec.get("event")
    if not isinstance(time, str) or not time:
        raise ValueError("cox spec.time must be a non-empty string")
    if not isinstance(event, str) or not event:
        raise ValueError("cox spec.event must be a non-empty string")

    raw_predictors = spec.get("predictors")
    if not isinstance(raw_predictors, list) or not raw_predictors:
        raise ValueError("cox spec.predictors must be a non-empty array")
    predictors: list[dict] = []
    seen: set[str] = set()
    for p in raw_predictors:
        if not isinstance(p, dict):
            raise ValueError("cox spec.predictors entries must be objects")
        name = p.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError("cox predictor.name must be a non-empty string")
        # A predictor that is also the time or event column would be collinear
        # with the outcome by construction; drop it rather than fitting nonsense.
        if name in (time, event) or name in seen:
            continue
        seen.add(name)
        predictors.append({"name": name, "numeric": bool(p.get("numeric"))})
    if not predictors:
        raise ValueError("cox spec.predictors must name at least one usable column")

    raw_conf = spec.get("confidenceLevel")
    if raw_conf is None:
        conf = 95.0
    else:
        try:
            conf = float(raw_conf)
        except (TypeError, ValueError):
            raise ValueError("cox spec.confidenceLevel must be a number")
        # A PERCENTAGE (0–100), matching kaplan_meier.py and the component.
        if conf != conf or conf in (float("inf"), float("-inf")):
            raise ValueError("cox spec.confidenceLevel must be finite")
        conf = min(max(conf, 1e-6), 100.0)

    return {"time": time, "event": event, "predictors": predictors, "confidenceLevel": conf}


def build_code(spec: dict) -> str:
    # Embed the spec as a JSON string parsed at runtime — a JSON object literal
    # isn't valid Python (true/false/null), so json.loads() is required.
    embedded = json.dumps(json.dumps(spec))
    return f"{_COX_PY}\n_linkr_print_cox(dataset, _json.loads({embedded}))\n"


_COX_PY = r"""
import json as _json
import math as _math
# lifelines/scipy emit convergence and tie-handling warnings to stderr on
# perfectly valid fits; silence them so a non-empty stderr isn't surfaced as a
# fatal error when a real result was produced.
import warnings as _warnings
_warnings.filterwarnings("ignore")


def _cox_not_missing(v):
    return v is not None and v != "" and str(v).lower() != "null"


def _cox_exp(x):
    # math.exp RAISES OverflowError past ~709 rather than returning infinity,
    # and a near-separated fit (a covariate that predicts the event almost
    # perfectly) reaches that easily. None travels through _cox_finite as a
    # JSON null, which the table shows as a dash.
    if x is None:
        return None
    try:
        return _math.exp(x)
    except OverflowError:
        return None


def _cox_finite(x, nd=6):
    # A JSON-safe float: NaN and infinities are not valid JSON. A comment
    # rather than a docstring — this body lives inside an r-string, which a
    # nested triple quote would terminate.
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return round(f, nd)


def _linkr_print_cox(dataset, spec):
    import pandas as _pd

    time_col = spec["time"]
    event_col = spec["event"]
    conf = float(spec["confidenceLevel"])
    alpha = 1.0 - conf / 100.0
    warnings = []

    for needed in (time_col, event_col):
        if needed not in dataset.columns:
            print(_json.dumps({"error": "Column not found: %s" % needed}))
            return

    df = dataset.copy()

    # Time and event, coerced the same way the Kaplan-Meier program does them:
    # 1/true/yes is the event, anything else is censoring — NOT a missing value.
    df["_t"] = _pd.to_numeric(df[time_col], errors="coerce")
    df["_e"] = df[event_col].map(
        lambda v: 1 if str(v).strip().lower() in ("1", "true", "yes") else 0
    )
    df.loc[~df[event_col].map(_cox_not_missing), "_e"] = None
    df["_e"] = _pd.to_numeric(df["_e"], errors="coerce")

    n_before = len(df)
    df = df[df["_t"].notna() & df["_e"].notna()]
    # A non-positive duration has no place on a hazard scale, and lifelines
    # rejects the whole frame if any survive.
    df = df[df["_t"] > 0]

    design = _pd.DataFrame(index=df.index)
    # Each label names the coefficient for the reader, so a dummy carries its
    # level: "Site: CH Vannes", matching how the regression plugin names its own.
    labels = {}
    for p in spec["predictors"]:
        name = p["name"]
        if name not in df.columns:
            warnings.append("%s: column not found, skipped" % name)
            continue
        if p["numeric"]:
            col = _pd.to_numeric(df[name], errors="coerce")
            if col.notna().sum() == 0:
                warnings.append("%s: no numeric values, skipped" % name)
                continue
            # A constant column carries no information and makes the
            # information matrix singular.
            if col.nunique(dropna=True) < 2:
                warnings.append("%s: single value, skipped" % name)
                continue
            design[name] = col
            labels[name] = name
        else:
            vals = df[name].where(df[name].map(_cox_not_missing))
            cats = sorted({str(v) for v in vals.dropna()})
            if len(cats) < 2:
                warnings.append("%s: single category, skipped" % name)
                continue
            if len(cats) > 20:
                warnings.append("%s: %d categories (>20), skipped" % (name, len(cats)))
                continue
            # Reference = first category, so the coefficients read as contrasts
            # against it — the same convention as the regression plugin.
            for c in cats[1:]:
                key = "%s::%s" % (name, c)
                design[key] = (vals.astype(str) == c).astype(float)
                labels[key] = "%s: %s" % (name, c)

    if design.shape[1] == 0:
        print(_json.dumps({"error": "No usable predictors", "warnings": warnings}))
        return

    design["_t"] = df["_t"]
    design["_e"] = df["_e"]
    fit_df = design.dropna()

    n_obs = int(len(fit_df))
    n_events = int(fit_df["_e"].sum()) if n_obs else 0
    dropped = n_before - n_obs
    if dropped > 0:
        warnings.append("%d rows excluded (missing time, event or predictor)" % dropped)

    # Ten events per covariate is the usual rule of thumb; below it the
    # estimates are unstable, which the reader should be told rather than
    # discover in an implausibly wide interval.
    n_cov = design.shape[1] - 2
    if n_events > 0 and n_events < 10 * n_cov:
        warnings.append(
            "%d events for %d covariate(s): estimates may be unstable (rule of thumb: 10 events per covariate)"
            % (n_events, n_cov)
        )

    if n_obs < 2 or n_events == 0:
        print(_json.dumps({
            "error": "Not enough events to fit a Cox model",
            "nObs": n_obs, "nEvents": n_events, "warnings": warnings,
        }))
        return

    try:
        from lifelines import CoxPHFitter
    except ImportError:
        print(_json.dumps({"error": "lifelines is not installed on this server"}))
        return

    # alpha here IS the requested level: lifelines names its CI columns from it,
    # so fitting with the default 0.05 and then asking for a 90% column would
    # silently fall through to the recomputed interval below.
    cph = CoxPHFitter(alpha=alpha)
    try:
        cph.fit(fit_df, duration_col="_t", event_col="_e", show_progress=False)
    except Exception as exc:  # convergence failure, singular matrix, …
        print(_json.dumps({
            "error": "Cox model did not converge: %s" % exc,
            "nObs": n_obs, "nEvents": n_events, "warnings": warnings,
        }))
        return

    summary = cph.summary
    lower_key = "coef lower %g%%" % (100 * (1 - alpha))
    upper_key = "coef upper %g%%" % (100 * (1 - alpha))

    coefficients = []
    for key in summary.index:
        row = summary.loc[key]
        coef = _cox_finite(row["coef"])
        se = _cox_finite(row["se(coef)"])
        # lifelines reports the CI at ITS alpha, which is 0.05 unless told
        # otherwise; recompute at the requested level so the column header and
        # the numbers under it agree.
        lo, hi = None, None
        if lower_key in summary.columns and upper_key in summary.columns:
            lo, hi = _cox_finite(row[lower_key]), _cox_finite(row[upper_key])
        if (lo is None or hi is None) and coef is not None and se is not None:
            try:
                from scipy.stats import norm as _norm
                z = float(_norm.ppf(1 - alpha / 2))
            except Exception:
                z = 1.959963985
            lo, hi = coef - z * se, coef + z * se
        coefficients.append({
            "name": labels.get(key, str(key)),
            # The hazard ratio is what a reader interprets; the log-hazard
            # coefficient is kept so the forest plot can work on a linear scale.
            "coef": coef,
            "hazardRatio": _cox_finite(_cox_exp(coef)),
            "se": se,
            "z": _cox_finite(row["z"]),
            "pValue": _cox_finite(row["p"], 10),
            "ciLow": _cox_finite(_cox_exp(lo)),
            "ciHigh": _cox_finite(_cox_exp(hi)),
        })

    out = {
        "coefficients": coefficients,
        "nObs": n_obs,
        "nEvents": n_events,
        "concordance": _cox_finite(getattr(cph, "concordance_index_", None)),
        "logLikelihood": _cox_finite(getattr(cph, "log_likelihood_", None)),
        "aic": _cox_finite(getattr(cph, "AIC_partial_", None)),
        "confidenceLevel": conf,
        "warnings": warnings,
    }

    try:
        stat = float(cph.log_likelihood_ratio_test().test_statistic)
        pval = float(cph.log_likelihood_ratio_test().p_value)
        out["logLikelihoodRatioTest"] = {
            "statistic": _cox_finite(stat),
            "pValue": _cox_finite(pval, 10),
            "df": int(n_cov),
        }
    except Exception:
        pass

    # The proportional-hazards check: the model's central assumption, and the
    # thing a reviewer asks about. A small p means the hazard ratio for that
    # covariate does not hold constant over time, so the single number reported
    # above is an average over a changing effect.
    try:
        from lifelines.statistics import proportional_hazard_test
        ph = proportional_hazard_test(cph, fit_df, time_transform="rank")
        ph_rows = []
        for key in ph.summary.index:
            name = key[0] if isinstance(key, tuple) else key
            row = ph.summary.loc[key]
            ph_rows.append({
                "name": labels.get(name, str(name)),
                "statistic": _cox_finite(row["test_statistic"]),
                "pValue": _cox_finite(row["p"], 10),
            })
        out["proportionalHazards"] = ph_rows
    except Exception:
        # An informative diagnostic, not the result: if it cannot be computed
        # the model itself is still worth showing.
        pass

    print(_json.dumps(out))
"""
