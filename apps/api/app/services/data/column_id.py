"""Deterministic dataset column ids derived from the column NAME — a faithful
Python port of the frontend's column-id util (apps/web/src/lib/column-id.ts).

A column id is the physical key for row data (the server's Parquet cache and the
client's IndexedDB rows). Deriving it deterministically from the name — instead of
a volatile ``col-<timestamp>-<idx>`` — means the same name yields the same id on
every parse, on the server AND the client, so export→reimport and
fullstack↔client-only stay in lockstep with no id-remapping needed.

Parity matters: keep the slug rules and the collision-suffix scheme in lockstep
with the TS twin, or client and server ids drift and dashboards/filters that key
rows by columnId break. A shared fixture + parity tests guard this.
"""

import re
import unicodedata

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_TRIM_UNDERSCORE = re.compile(r"^_+|_+$")


def _slug_body(name: str) -> str:
    """Normalize a single name into its slug body (no prefix, no collision handling)."""
    decomposed = unicodedata.normalize("NFD", name)
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    base = _NON_ALNUM.sub("_", stripped.lower())
    base = _TRIM_UNDERSCORE.sub("", base)
    return base or "col"


def column_id(name: str) -> str:
    """Column id for a single name. The ``col_`` prefix keeps ids readable,
    guarantees a leading letter, and marks the deterministic scheme (legacy ids are
    ``col-<digits>``, new ids are ``col_<slug>``)."""
    return f"col_{_slug_body(name)}"


def unique_column_id(name: str, taken: set[str]) -> str:
    """Column id for ``name`` unique against ``taken`` (mutated: the chosen id is added)."""
    base = column_id(name)
    cid = base
    n = 2
    while cid in taken:
        cid = f"{base}_{n}"
        n += 1
    taken.add(cid)
    return cid


def build_column_ids(names: list[str]) -> list[str]:
    """Column ids for an ordered list of names, with deterministic collision suffixes
    (``_2``, ``_3``, … in header order) — identical to the TS twin."""
    taken: set[str] = set()
    return [unique_column_id(name, taken) for name in names]
