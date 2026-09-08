"""Dataset edit operations — a faithful Python port of the frontend's ops engine
(packages/linkr-format/src/dataset-ops.ts).

A dataset's raw file on disk is immutable (see dataset_fs's module docstring).
Edits are recorded as an ordered log of operations, and the materialised form is
derived:

    raw -> parse(parseOptions) -> replay(ops) -> parquet cache

The client replays to render, the server replays to build that cache. Parity
matters: a drift means the two disagree about what the dataset *contains*, and
both sides look internally consistent while doing so. A shared fixture
(apps/web/src/lib/dataset-ops.fixture.json) + parity tests guard this.
"""

import json

# Stable row identity. Row position cannot be the key: ops are recorded against a
# sorted, filtered, paginated view, and in server mode the client never sees the
# full order. The raw file's ordinal works precisely because the raw is immutable.
# Rows added by an op take NEGATIVE ordinals, a space disjoint from raw ordinals by
# construction, so an added row can never collide with a raw one.
ROW_ORD = "__row_ord"

# Key order for the canonical form. The sidecar is written verbatim by both the TS
# and Python export builders, so insertion order would otherwise depend on write
# history and churn the git diff — the same reason parseOptions is canonicalised.
_OP_KEY_ORDER = (
    "id", "type", "at", "by", "group",
    "row", "column", "value", "prev", "values", "after", "order",
    "name", "colType", "index", "to", "toName",
)

# Keys whose explicit null is meaningful: a cleared cell and a cell that was empty
# before the edit are both `null`, and dropping them would lose the distinction
# with "field absent" that undo relies on.
_NULLABLE_KEYS = ("value", "prev", "after")


def replay_ops(columns: list[dict], rows: list[dict], ops: list[dict]) -> tuple[list[dict], list[dict]]:
    """Apply ``ops`` in order to a parsed dataset; return (columns, rows).

    Rows are keyed by ``ROW_ORD``, assigned here when absent: the input is the
    freshly parsed raw file, so its ordinals are its positions. The output carries
    ``ROW_ORD`` on every row, so a later replay of appended ops addresses the same
    rows.

    Unknown op types and ops naming a missing row/column are skipped rather than
    raising: a log outlives the schema it was written against (a reimport can drop
    a column), and one stale op must not make a dataset unreadable.
    """
    columns = [dict(c) for c in columns]
    rows = [{**r, ROW_ORD: r.get(ROW_ORD, i)} for i, r in enumerate(rows)]

    for op in ops:
        kind = op.get("type")
        if kind == "setCell":
            _set_cell(columns, rows, op)
        elif kind == "addRow":
            _add_row(columns, rows, op)
        elif kind == "removeRow":
            _remove_row(rows, op)
        elif kind == "reorderRows":
            _apply_reorder(rows, op.get("order") or [], lambda r: r[ROW_ORD])
        elif kind == "addColumn":
            _add_column(columns, rows, op)
        elif kind == "removeColumn":
            _remove_column(columns, rows, op)
        elif kind == "reorderColumns":
            _apply_reorder(columns, op.get("order") or [], lambda c: c["id"])
            _renumber(columns)
        elif kind == "renameColumn":
            _rename_column(columns, rows, op)

    return columns, rows


def _row_at(rows: list[dict], ord_: object) -> dict | None:
    return next((r for r in rows if r[ROW_ORD] == ord_), None)


def _set_cell(columns: list[dict], rows: list[dict], op: dict) -> None:
    row = _row_at(rows, op.get("row"))
    if row is not None and any(c["id"] == op.get("column") for c in columns):
        row[op["column"]] = op.get("value")


def _add_row(columns: list[dict], rows: list[dict], op: dict) -> None:
    ord_ = op.get("row")
    if _row_at(rows, ord_) is not None:
        return
    values = op.get("values") or {}
    row = {ROW_ORD: ord_}
    for col in columns:
        row[col["id"]] = values.get(col["id"])
    after = op.get("after")
    at = -1 if after is None else next(
        (i for i, r in enumerate(rows) if r[ROW_ORD] == after), -1
    )
    if at < 0:
        rows.append(row)
    else:
        rows.insert(at + 1, row)


def _remove_row(rows: list[dict], op: dict) -> None:
    at = next((i for i, r in enumerate(rows) if r[ROW_ORD] == op.get("row")), -1)
    if at >= 0:
        rows.pop(at)


def _add_column(columns: list[dict], rows: list[dict], op: dict) -> None:
    col_id = op.get("column")
    if any(c["id"] == col_id for c in columns):
        return
    index = op.get("index")
    at = len(columns) if index is None else max(0, min(int(index), len(columns)))
    columns.insert(at, {
        "id": col_id, "name": op.get("name"), "type": op.get("colType"), "order": at,
    })
    _renumber(columns)
    for row in rows:
        row[col_id] = None


def _remove_column(columns: list[dict], rows: list[dict], op: dict) -> None:
    col_id = op.get("column")
    at = next((i for i, c in enumerate(columns) if c["id"] == col_id), -1)
    if at < 0:
        return
    columns.pop(at)
    _renumber(columns)
    for row in rows:
        row.pop(col_id, None)


def _rename_column(columns: list[dict], rows: list[dict], op: dict) -> None:
    col_id, to = op.get("column"), op.get("to")
    col = next((c for c in columns if c["id"] == col_id), None)
    if col is None or any(c["id"] == to for c in columns):
        return
    col["id"] = to
    col["name"] = op.get("toName")
    for row in rows:
        row[to] = row.pop(col_id, None)


def _apply_reorder(items: list, order: list, key_of) -> None:
    """Reorder ``items`` so the members named in ``order`` appear in that sequence,
    at the positions those members currently occupy. Items not named keep their
    slots, so a partial order (dragging one column) leaves the rest untouched."""
    named = set(order)
    slots = [i for i, item in enumerate(items) if key_of(item) in named]
    by_key = {key_of(item): item for item in items}
    moved = [by_key[k] for k in order if k in by_key]
    for i, slot in enumerate(slots):
        if i < len(moved):
            items[slot] = moved[i]


def _renumber(columns: list[dict]) -> None:
    for i, col in enumerate(columns):
        col["order"] = i


def canonical_op(op: dict) -> dict:
    """An op with its keys in a fixed order and its absent fields dropped."""
    out: dict = {}
    for key in _OP_KEY_ORDER:
        if key not in op or op[key] is None and key not in _NULLABLE_KEYS:
            continue
        value = op[key]
        if key == "values":
            out[key] = {k: value[k] for k in sorted(value)}
        # A removeColumn's `prev` nests a cell map, whose insertion order follows
        # the row scan; sort it too or the diff churns for no change in meaning.
        elif key == "prev" and isinstance(value, dict) and "cells" in value:
            out[key] = {**value, "cells": {k: value["cells"][k] for k in sorted(value["cells"])}}
        else:
            out[key] = value
    return out


def canonical_ops(ops: list[dict]) -> list[dict]:
    return [canonical_op(op) for op in ops]


def ops_hash(ops: list[dict]) -> str:
    """A stable digest of the log, used to invalidate the Parquet cache: the cache
    is raw -> parse -> replay, so it goes stale when the raw changes (already
    covered by its (mtime, size) signature) *or* when the log does.

    FNV-1a over the canonical JSON — this only ever compares against itself, so a
    short non-cryptographic digest is the right tool. Must match the TS twin.
    """
    payload = json.dumps(canonical_ops(ops), separators=(",", ":"), ensure_ascii=False)
    digest = 0x811C9DC5
    for ch in payload:
        digest ^= ord(ch) & 0xFF
        digest = (digest * 0x01000193) & 0xFFFFFFFF
    return f"{digest:08x}"
