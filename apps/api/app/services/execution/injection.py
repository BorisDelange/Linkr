"""Build the server-side dataset-injection preamble for an execution run.

The browser's analysis-executor injects a ``dataset`` DataFrame from the rows it
holds in memory. Server-side we never ship rows to the browser — instead we read
the dataset's Parquet blob directly into the kernel and expose the same
``dataset`` variable, with columns renamed from columnId to their display name
and typed like the client (number -> numeric, date -> datetime). Parity with
apps/web/src/features/projects/lab/datasets/analysis-executor.ts.
"""

import json
import math

from app.models.dataset import DatasetFile
from app.services import blob_store


def python_preamble(node: DatasetFile, filters: list[dict] | None = None) -> str:
    """Python `dataset` injection for a DB-backed dataset (legacy blob path)."""
    path = blob_store.path_for(node.data_sha).as_posix() if node.data_sha else ""
    return python_preamble_from(path, node.columns or [], filters)


def python_preamble_from(
    path: str, columns: list[dict], filters: list[dict] | None = None, native: bool = False
) -> str:
    """Python code that loads a Parquet file at `path` as a `dataset` DataFrame.

    `filters` (dashboard filters, resolved client-side to concrete predicates keyed
    by columnId) are applied to the raw Parquet before columns are renamed, so a
    widget sees the same filtered rows it would in front-only mode. A `native`
    Parquet is read in place, with its real column names instead of the ids."""
    filters = _keyed_by_raw_column(filters or [], columns, native)
    rename = {c["id"]: c["name"] for c in columns}
    number_cols = [c["name"] for c in columns if c.get("type") == "number"]
    date_cols = [c["name"] for c in columns if c.get("type") == "date"]
    read = (
        f"_pd.read_parquet({json.dumps(path)})" if path else "_pd.DataFrame()"
    )
    filter_code = _python_filter_code(filters or [])
    return f"""
import pandas as _pd
dataset = {read}
{filter_code}
dataset = dataset.rename(columns={json.dumps(rename)})
_linkr_conv = {{_c: _pd.to_numeric(dataset[_c], errors="coerce") for _c in {json.dumps(number_cols)} if _c in dataset.columns}}
_linkr_conv.update({{_c: _pd.to_datetime(dataset[_c], errors="coerce") for _c in {json.dumps(date_cols)} if _c in dataset.columns}})
# Swapped in with one concat: assigning ~50 columns one by one fragments the frame,
# and pandas then warns (on stderr) at the next groupby.
if _linkr_conv:
    dataset = _pd.concat(
        [dataset.drop(columns=list(_linkr_conv)), _pd.DataFrame(_linkr_conv, index=dataset.index)],
        axis=1,
    )[list(dataset.columns)]
del _linkr_conv
"""


def _keyed_by_raw_column(filters: list[dict], columns: list[dict], native: bool) -> list[dict]:
    """Predicates arrive keyed by column id; a native Parquet's raw columns carry the
    names instead. The filter code skips a column it can't find, so an un-mapped
    predicate would silently leave the widget unfiltered."""
    if not native:
        return filters
    name_by_id = {c["id"]: c["name"] for c in columns}
    return [{**f, "colId": name_by_id.get(f.get("colId"), f.get("colId"))} for f in filters]


def _python_filter_code(filters: list[dict]) -> str:
    """pandas code applying resolved filter predicates (keyed by columnId, raw
    Parquet column). Each predicate ORs its alternatives; predicates are AND'd.

    Predicate: {colId, kind: 'string'|'number'|'date', alternatives: [
        {op: 'in', values: [...]} | {op: 'between', min?, max?}]}.
    number → numeric compare (a non-finite bound matches nothing); date →
    ISO-string compare (lexical works for ISO) on the value cut to the bound's
    length, so a day bound keeps the whole end day, missing values never match;
    string/categorical → string equality via `in`."""
    lines: list[str] = []
    for f in filters:
        col = f.get("colId")
        alts = f.get("alternatives") or []
        if not col or not alts:
            continue
        col_j = json.dumps(col)
        kind = f.get("kind", "string")
        # The comparison series: numeric-coerced for numbers, string otherwise.
        # A boolean column stringifies as "True"/"False" in pandas, but the filter
        # values come from the UI as "true"/"false" — lower-case the boolean
        # literals so a boolean filter matches instead of silently excluding all.
        if kind == "number":
            series = f"_pd.to_numeric(dataset[{col_j}], errors='coerce')"
        elif kind == "date":
            series = f"dataset[{col_j}].astype(str).where(dataset[{col_j}].notna())"
        else:
            series = f"dataset[{col_j}].astype(str).replace({{'True': 'true', 'False': 'false'}})"
        clauses: list[str] = []
        for alt in alts:
            if alt.get("op") == "in":
                vals = [str(v) for v in alt.get("values", [])]
                clauses.append(f"_col.isin({json.dumps(vals)})")
            elif alt.get("op") == "between":
                parts = ["_col.notna()"]
                for key, op in (("min", ">="), ("max", "<=")):
                    bound = alt.get(key)
                    if bound is None:
                        continue
                    if kind == "number":
                        num = _finite_number(bound)
                        parts.append("False" if num is None else f"(_col {op} {num!r})")
                    elif kind == "date":
                        b = str(bound)
                        parts.append(f"(_col.str[:{len(b)}] {op} {json.dumps(b)})")
                    else:
                        parts.append(f"(_col {op} {json.dumps(str(bound))})")
                clauses.append("(" + " & ".join(parts) + ")")
        if not clauses:
            continue
        expr = " | ".join(f"({c})" for c in clauses)
        lines.append(
            f"if {col_j} in dataset.columns:\n"
            f"    _col = {series}\n"
            f"    dataset = dataset[{expr}]"
        )
    return "\n".join(lines)


def r_preamble(node: DatasetFile, filters: list[dict] | None = None) -> str:
    """R `dataset` injection for a DB-backed dataset (legacy blob path)."""
    path = blob_store.path_for(node.data_sha).as_posix() if node.data_sha else ""
    return r_preamble_from(path, node.columns or [], filters)


def r_preamble_from(
    path: str, columns: list[dict], filters: list[dict] | None = None, native: bool = False
) -> str:
    """R code that loads a Parquet file at `path` as a `dataset` data.frame.
    Same `filters` / `native` contract as python_preamble_from."""
    filters = _keyed_by_raw_column(filters or [], columns, native)
    # Build named vector for renaming: c("col-1" = "age", ...)
    rename_pairs = ", ".join(
        f"{_r_str(c['id'])} = {_r_str(c['name'])}" for c in columns
    )
    number_cols = _r_char_vector([c["name"] for c in columns if c.get("type") == "number"])
    date_cols = _r_char_vector([c["name"] for c in columns if c.get("type") == "date"])
    read = (
        f"as.data.frame(arrow::read_parquet({_r_str(path)}))" if path else "data.frame()"
    )
    filter_code = _r_filter_code(filters or [])
    return f"""
suppressWarnings(suppressMessages(library(arrow)))
dataset <- {read}
{filter_code}
.rename <- c({rename_pairs})
.have <- intersect(names(.rename), colnames(dataset))
if (length(.have) > 0) names(dataset)[match(.have, colnames(dataset))] <- .rename[.have]
for (.c in {number_cols}) if (.c %in% colnames(dataset)) dataset[[.c]] <- as.numeric(dataset[[.c]])
for (.c in {date_cols}) if (.c %in% colnames(dataset)) dataset[[.c]] <- as.POSIXct(dataset[[.c]], tryFormats = c("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"))
"""


def _r_filter_code(filters: list[dict]) -> str:
    """R code applying resolved filter predicates by columnId (raw parquet column),
    before rename. Same semantics as _python_filter_code."""
    lines: list[str] = []
    for f in filters:
        col = f.get("colId")
        alts = f.get("alternatives") or []
        if not col or not alts:
            continue
        col_r = _r_str(col)
        kind = f.get("kind", "string")
        # R renders logicals "TRUE"/"FALSE"; the UI sends "true"/"false" (see the
        # pandas branch above) — map the literals so boolean filters match.
        if kind == "number":
            series = f"suppressWarnings(as.numeric(dataset[[{col_r}]]))"
        else:
            series = (
                f"if (is.logical(dataset[[{col_r}]])) "
                f"ifelse(dataset[[{col_r}]], 'true', 'false') "
                f"else as.character(dataset[[{col_r}]])"
            )
        clauses: list[str] = []
        for alt in alts:
            if alt.get("op") == "in":
                vals = _r_char_vector([str(v) for v in alt.get("values", [])])
                clauses.append(f"(.col %in% {vals})")
            elif alt.get("op") == "between":
                parts = ["!is.na(.col)"]
                for key, op in (("min", ">="), ("max", "<=")):
                    bound = alt.get(key)
                    if bound is None:
                        continue
                    if kind == "number":
                        num = _finite_number(bound)
                        parts.append("FALSE" if num is None else f"(.col {op} {num!r})")
                    elif kind == "date":
                        b = str(bound)
                        parts.append(f"(substr(.col, 1, {len(b)}) {op} {_r_str(b)})")
                    else:
                        parts.append(f"(.col {op} {_r_str(str(bound))})")
                clauses.append("(" + " & ".join(parts) + ")")
        if not clauses:
            continue
        expr = " | ".join(clauses)
        lines.append(
            f"if ({col_r} %in% colnames(dataset)) {{\n"
            f"  .col <- {series}\n"
            f"  dataset <- dataset[{expr}, , drop = FALSE]\n"
            f"}}"
        )
    return "\n".join(lines)


def _finite_number(value: object) -> float | None:
    """The bound as a float literal safe to splice into code, or None when it is
    not a finite number (the alternative then matches nothing)."""
    if isinstance(value, bool):
        return None
    try:
        num = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return num if math.isfinite(num) else None


def _r_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _r_char_vector(items: list[str]) -> str:
    if not items:
        return "character(0)"
    return "c(" + ", ".join(_r_str(i) for i in items) + ")"
