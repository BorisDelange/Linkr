"""Correlation matrix render: server-owned pandas/scipy program + spec validation.

The `_CORR_PY` body is ported verbatim from the frontend correlation-matrix-server.ts
(`_CORR_PY`) — it must stay in parity with computeCorrelationMatrix in
CorrelationMatrixComponent.tsx. Only the spec (selected names + method) varies per
request.
"""

import json

# Correlation methods the component offers; the spec is normalized to one of these
# so an unknown method can't reach the Python.
_ALLOWED_METHODS = {"pearson", "spearman"}


def validate_spec(spec: dict) -> dict:
    """Coerce + validate the client spec into the shape _CORR_PY expects:
    {names: [str], method: 'pearson'|'spearman'}.
    Raises ValueError on a malformed spec so the route returns a clean 400."""
    if not isinstance(spec, dict):
        raise ValueError("correlation-matrix spec must be an object")
    raw_names = spec.get("names") or []
    if not isinstance(raw_names, list):
        raise ValueError("correlation-matrix spec.names must be a list")
    names = []
    for n in raw_names:
        if not isinstance(n, str):
            raise ValueError("correlation-matrix spec.names entries must be strings")
        names.append(n)
    method = spec.get("method")
    if method not in _ALLOWED_METHODS:
        method = "pearson"
    return {"names": names, "method": method}


def build_code(spec: dict) -> str:
    # Embed the spec as a JSON string parsed at runtime — a JSON object literal
    # isn't valid Python (true/false/null), so json.loads() is required.
    embedded = json.dumps(json.dumps(spec))
    return f"{_CORR_PY}\n_linkr_print_corr(dataset, _json.loads({embedded}))\n"


_CORR_PY = r"""
import json as _json
import math as _math

def _linkr_print_corr(dataset, spec):
    import pandas as _pd
    import numpy as _np
    from scipy import stats as _stats
    names = [n for n in spec["names"] if n in dataset.columns]
    method = spec.get("method", "pearson")
    total_n = int(len(dataset))
    k = len(names)

    # Numeric-coerce each selected column once (missing/"null"/non-numeric -> NaN).
    cols = {}
    for name in names:
        s = dataset[name]
        s = s.where(s.notna() & (s.astype(str).str.lower() != "null") & (s.astype(str) != ""))
        cols[name] = _pd.to_numeric(s, errors="coerce")

    matrix = [[{"r": 0, "pValue": 1, "n": 0} for _ in range(k)] for _ in range(k)]
    for i in range(k):
        matrix[i][i] = {"r": 1, "pValue": 0, "n": total_n}
        for j in range(i + 1, k):
            a = cols[names[i]]
            b = cols[names[j]]
            mask = a.notna() & b.notna()
            av = a[mask].to_numpy(dtype="float64")
            bv = b[mask].to_numpy(dtype="float64")
            n = int(len(av))
            if n < 2:
                cell = {"r": 0, "pValue": 1, "n": n}
            else:
                try:
                    if method == "spearman":
                        r, p = _stats.spearmanr(av, bv)
                    else:
                        r, p = _stats.pearsonr(av, bv)
                except Exception:
                    r, p = float("nan"), 1.0
                if r is None or (isinstance(r, float) and _math.isnan(r)):
                    cell = {"r": 0, "pValue": 1, "n": n}
                else:
                    cell = {"r": float(r), "pValue": float(p) if p is not None and not (isinstance(p, float) and _math.isnan(p)) else 1.0, "n": n}
            matrix[i][j] = cell
            matrix[j][i] = cell

    print(_json.dumps({"names": names, "matrix": matrix, "totalN": total_n}))
"""
