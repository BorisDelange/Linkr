"""Build the server-side dataset-injection preamble for an execution run.

The browser's analysis-executor injects a ``dataset`` DataFrame from the rows it
holds in memory. Server-side we never ship rows to the browser — instead we read
the dataset's Parquet blob directly into the kernel and expose the same
``dataset`` variable, with columns renamed from columnId to their display name
and typed like the client (number -> numeric, date -> datetime). Parity with
apps/web/src/features/projects/lab/datasets/analysis-executor.ts.
"""

import json

from app.models.dataset import DatasetFile
from app.services import blob_store


def python_preamble(node: DatasetFile) -> str:
    """Python code that loads the dataset's Parquet as a `dataset` DataFrame."""
    path = blob_store.path_for(node.data_sha).as_posix() if node.data_sha else ""
    columns = node.columns or []
    rename = {c["id"]: c["name"] for c in columns}
    number_cols = [c["name"] for c in columns if c.get("type") == "number"]
    date_cols = [c["name"] for c in columns if c.get("type") == "date"]
    read = (
        f"_pd.read_parquet({json.dumps(path)})" if path else "_pd.DataFrame()"
    )
    return f"""
import pandas as _pd
dataset = {read}
dataset = dataset.rename(columns={json.dumps(rename)})
for _linkr_c in {json.dumps(number_cols)}:
    if _linkr_c in dataset.columns:
        dataset[_linkr_c] = _pd.to_numeric(dataset[_linkr_c], errors="coerce")
for _linkr_c in {json.dumps(date_cols)}:
    if _linkr_c in dataset.columns:
        dataset[_linkr_c] = _pd.to_datetime(dataset[_linkr_c], errors="coerce")
"""


def r_preamble(node: DatasetFile) -> str:
    """R code that loads the dataset's Parquet as a `dataset` data.frame."""
    path = blob_store.path_for(node.data_sha).as_posix() if node.data_sha else ""
    columns = node.columns or []
    # Build named vector for renaming: c("col-1" = "age", ...)
    rename_pairs = ", ".join(
        f"{_r_str(c['id'])} = {_r_str(c['name'])}" for c in columns
    )
    number_cols = _r_char_vector([c["name"] for c in columns if c.get("type") == "number"])
    date_cols = _r_char_vector([c["name"] for c in columns if c.get("type") == "date"])
    read = (
        f"as.data.frame(arrow::read_parquet({_r_str(path)}))" if path else "data.frame()"
    )
    return f"""
suppressMessages(library(arrow))
dataset <- {read}
.rename <- c({rename_pairs})
.have <- intersect(names(.rename), colnames(dataset))
if (length(.have) > 0) names(dataset)[match(.have, colnames(dataset))] <- .rename[.have]
for (.c in {number_cols}) if (.c %in% colnames(dataset)) dataset[[.c]] <- as.numeric(dataset[[.c]])
for (.c in {date_cols}) if (.c %in% colnames(dataset)) dataset[[.c]] <- as.POSIXct(dataset[[.c]], tryFormats = c("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"))
"""


def _r_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _r_char_vector(items: list[str]) -> str:
    if not items:
        return "character(0)"
    return "c(" + ", ".join(_r_str(i) for i in items) + ")"
