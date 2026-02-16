/**
 * Code generator for Table 1 (descriptive statistics) analysis.
 *
 * Produces a Python script that computes per-variable statistics
 * and returns a pandas DataFrame as the result.
 */

import type { DatasetColumn } from '@/types'

export function generateTable1Code(
  config: Record<string, unknown>,
  columns: DatasetColumn[],
): string {
  const selectedIds = config.selectedColumns as string[] | undefined
  const groupByName = config.groupByColumn as string | undefined

  // Resolve column names from IDs (or use all columns if none selected)
  const selectedNames = selectedIds
    ? selectedIds
        .map((id) => columns.find((c) => c.id === id)?.name)
        .filter(Boolean) as string[]
    : columns.map((c) => c.name)

  const colsLiteral = JSON.stringify(selectedNames)
  const groupByLiteral = groupByName ? JSON.stringify(groupByName) : 'None'

  return `import pandas as pd
import numpy as np

# --- Table 1: Descriptive statistics ---
# 'dataset' is a pandas DataFrame injected automatically.
# To run in IDE, uncomment: dataset = pd.read_csv("data/datasets/your_file.csv")

columns = ${colsLiteral}
group_by = ${groupByLiteral}

def describe_column(series, total_n):
    """Compute descriptive stats for a single column."""
    n = series.notna().sum()
    missing = series.isna().sum()
    missing_pct = f"{missing} ({missing / total_n * 100:.1f}%)" if missing > 0 else "—"

    if pd.api.types.is_bool_dtype(series):
        counts = series.dropna().value_counts().head(10)
        cats = "; ".join(f"{v}: {c} ({c/total_n*100:.1f}%)" for v, c in counts.items())
        return {"n": n, "Missing": missing_pct, "Mean ± SD": "—",
                "Median [IQR]": "—", "Categories": cats if cats else "—"}
    elif pd.api.types.is_numeric_dtype(series):
        s = series.dropna().astype(float)
        mean_sd = f"{s.mean():.2f} ± {s.std():.2f}" if len(s) > 0 else "—"
        q1, med, q3 = s.quantile([0.25, 0.5, 0.75]) if len(s) > 0 else (0, 0, 0)
        median_iqr = f"{med:.2f} [{q1:.2f}–{q3:.2f}]" if len(s) > 0 else "—"
        return {"n": n, "Missing": missing_pct, "Mean ± SD": mean_sd,
                "Median [IQR]": median_iqr, "Categories": "—"}
    else:
        counts = series.dropna().value_counts().head(10)
        cats = "; ".join(f"{v}: {c} ({c/total_n*100:.1f}%)" for v, c in counts.items())
        return {"n": n, "Missing": missing_pct, "Mean ± SD": "—",
                "Median [IQR]": "—", "Categories": cats if cats else "—"}

total_n = len(dataset)
rows = []
for col in columns:
    if col not in dataset.columns:
        continue
    stats = describe_column(dataset[col], total_n)
    rows.append({"Variable": col, **stats})

result = pd.DataFrame(rows)
result
`
}
