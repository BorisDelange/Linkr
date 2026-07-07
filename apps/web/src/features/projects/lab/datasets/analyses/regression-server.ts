import type { DatasetColumn } from '@/types'

/**
 * Build the pandas/statsmodels code that fits the regression server-side and prints
 * the same RegressionResult JSON the client computes from rows. Manual dummy encoding
 * (reference = first sorted category, "col: cat" names) + statsmodels OLS/Logit fit;
 * CIs use the normal z-crit and p-values match the client. Parity with runRegression.
 */
export function buildRegressionCode(
  columns: DatasetColumn[],
  outcomeId: string,
  predictorIds: string[],
  regressionType: 'auto' | 'linear' | 'logistic',
  confidenceLevel: number,
): string {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const outcome = byId.get(outcomeId)
  const predictors = predictorIds
    .filter((id) => id !== outcomeId)
    .map((id) => byId.get(id))
    .filter((c): c is DatasetColumn => !!c)
    .map((c) => ({ name: c.name, numeric: c.type === 'number' }))

  const spec = {
    outcome: outcome ? { name: outcome.name, numeric: outcome.type === 'number' } : null,
    predictors,
    regressionType,
    confidenceLevel,
  }
  const specStr = JSON.stringify(JSON.stringify(spec))
  return `${_REG_PY}\n_linkr_print_reg(dataset, _json.loads(${specStr}))\n`
}

const _REG_PY = String.raw`
import json as _json
import math as _math

def _reg_not_missing(v):
    return v is not None and v != "" and str(v).lower() != "null"

def _reg_is_binary(vals):
    uniq = set()
    for v in vals:
        if not _reg_not_missing(v):
            continue
        uniq.add(str(v))
        if len(uniq) > 2:
            return False
    return len(uniq) == 2

def _linkr_print_reg(dataset, spec):
    import pandas as _pd
    import numpy as _np
    from scipy import stats as _sps
    import statsmodels.api as _sm

    outcome = spec.get("outcome")
    predictors = spec.get("predictors", [])
    reg_type = spec.get("regressionType", "auto")
    conf = spec.get("confidenceLevel", 95)
    alpha = 1 - conf / 100

    if not outcome or outcome["name"] not in dataset.columns or not predictors:
        print(_json.dumps(None)); return

    oname = outcome["name"]
    warnings = []
    n_obs = int(len(dataset))

    # Auto-detect logistic vs linear.
    if reg_type == "auto":
        if outcome["numeric"]:
            vals = [v for v in dataset[oname] if _reg_not_missing(v)]
            is_logistic = _reg_is_binary(vals)
        else:
            is_logistic = True
    else:
        is_logistic = reg_type == "logistic"

    rtype = "logistic" if is_logistic else "linear"

    # Predictor specs: numeric passthrough, categorical -> sorted cats (ref = first).
    specs = []
    for p in predictors:
        pn = p["name"]
        if pn == oname or pn not in dataset.columns:
            continue
        if p["numeric"]:
            specs.append({"name": pn, "numeric": True})
        else:
            cats = sorted({str(v) for v in dataset[pn] if _reg_not_missing(v)})
            if len(cats) < 2:
                warnings.append("%s: single category, skipped" % pn); continue
            if len(cats) > 20:
                warnings.append("%s: %d categories (>20), skipped" % (pn, len(cats))); continue
            specs.append({"name": pn, "numeric": False, "cats": cats})

    if not specs:
        print(_json.dumps(None)); return

    pred_names = ["(Intercept)"]
    for s in specs:
        if s["numeric"]:
            pred_names.append(s["name"])
        else:
            for c in s["cats"][1:]:
                pred_names.append("%s: %s" % (s["name"], c))

    # Binary outcome map for logistic (numeric 0/1 preserved, else 0/1 by sorted order).
    outcome_map = None
    if is_logistic:
        uniq = sorted({str(v) for v in dataset[oname] if _reg_not_missing(v)})
        if len(uniq) != 2:
            print(_json.dumps({"type": rtype, "coefficients": [], "nObs": n_obs, "nComplete": 0,
                               "warnings": warnings + ["Outcome must be binary for logistic regression (found %d values)" % len(uniq)]}))
            return
        try:
            nv = [float(uniq[0]), float(uniq[1])]
        except Exception:
            nv = None
        if nv is not None and ((nv[0] == 0 and nv[1] == 1) or (nv[0] == 1 and nv[1] == 0)):
            outcome_map = {uniq[0]: nv[0], uniq[1]: nv[1]}
        else:
            outcome_map = {uniq[0]: 0.0, uniq[1]: 1.0}

    # Build X (with intercept) and y, dropping incomplete rows.
    X_rows = []; y_vec = []; n_missing = 0
    p_len = len(pred_names)
    for _, row in dataset.iterrows():
        yraw = row[oname]
        if not _reg_not_missing(yraw):
            n_missing += 1; continue
        if is_logistic:
            yval = outcome_map.get(str(yraw))
            if yval is None:
                n_missing += 1; continue
        else:
            try:
                yval = float(yraw)
            except Exception:
                n_missing += 1; continue
            if _math.isnan(yval):
                n_missing += 1; continue
        xrow = [1.0]; skip = False
        for s in specs:
            v = row[s["name"]]
            if not _reg_not_missing(v):
                skip = True; break
            if s["numeric"]:
                try:
                    nv = float(v)
                except Exception:
                    skip = True; break
                if _math.isnan(nv):
                    skip = True; break
                xrow.append(nv)
            else:
                sv = str(v)
                if sv not in s["cats"]:
                    skip = True; break
                for c in s["cats"][1:]:
                    xrow.append(1.0 if sv == c else 0.0)
        if skip or len(xrow) != p_len:
            n_missing += 1; continue
        X_rows.append(xrow); y_vec.append(yval)

    if n_missing > 0:
        warnings.append("%d row(s) excluded (missing values)" % n_missing)

    n_complete = len(X_rows)
    if n_complete < p_len + 1:
        print(_json.dumps({"type": rtype, "coefficients": [], "nObs": n_obs, "nComplete": n_complete,
                           "warnings": warnings + ["Not enough observations (%d) for %d parameters" % (n_complete, p_len)]}))
        return

    X = _np.array(X_rows, dtype="float64")
    y = _np.array(y_vec, dtype="float64")
    zcrit = _sps.norm.ppf(1 - alpha / 2)

    if is_logistic:
        try:
            model = _sm.Logit(y, X).fit(disp=0, maxiter=50)
        except Exception as e:
            print(_json.dumps({"type": "logistic", "coefficients": [], "nObs": n_obs, "nComplete": n_complete,
                               "warnings": warnings + ["Logistic regression failed to converge"]}))
            return
        beta = model.params
        se = model.bse
        coefs = []
        for j, name in enumerate(pred_names):
            b = float(beta[j]); s_e = float(se[j])
            z = b / s_e if s_e > 0 else 0
            pval = 2 * (1 - _sps.norm.cdf(abs(z))) if s_e > 0 else 1
            lo = b - zcrit * s_e; hi = b + zcrit * s_e
            coefs.append({"name": name, "estimate": b, "se": s_e, "ciLow": lo, "ciHigh": hi,
                          "statistic": z, "pValue": float(pval), "or": _math.exp(b),
                          "orCiLow": _math.exp(lo), "orCiHigh": _math.exp(hi)})
        ll = float(model.llf)
        aic = -2 * ll + 2 * p_len
        print(_json.dumps({"type": "logistic", "coefficients": coefs, "nObs": n_obs, "nComplete": n_complete,
                           "logLikelihood": ll, "aic": aic, "warnings": warnings}))
        return

    # Linear OLS.
    try:
        model = _sm.OLS(y, X).fit()
    except Exception:
        print(_json.dumps({"type": "linear", "coefficients": [], "nObs": n_obs, "nComplete": n_complete,
                           "warnings": warnings + ["Linear regression failed (singular matrix)"]}))
        return
    n = n_complete; p = p_len
    beta = model.params; bse = model.bse
    df_resid = n - p
    coefs = []
    for j, name in enumerate(pred_names):
        b = float(beta[j]); s_e = float(bse[j])
        t = b / s_e if s_e > 0 else 0
        pval = 2 * min(_sps.t.cdf(t, df_resid), 1 - _sps.t.cdf(t, df_resid)) if s_e > 0 else 1
        # CI uses the normal z-crit (parity with the browser implementation).
        coefs.append({"name": name, "estimate": b, "se": s_e, "ciLow": b - zcrit * s_e,
                      "ciHigh": b + zcrit * s_e, "statistic": t, "pValue": float(pval)})
    r2 = float(model.rsquared)
    adj = float(model.rsquared_adj)
    fstat = float(model.fvalue) if model.fvalue is not None else 0
    fp = float(model.f_pvalue) if model.f_pvalue is not None else 1
    print(_json.dumps({"type": "linear", "coefficients": coefs, "nObs": n_obs, "nComplete": n_complete,
                       "rSquared": r2, "adjRSquared": adj, "fStatistic": fstat, "fPValue": fp, "warnings": warnings}))
`
