"""Statistical-tests render: server-owned pandas/scipy program + spec validation.

The `_STAT_PY` body is ported verbatim from the frontend statistical-tests-server.ts
(`_STAT_PY`) — it must stay in parity with computeAllTests in
StatisticalTestsComponent.tsx. Only the spec (group + value columns + preference +
alpha) varies per request; the server never runs client-supplied code.
"""

import json

_ALLOWED_PREFERENCES = {"auto", "parametric", "nonparametric"}


# The tests _select_test can return. Guards spec.overrides: a name outside this
# set would be reported as the test used while a different one actually ran.
_ALLOWED_TESTS = frozenset(
    {"welch-t", "mann-whitney", "chi-square", "fisher", "anova", "kruskal-wallis"}
)


def validate_spec(spec: dict) -> dict:
    """Coerce + validate the client spec into the shape _STAT_PY expects:
    {group: str|None, values: [{name: str, type: str}], preference: str, alpha: float}.
    Raises ValueError on a malformed spec so the route returns a clean 400."""
    if not isinstance(spec, dict):
        raise ValueError("statistical-tests spec must be an object")
    group = spec.get("group")
    if group is not None and not isinstance(group, str):
        raise ValueError("statistical-tests spec.group must be a string or null")
    raw_values = spec.get("values") or []
    if not isinstance(raw_values, list):
        raise ValueError("statistical-tests spec.values must be a list")
    values = []
    for c in raw_values:
        if not isinstance(c, dict) or not isinstance(c.get("name"), str) or not isinstance(c.get("type"), str):
            raise ValueError("statistical-tests spec.values entries need string name and type")
        values.append({"name": c["name"], "type": c["type"]})
    preference = spec.get("preference", "auto")
    if preference not in _ALLOWED_PREFERENCES:
        preference = "auto"
    raw_alpha = spec.get("alpha", 0.05)
    try:
        alpha = float(raw_alpha)
    except (TypeError, ValueError):
        raise ValueError("statistical-tests spec.alpha must be a number")
    # alpha is a fraction in (0, 1): a NaN/inf/out-of-range value flows into
    # t.ppf(1 - alpha/2, …) and surfaces as bare `NaN` in the JSON output (invalid
    # JSON on the wire). Reject non-finite, clamp to the open interval.
    if alpha != alpha or alpha in (float("inf"), float("-inf")):
        raise ValueError("statistical-tests spec.alpha must be finite")
    alpha = min(max(alpha, 1e-6), 1 - 1e-6)
    # Per-variable pinned tests, keyed by column NAME. Only known test names are
    # kept: an unrecognised one would fall through _select_test and be returned
    # as a label with no matching computation.
    raw_overrides = spec.get("overrides") or {}
    if not isinstance(raw_overrides, dict):
        raise ValueError("statistical-tests spec.overrides must be an object")
    overrides = {
        k: v for k, v in raw_overrides.items()
        if isinstance(k, str) and v in _ALLOWED_TESTS
    }
    return {"group": group, "values": values, "preference": preference, "alpha": alpha,
            "overrides": overrides}


def build_code(spec: dict) -> str:
    # Embed the spec as a JSON string parsed at runtime — a JSON object literal
    # isn't valid Python (true/false/null), so json.loads() is required.
    embedded = json.dumps(json.dumps(spec))
    return f"{_STAT_PY}\n_linkr_print_stats(dataset, _json.loads({embedded}))\n"


_STAT_PY = r"""
import json as _json
import math as _math
# scipy emits RuntimeWarning to stderr on valid computations; silence them so a
# non-empty stderr isn't shown as a fatal error when a real result was produced.
import warnings as _warnings
_warnings.filterwarnings("ignore")

_TEST_LABELS = {
    "welch-t": {"en": "Welch's t-test", "fr": "Test t de Welch"},
    "mann-whitney": {"en": "Mann-Whitney U", "fr": "Mann-Whitney U"},
    "chi-square": {"en": "Chi-squared", "fr": "Chi-deux"},
    "fisher": {"en": "Fisher's exact", "fr": "Test exact de Fisher"},
    "anova": {"en": "One-way ANOVA", "fr": "ANOVA à un facteur"},
    "kruskal-wallis": {"en": "Kruskal-Wallis", "fr": "Kruskal-Wallis"},
}
_STAT_SYM = {"welch-t": "t", "mann-whitney": "U", "chi-square": "χ²", "fisher": "", "anova": "F", "kruskal-wallis": "H"}
_EFFECT = {"welch-t": "Cohen's d", "mann-whitney": "r", "chi-square": "Cramér's V", "fisher": "Cramér's V", "anova": "η²", "kruskal-wallis": "η²_H"}

def _linkr_not_missing(v):
    return v is not None and v != "" and str(v).lower() != "null"

def _linkr_nums(series):
    import pandas as _pd
    out = []
    for v in series:
        if not _linkr_not_missing(v):
            continue
        try:
            n = float(v)
        except Exception:
            continue
        if not _math.isnan(n):
            out.append(n)
    return out

def _mk_result(variable, vtype, test, **kw):
    r = {
        "variable": variable, "variableType": vtype, "testName": test,
        "testLabel": _TEST_LABELS[test], "statistic": None, "statisticLabel": _STAT_SYM[test],
        "df": None, "pValue": None, "ci": None, "effectSize": None,
        "effectSizeLabel": _EFFECT[test], "groupDescriptives": None, "warning": None,
    }
    r.update(kw)
    return r

def _mean(a):
    return sum(a) / len(a)

def _var(a, ddof=1):
    m = _mean(a)
    return sum((x - m) ** 2 for x in a) / (len(a) - ddof)

def _sd(a):
    return _math.sqrt(_var(a, 1)) if len(a) > 1 else 0.0

def _median(a):
    s = sorted(a); n = len(s); mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2

def _desc_num(name, a):
    return {"groupName": name, "n": len(a), "mean": _mean(a), "sd": _sd(a), "median": _median(a)}

def _welch(g1, g2, n1name, n2name, alpha):
    from scipy import stats as _st
    import numpy as _np
    if len(g1) < 2 or len(g2) < 2:
        return None
    n1, n2 = len(g1), len(g2)
    m1, m2 = _mean(g1), _mean(g2)
    v1, v2 = _var(g1), _var(g2)
    if v1 == 0 and v2 == 0:
        return None
    se = _math.sqrt(v1 / n1 + v2 / n2)
    t = (m1 - m2) / se
    df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1))
    p = 2 * min(_st.t.cdf(t, df), 1 - _st.t.cdf(t, df))
    tcrit = _st.t.ppf(1 - alpha / 2, df)
    diff = m1 - m2
    ci = [diff - tcrit * se, diff + tcrit * se]
    pooled = _math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2))
    d = abs(diff) / pooled if pooled > 0 else 0
    return {"t": t, "df": df, "p": float(p), "ci": [float(ci[0]), float(ci[1])], "d": d,
            "desc": [_desc_num(n1name, g1), _desc_num(n2name, g2)]}

def _rank_data(values):
    idx = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    ties = []
    i = 0
    while i < len(idx):
        j = i
        while j < len(idx) and values[idx[j]] == values[idx[i]]:
            j += 1
        avg = (i + 1 + j) / 2
        if j - i > 1:
            ties.append(j - i)
        for k in range(i, j):
            ranks[idx[k]] = avg
        i = j
    return ranks, ties

def _mann_whitney(g1, g2, n1name, n2name):
    from scipy import stats as _st
    if len(g1) < 1 or len(g2) < 1:
        return None
    n1, n2 = len(g1), len(g2)
    combined = list(g1) + list(g2)
    ranks, ties = _rank_data(combined)
    R1 = sum(ranks[:n1])
    U1 = R1 - n1 * (n1 + 1) / 2
    U2 = n1 * n2 - U1
    U = min(U1, U2)
    N = n1 + n2
    muU = n1 * n2 / 2
    tie_corr = sum(t ** 3 - t for t in ties)
    sigma = _math.sqrt(n1 * n2 * (N + 1) / 12 - n1 * n2 * tie_corr / (12 * N * (N - 1)))
    z = (U - muU) / sigma if sigma > 0 else 0
    p = 2 * (1 - _st.norm.cdf(abs(z)))
    r = abs(z) / _math.sqrt(N) if sigma > 0 else 0
    return {"U": U, "p": float(p), "r": r, "desc": [_desc_num(n1name, g1), _desc_num(n2name, g2)]}

def _anova(arrays, names):
    from scipy import stats as _st
    k = len(arrays)
    if k < 2:
        return None
    allv = []
    for g in arrays:
        if len(g) < 1:
            return None
        allv.extend(g)
    N = len(allv)
    if N <= k:
        return None
    gm = _mean(allv)
    SSB = sum(len(g) * (_mean(g) - gm) ** 2 for g in arrays)
    SSW = sum((v - _mean(g)) ** 2 for g in arrays for v in g)
    dfB, dfW = k - 1, N - k
    MSW = SSW / dfW
    if MSW == 0:
        return None
    F = (SSB / dfB) / MSW
    p = 1 - _st.f.cdf(F, dfB, dfW)
    eta = SSB / (SSB + SSW)
    desc = [_desc_num(names[i], arrays[i]) for i in range(k)]
    return {"F": F, "dfB": dfB, "p": float(p), "eta": eta, "desc": desc}

def _kruskal(arrays, names):
    from scipy import stats as _st
    k = len(arrays)
    if k < 2:
        return None
    combined = []; gidx = []
    for i in range(k):
        if len(arrays[i]) < 1:
            return None
        for v in arrays[i]:
            combined.append(v); gidx.append(i)
    N = len(combined)
    if N <= k:
        return None
    ranks, ties = _rank_data(combined)
    rank_sums = [0.0] * k; gn = [0] * k
    for i in range(N):
        rank_sums[gidx[i]] += ranks[i]; gn[gidx[i]] += 1
    H = 0.0
    for i in range(k):
        mr = rank_sums[i] / gn[i]
        H += gn[i] * (mr - (N + 1) / 2) ** 2
    H *= 12 / (N * (N + 1))
    tie_corr = sum(t ** 3 - t for t in ties)
    if tie_corr > 0:
        H /= 1 - tie_corr / (N ** 3 - N)
    df = k - 1
    p = 1 - _st.chi2.cdf(H, df)
    eta = (H - k + 1) / (N - k)
    desc = [_desc_num(names[i], arrays[i]) for i in range(k)]
    return {"H": H, "df": df, "p": float(p), "eta": eta, "desc": desc}

def _chi_square(cat_groups, group_names):
    from scipy import stats as _st
    cats = sorted({v for vals in cat_groups.values() for v in vals})
    if len(cats) < 2 or len(group_names) < 2:
        return None
    nr, nc = len(cats), len(group_names)
    obs = [[0] * nc for _ in range(nr)]
    for j, gn in enumerate(group_names):
        for v in cat_groups[gn]:
            if v in cats:
                obs[cats.index(v)][j] += 1
    row_tot = [sum(r) for r in obs]
    col_tot = [sum(obs[i][j] for i in range(nr)) for j in range(nc)]
    N = sum(row_tot)
    if N == 0:
        return None
    chi2 = 0.0; low = 0
    for i in range(nr):
        for j in range(nc):
            e = row_tot[i] * col_tot[j] / N
            if e < 5:
                low += 1
            if e > 0:
                chi2 += (obs[i][j] - e) ** 2 / e
    df = (nr - 1) * (nc - 1)
    p = 1 - _st.chi2.cdf(chi2, df)
    v = _math.sqrt(chi2 / (N * (min(nr, nc) - 1)))
    warning = ("%d cell(s) have expected count < 5" % low) if low > 0 else None
    desc = []
    for j, gn in enumerate(group_names):
        freqs = [{"category": cats[i], "count": obs[i][j],
                  "pct": (obs[i][j] / col_tot[j] * 100) if col_tot[j] > 0 else 0} for i in range(nr)]
        desc.append({"groupName": gn, "n": col_tot[j], "freqs": freqs})
    return {"chi2": chi2, "df": df, "p": float(p), "v": v, "warning": warning, "desc": desc}

def _fisher(cat_groups, group_names):
    from scipy import stats as _st
    if len(group_names) != 2:
        return None
    cats = sorted({v for vals in cat_groups.values() for v in vals})
    if len(cats) != 2:
        return None
    g0 = cat_groups[group_names[0]]; g1 = cat_groups[group_names[1]]
    a = sum(1 for v in g0 if v == cats[0]); c = sum(1 for v in g0 if v == cats[1])
    b = sum(1 for v in g1 if v == cats[0]); d = sum(1 for v in g1 if v == cats[1])
    N = a + b + c + d
    if N == 0:
        return None
    _, p = _st.fisher_exact([[a, b], [c, d]])
    r0 = a + b; c0 = a + c
    e00 = r0 * c0 / N; e01 = r0 * (N - c0) / N; e10 = (N - r0) * c0 / N; e11 = (N - r0) * (N - c0) / N
    chi2 = ((a - e00) ** 2 / e00 if e00 > 0 else 0) + ((b - e01) ** 2 / e01 if e01 > 0 else 0) + \
           ((c - e10) ** 2 / e10 if e10 > 0 else 0) + ((d - e11) ** 2 / e11 if e11 > 0 else 0)
    v = _math.sqrt(chi2 / N)
    desc = [
        {"groupName": group_names[0], "n": a + c, "freqs": [
            {"category": cats[0], "count": a, "pct": (a / (a + c) * 100) if a + c > 0 else 0},
            {"category": cats[1], "count": c, "pct": (c / (a + c) * 100) if a + c > 0 else 0}]},
        {"groupName": group_names[1], "n": b + d, "freqs": [
            {"category": cats[0], "count": b, "pct": (b / (b + d) * 100) if b + d > 0 else 0},
            {"category": cats[1], "count": d, "pct": (d / (b + d) * 100) if b + d > 0 else 0}]},
    ]
    return {"p": float(p), "v": v, "desc": desc}

def _applicable_tests(vtype, group_count):
    # Parity with lib/stats/applicable-tests.ts — the client fills its picker
    # from the same rule, so the two must agree on what a variable can run.
    if vtype == "categorical":
        return ("chi-square", "fisher")
    return ("welch-t", "mann-whitney") if group_count == 2 else ("anova", "kruskal-wallis")

def _select_test(vtype, group_count, pref, is_2x2, min_exp, override=None):
    # A test pinned on the variable wins over the data AND the global preference,
    # but only where it can legitimately run: a pinned two-sample test is dropped
    # once the group column has three levels, rather than silently comparing two
    # of them.
    if override and override in _applicable_tests(vtype, group_count):
        return override
    if vtype == "categorical":
        if is_2x2 and min_exp < 5:
            return "fisher"
        return "chi-square"
    if group_count == 2:
        return "mann-whitney" if pref == "nonparametric" else "welch-t"
    return "kruskal-wallis" if pref == "nonparametric" else "anova"

def _linkr_print_stats(dataset, spec):
    import pandas as _pd
    group = spec.get("group")
    values = spec.get("values", [])
    pref = spec.get("preference", "auto")
    alpha = spec.get("alpha", 0.05)
    overrides = spec.get("overrides") or {}
    if not group or group not in dataset.columns or not values:
        print(_json.dumps([])); return

    # Build groups by the (non-missing) group value.
    group_map = {}
    for _, row in dataset.iterrows():
        gv = row[group]
        if not _linkr_not_missing(gv):
            continue
        group_map.setdefault(str(gv), []).append(row)
    group_names = sorted(group_map.keys())
    group_count = len(group_names)

    results = []

    if group_count < 2:
        for col in values:
            if col["name"] == group:
                continue
            results.append(_mk_result(col["name"], "numeric" if col["type"] == "number" else "categorical",
                                       "welch-t", warning=("No groups found" if group_count == 0 else "Only 1 group")))
        print(_json.dumps(results)); return

    for col in values:
        name = col["name"]
        if name == group or col["type"] == "date" or name not in dataset.columns:
            continue
        is_numeric = col["type"] == "number"
        if is_numeric:
            arrays = []; valid = []
            for gn in group_names:
                nums = _linkr_nums([r[name] for r in group_map[gn]])
                if len(nums) > 0:
                    arrays.append(nums); valid.append(gn)
            if len(valid) < 2:
                results.append(_mk_result(name, "numeric", "welch-t", warning="Insufficient data in groups", statisticLabel=""))
                continue
            test = _select_test("numeric", len(valid), pref, False, 0, overrides.get(name))
            if test == "welch-t":
                res = _welch(arrays[0], arrays[1], valid[0], valid[1], alpha)
                if not res:
                    results.append(_mk_result(name, "numeric", test, warning="Zero variance or n < 2"))
                else:
                    results.append(_mk_result(name, "numeric", test, statistic=res["t"], df=res["df"],
                                              pValue=res["p"], ci=res["ci"], effectSize=res["d"], groupDescriptives=res["desc"]))
            elif test == "mann-whitney":
                res = _mann_whitney(arrays[0], arrays[1], valid[0], valid[1])
                results.append(_mk_result(name, "numeric", test,
                                          statistic=(res["U"] if res else None), pValue=(res["p"] if res else None),
                                          effectSize=(res["r"] if res else None), groupDescriptives=(res["desc"] if res else None),
                                          warning=(None if res else "Insufficient data")))
            elif test == "anova":
                res = _anova(arrays, valid)
                results.append(_mk_result(name, "numeric", test,
                                          statistic=(res["F"] if res else None), df=(res["dfB"] if res else None),
                                          pValue=(res["p"] if res else None), effectSize=(res["eta"] if res else None),
                                          groupDescriptives=(res["desc"] if res else None),
                                          warning=(None if res else "Zero within-group variance or n ≤ k")))
            else:
                res = _kruskal(arrays, valid)
                results.append(_mk_result(name, "numeric", test,
                                          statistic=(res["H"] if res else None), df=(res["df"] if res else None),
                                          pValue=(res["p"] if res else None), effectSize=(res["eta"] if res else None),
                                          groupDescriptives=(res["desc"] if res else None),
                                          warning=(None if res else "Insufficient data")))
        else:
            cat_groups = {}
            for gn in group_names:
                cat_groups[gn] = [str(r[name]) for r in group_map[gn] if _linkr_not_missing(r[name])]
            all_cats = {v for vals in cat_groups.values() for v in vals}
            is_2x2 = len(all_cats) == 2 and len(group_names) == 2
            min_exp = float("inf")
            if is_2x2:
                cats = list(all_cats)
                table = [[sum(1 for v in cat_groups[gn] if v == cat) for cat in cats] for gn in group_names]
                N = sum(x for row in table for x in row)
                row_tot = [sum(table[g][i] for g in range(len(group_names))) for i in range(len(cats))]
                col_tot = [sum(row) for row in table]
                if N > 0:
                    for i in range(2):
                        for j in range(2):
                            e = row_tot[i] * col_tot[j] / N
                            if e < min_exp:
                                min_exp = e
            test = _select_test("categorical", group_count, pref, is_2x2, min_exp, overrides.get(name))
            if test == "fisher":
                res = _fisher(cat_groups, group_names)
                results.append(_mk_result(name, "categorical", test,
                                          pValue=(res["p"] if res else None), effectSize=(res["v"] if res else None),
                                          groupDescriptives=(res["desc"] if res else None),
                                          warning=(None if res else "Cannot compute")))
            else:
                res = _chi_square(cat_groups, group_names)
                results.append(_mk_result(name, "categorical", test,
                                          statistic=(res["chi2"] if res else None), df=(res["df"] if res else None),
                                          pValue=(res["p"] if res else None), effectSize=(res["v"] if res else None),
                                          groupDescriptives=(res["desc"] if res else None),
                                          warning=(res["warning"] if res else "Cannot compute")))
    print(_json.dumps(results))
"""
