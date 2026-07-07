import type { DatasetColumn } from '@/types'

/**
 * Build the pandas/scipy code that computes the correlation matrix server-side and
 * prints the same {names, matrix, totalN} the client computes from rows. Pearson/
 * Spearman r + two-sided p-value (t-distribution), pairwise-complete like the JS
 * extractPairwiseNumbers. Parity with computeCorrelationMatrix in the component.
 */
export function buildCorrelationMatrixCode(
  columns: DatasetColumn[],
  selectedIds: string[],
  method: 'pearson' | 'spearman',
): string {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const names = selectedIds
    .map((id) => byId.get(id))
    .filter((c): c is DatasetColumn => !!c && c.type === 'number')
    .map((c) => c.name)

  const spec = { names, method }
  const specStr = JSON.stringify(JSON.stringify(spec))
  return `${_CORR_PY}\n_linkr_print_corr(dataset, _json.loads(${specStr}))\n`
}

const _CORR_PY = String.raw`
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
`
