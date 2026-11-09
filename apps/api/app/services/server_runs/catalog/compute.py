"""The data catalog's planning, as the browser plans it: the tokens of the query
templates filled (`catalog-sql-fill.ts`), the patient slices, the units and how
their rows add into the run state, the crossings planned from the rankings, the
cache a run writes and reads back, the modalities' order, the size estimate's
rankings and rows (`catalog-compute.ts`,
`periodRange` and `addKeys` of lib/data-catalog).

Twins of that TypeScript, held to one golden fixture
(apps/web/src/lib/__fixtures__/catalog-runs/run-spec.json, written by
catalog-run-spec.twin.test.ts) by tests/test_catalog_run_twin.py: a resume reads
a cache either side wrote, so a drift is a resume that counts twice or skips.

Rows are the dicts `db_connect._row_to_json` gives; every number is read as
JavaScript reads it (`js_number`), every string ordered by UTF-16 code units.
"""

import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.schemas.catalog_run import CatalogModalityPlan, CatalogRunSpec
from app.services.server_runs.js_values import (
    UNDEFINED,
    js_code_units,
    js_is_finite,
    js_number,
    js_number_str,
    js_string,
    nullish,
)

SEP = "\u0001"
KEY_SPACE = 2**32
OTHER_MODALITY = "__other__"
SEX_MODALITIES = ("male", "female", "other")
INVALID_RESUME = "Cannot resume this catalog: its saved run state is invalid. Reset the results to compute it again."

# ---------------------------------------------------------------------------
# Template tokens (catalog-sql-fill.ts)
# ---------------------------------------------------------------------------

_TOKEN = re.compile(r"/\*LINKR_([A-Z_]+)(?::([^*]*))?\*/")


def esc_sql(value: str) -> str:
    """`escSql` (lib/format-helpers.ts)."""
    return value.replace("\\", "\\\\").replace("'", "''").replace("\0", "")


def _lit(value) -> str:
    return js_number_str(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else f"'{esc_sql(value)}'"


def _range_lit(value) -> str:
    if isinstance(value, str):
        return _lit(value)
    if js_is_finite(value):
        return js_number_str(js_number(value))
    raise ValueError("A patient range bound must be a number or a string")


def range_condition(column: str, rng: Mapping | None) -> str:
    """`rangeCondition` (catalog-queries.ts)."""
    if not rng:
        return ""
    parts = []
    if rng.get("lo") is not None:
        parts.append(f"{column} >= {_range_lit(rng['lo'])}")
    if rng.get("hi") is not None:
        parts.append(f"{column} < {_range_lit(rng['hi'])}")
    return " AND ".join(parts)


def bound_picks(slices) -> str:
    n = math.floor(slices) if isinstance(slices, (int, float)) and math.isfinite(slices) else None
    if n is None or n < 2:
        raise ValueError("Patient bounds need at least two slices")
    return "\n   OR ".join(
        f"((rn - 1) * {n} < n * {i + 1} AND rn * {n} >= n * {i + 1})" for i in range(n - 1)
    )


def _block_comments(sql: str) -> list[tuple[int, int]]:
    """The block comments outside literals, quoted identifiers and line comments."""
    out = []
    i = 0
    while i < len(sql):
        c = sql[i]
        if c in ("'", '"'):
            close = sql.find(c, i + 1)
            while close >= 0 and close + 1 < len(sql) and sql[close + 1] == c:
                close = sql.find(c, close + 2)
            if close < 0:
                break
            i = close + 1
            continue
        if c == "-" and sql.startswith("-", i + 1):
            nl = sql.find("\n", i)
            if nl < 0:
                break
            i = nl + 1
            continue
        if c == "/" and sql.startswith("*", i + 1):
            close = sql.find("*/", i + 2)
            if close < 0:
                break
            out.append((i, close + 2))
            i = close + 2
            continue
        i += 1
    return out


def _split(arg: str) -> tuple[str, str]:
    """`arg.slice(0, sep)` and `arg.slice(sep + 1)` around the first colon."""
    sep = arg.find(":")
    return (arg[:sep] if sep >= 0 else arg[:-1]), arg[sep + 1:]


def _filled(name: str, arg: str | None, fill: Mapping) -> str | None:
    if name == "RANGE" and arg:
        kind, column = _split(arg)
        condition = range_condition(column, fill.get("range"))
        if kind not in ("WHERE", "AND"):
            return None
        return f" {kind} {condition}" if condition else ""
    if name == "BOUND_PICKS":
        if fill.get("slices") is None:
            raise ValueError("The patient bounds query needs its slice count")
        return bound_picks(fill["slices"])
    if name == "SERVICE_TOP":
        top = fill.get("topServices") or []
        return ", ".join(_lit(s) for s in top) if top else "NULL"
    if name == "CONCEPT_IN" and arg:
        concept_filter = fill.get("conceptFilter")
        if concept_filter is None:
            return ""
        index_text, column = _split(arg)
        index = js_number(index_text)
        dict_keys = fill.get("dictKeys") or []
        dict_key = dict_keys[int(index)] if float(index).is_integer() and 0 <= index < len(dict_keys) else UNDEFINED
        ids = next((f["ids"] for f in concept_filter if f["dictKey"] == dict_key), None)
        # A dictionary with nothing kept counts nothing, rather than its part being cut out.
        return f" AND {column} IN ({', '.join(_lit(i) for i in ids)})" if ids else " AND FALSE"
    return None


def fill_catalog_sql(sql: str, fill: Mapping | None = None) -> str:
    """`fillCatalogSql`: `fill` as the TypeScript `CatalogFill` ({range, slices,
    topServices, conceptFilter, dictKeys})."""
    fill = fill or {}
    out = []
    at = 0
    for start, end in _block_comments(sql):
        m = _TOKEN.fullmatch(sql, start, end)
        value = _filled(m.group(1), m.group(2), fill) if m else None
        if value is None:
            continue
        out.append(sql[at:start])
        out.append(value)
        at = end
    out.append(sql[at:])
    return "".join(out)


# ---------------------------------------------------------------------------
# Run state
# ---------------------------------------------------------------------------


@dataclass
class RunState:
    slices: list[dict] = field(default_factory=lambda: [{}])
    concepts: dict[str, dict] = field(default_factory=dict)
    totals: dict = field(default_factory=lambda: {"totalPatients": 0, "totalVisits": 0, "totalRecords": 0})
    service_rank: dict[str, Any] = field(default_factory=dict)
    concept_rank: dict[str, dict] = field(default_factory=dict)
    # id → {"variables": [...], "cells": {key: row}}
    crossings: dict[str, dict] = field(default_factory=dict)


def add_keys(a, b):
    """`addKeys` (perturbation.ts)."""
    if a is None or b is None:
        return b if a is None else a
    return (a + b) % KEY_SPACE


def _set_key(row: dict, name: str, value) -> None:
    if value is None:
        row.pop(name, None)
    else:
        row[name] = value


def concept_key(row: Mapping) -> str:
    return f"{js_string(nullish(row.get('dictionaryKey'), ''))}{SEP}{js_string(row.get('conceptId', UNDEFINED))}"


def _cell_key(values: Sequence) -> str:
    return SEP.join("" if v is None else js_string(v) for v in values)


def merge_cells(into: dict[str, dict], rows: Sequence[Mapping]) -> None:
    for row in rows:
        key = _cell_key(row["values"])
        prev = into.get(key)
        if prev is None:
            into[key] = dict(row)
            continue
        prev["patients"] += row["patients"]
        for name in ("stays", "unitStays", "records"):
            if row.get(name) is not None:
                prev[name] = nullish(prev.get(name), 0) + row[name]
        _set_key(prev, "key", add_keys(prev.get("key"), row.get("key")))


def _is_count(v) -> bool:
    return js_is_finite(v)


def _is_bound(v) -> bool:
    return v is None or isinstance(v, str) or js_is_finite(v)


def check_resume_state(cache: Mapping) -> None:
    work = cache.get("work")
    steps = cache.get("completedSteps")

    def slice_ok(s) -> bool:
        if isinstance(s, list):
            return True
        return isinstance(s, dict) and _is_bound(s.get("lo")) and _is_bound(s.get("hi"))

    def rows_ok(rows, width: int) -> bool:
        return isinstance(rows, list) and all(
            isinstance(r, list) and len(r) >= 1 and isinstance(r[0], str)
            and all(_is_count(r[i] if i < len(r) else UNDEFINED) for i in range(1, width))
            for r in rows
        )

    valid = (
        (steps is None or (js_is_finite(steps) and float(steps).is_integer() and steps >= 0))
        and (work is None or work.get("slices") is None or (isinstance(work["slices"], list) and all(slice_ok(s) for s in work["slices"])))
        and (work is None or work.get("services") is None or rows_ok(work["services"], 2))
        and (work is None or work.get("concepts") is None or rows_ok(work["concepts"], 3))
    )
    if not valid:
        raise ValueError(INVALID_RESUME)


def state_from_cache(cache: Mapping) -> RunState:
    check_resume_state(cache)
    st = RunState()
    work = cache.get("work") or {}
    if work.get("slices") is not None:
        st.slices = [
            {k: s[k] for k in ("lo", "hi") if isinstance(s, dict) and s.get(k) is not None}
            for s in work["slices"]
        ]
    for r in cache.get("concepts") or []:
        st.concepts[concept_key(r)] = dict(r)
    st.totals = dict(cache.get("grandTotal") or {})
    for name, patients, *_ in work.get("services") or []:
        st.service_rank[name] = patients
    for key, patients, records, *_ in work.get("concepts") or []:
        st.concept_rank[key] = {"patients": patients, "records": records}
    for c in cache.get("crossings") or []:
        cells: dict[str, dict] = {}
        merge_cells(cells, c["rows"])
        st.crossings[c["id"]] = {"variables": c["variables"], "cells": cells}
    return st


def crossing_id(variables: Sequence[str]) -> str:
    """`crossingId`: the plan's crossings are already canonical."""
    return "-".join(variables)


def cache_from_state(base: Mapping, st: RunState, order: Sequence[Sequence[str]], completed_steps: int) -> dict:
    concepts = list(st.concepts.values())
    crossings = []
    for variables in order:
        c = st.crossings.get(crossing_id(variables))
        if c is not None:
            crossings.append({"id": crossing_id(variables), "variables": c["variables"], "rows": list(c["cells"].values())})
    return {
        "modalities": {},
        **{k: v for k, v in base.items() if v is not None},
        "concepts": concepts,
        "grandTotal": st.totals,
        "totalConcepts": len(concepts),
        "totalPatients": st.totals.get("totalPatients"),
        "totalVisits": st.totals.get("totalVisits"),
        "crossings": crossings,
        "completedSteps": completed_steps,
        "work": {
            "slices": st.slices,
            "services": [[k, v] for k, v in st.service_rank.items()],
            "concepts": [[k, v["patients"], v["records"]] for k, v in st.concept_rank.items()],
        },
    }


# ---------------------------------------------------------------------------
# Sizing
# ---------------------------------------------------------------------------


def _serialize_bound(value):
    if isinstance(value, bool):
        return js_string(value)
    if isinstance(value, int):
        return value if abs(value) <= 2**53 - 1 else str(value)
    if isinstance(value, float):
        return value
    return js_string(value)


def slices_wanted(size_rows: Sequence[Mapping], slice_rows: int, max_slices: int) -> int:
    event_rows = js_number(nullish((size_rows[0] if size_rows else {}).get("event_rows"), 0))
    ratio = event_rows / slice_rows
    return min(max_slices, math.ceil(ratio)) if math.isfinite(ratio) else max_slices if ratio > 0 else 0


def slices_from_bounds(bound_rows: Sequence[Mapping]) -> list[dict]:
    bounds = [_serialize_bound(r.get("b")) for r in bound_rows]
    if not bounds:
        return [{}]
    out = []
    for i, hi in enumerate([*bounds, None]):
        s = {}
        if i > 0:
            s["lo"] = bounds[i - 1]
        if hi is not None:
            s["hi"] = hi
        out.append(s)
    return out


# ---------------------------------------------------------------------------
# Units
# ---------------------------------------------------------------------------


@dataclass
class Unit:
    info: dict
    sql: str | None
    apply: Callable[[RunState, Sequence[Mapping]], None]


def _slice_of(slices: Sequence, i: int) -> list[int] | None:
    return [i + 1, len(slices)] if len(slices) > 1 else None


def _range_of(s: Mapping) -> Mapping | None:
    return None if s.get("lo") is None and s.get("hi") is None else s


def _info(**values) -> dict:
    """A unit's info as the TypeScript writes it: an undefined field left out."""
    return {k: v for k, v in values.items() if v is not None}


def _num(row: Mapping, name: str):
    return js_number(nullish(row.get(name), 0))


def base_units(spec: CatalogRunSpec, slices: Sequence[Mapping]) -> list[Unit]:
    cfg = spec.concept
    units: list[Unit] = []

    def concept_rows(st: RunState, rows: Sequence[Mapping]) -> None:
        for row in rows:
            r = {
                "conceptId": row.get("concept_id"),
                "conceptName": row.get("concept_name"),
                "dictionaryKey": row.get("dictionary_key"),
            }
            if cfg is not None and cfg.category_column:
                r["category"] = row.get("concept_category")
            if cfg is not None and cfg.subcategory_column:
                r["subcategory"] = row.get("concept_subcategory")
            r["patientCount"] = _num(row, "patient_count")
            r["recordCount"] = _num(row, "record_count")
            if spec.visits:
                r["visitCount"] = _num(row, "visit_count")
            if row.get("patient_key") is not None:
                r["patientKey"] = js_number(row["patient_key"])
            key = concept_key(r)
            prev = st.concepts.get(key)
            if prev is None:
                st.concepts[key] = r
                continue
            prev["patientCount"] += r["patientCount"]
            prev["recordCount"] += r["recordCount"]
            if r.get("visitCount") is not None:
                prev["visitCount"] = nullish(prev.get("visitCount"), 0) + r["visitCount"]
            _set_key(prev, "patientKey", add_keys(prev.get("patientKey"), r.get("patientKey")))

    def totals(st: RunState, rows: Sequence[Mapping]) -> None:
        row = rows[0] if rows else {}
        t = st.totals
        t["totalPatients"] += _num(row, "total_patients")
        t["totalVisits"] += _num(row, "total_visits")
        t["totalRecords"] += _num(row, "total_records")
        if row.get("total_unit_stays") is not None:
            t["totalUnitStays"] = nullish(t.get("totalUnitStays"), 0) + js_number(row["total_unit_stays"])
        if row.get("total_key") is not None:
            _set_key(t, "totalKey", add_keys(t.get("totalKey"), js_number(row["total_key"])))

    def service_rank(st: RunState, rows: Sequence[Mapping]) -> None:
        for r in rows:
            name = js_string(r.get("svc", UNDEFINED))
            st.service_rank[name] = nullish(st.service_rank.get(name), 0) + _num(r, "patients")

    def concept_rank(st: RunState, rows: Sequence[Mapping]) -> None:
        for r in rows:
            key = js_string(r.get("concept", UNDEFINED))
            prev = st.concept_rank.get(key) or {"patients": 0, "records": 0}
            st.concept_rank[key] = {"patients": prev["patients"] + _num(r, "patients"), "records": prev["records"] + _num(r, "records")}

    for i, s in enumerate(slices):
        for q in spec.concept_counts:
            units.append(Unit(
                _info(step="concepts", dictionary=q.dict_key, slice=_slice_of(slices, i)),
                fill_catalog_sql(q.sql, {"range": _range_of(s)}),
                concept_rows,
            ))
    for i, s in enumerate(slices):
        units.append(Unit(
            _info(step="totals", slice=_slice_of(slices, i)), fill_catalog_sql(spec.totals_sql, {"range": _range_of(s)}), totals,
        ))
    if spec.service_rank_sql:
        for i, s in enumerate(slices):
            units.append(Unit(
                _info(step="ranking", ranked="service", slice=_slice_of(slices, i)),
                fill_catalog_sql(spec.service_rank_sql, {"range": _range_of(s)}),
                service_rank,
            ))
    if spec.concept_rank_sql:
        for i, s in enumerate(slices):
            units.append(Unit(
                _info(step="ranking", ranked="concept", slice=_slice_of(slices, i)),
                fill_catalog_sql(spec.concept_rank_sql, {"range": _range_of(s)}),
                concept_rank,
            ))
    return units


def concept_filter_of(modalities: Sequence[str], dict_keys: Sequence[str]) -> list[dict]:
    """Concept modality → (dictionary, id), the inverse of the SQL's modality expression."""
    multi = len(dict_keys) > 1
    by_dict: dict = {}
    for m in modalities:
        if multi:
            dict_key, _, ident = m.partition(":")
            if ":" not in m:
                dict_key, ident = m[:-1], m
        else:
            dict_key, ident = (dict_keys[0] if dict_keys else UNDEFINED), m
        by_dict.setdefault(dict_key, []).append(ident)
    return [{"dictKey": k, "ids": ids} for k, ids in by_dict.items()]


def by_count_then_name(entries: Sequence[tuple[str, Any]], count: Callable[[Any], Any]) -> list[tuple[str, Any]]:
    return sorted(entries, key=lambda e: (-count(e[1]), js_code_units(e[0])))


def _crossing_row(variables: Sequence[str], r: Mapping) -> dict:
    row = {"values": [js_string(r.get(f"v_{v}", UNDEFINED)) for v in variables], "patients": _num(r, "patients")}
    for column, name in (("records", "records"), ("stays", "stays"), ("unit_stays", "unitStays"), ("cell_key", "key")):
        if r.get(column) is not None:
            row[name] = js_number(r[column])
    return row


@dataclass
class CrossingPlan:
    fill: dict
    crossings: list[list[str]]
    units: list[Unit]
    labels: dict | None


def plan_crossings(spec: CatalogRunSpec, st: RunState) -> CrossingPlan:
    service = spec.service
    top_services = (
        [name for name, _ in by_count_then_name(list(st.service_rank.items()), lambda p: p)[: max(0, service.top_n)]]
        if service is not None and service.grouping == "top" else []
    )
    concept = spec.concept
    dict_keys = spec.dict_keys
    ranked = by_count_then_name(list(st.concept_rank.items()), lambda v: v["patients"])
    keeps_top = concept is not None and concept.level == "concept" and concept.scope == "top"
    kept = ranked[: max(0, concept.top_n)] if keeps_top else ranked
    concept_rows = [{"values": [key], "patients": v["patients"], "records": v["records"]} for key, v in kept]
    concept_filter = concept_filter_of([r["values"][0] for r in concept_rows], dict_keys) if keeps_top else None

    fill = {"topServices": top_services, "conceptFilter": concept_filter, "dictKeys": dict_keys}
    slices = st.slices
    chunk_size = spec.concept_chunk
    units: list[Unit] = []

    def marginal(cid: str, variables: list[str]):
        def apply(s: RunState, rows: Sequence[Mapping]) -> None:
            s.crossings[cid] = {"variables": variables, "cells": {_cell_key(r["values"]): dict(r) for r in concept_rows}}
        return apply

    def merge(cid: str, variables: list[str]):
        def apply(s: RunState, rows: Sequence[Mapping]) -> None:
            entry = s.crossings.get(cid) or {"variables": variables, "cells": {}}
            merge_cells(entry["cells"], [_crossing_row(variables, r) for r in rows])
            s.crossings[cid] = entry
        return apply

    for crossing in spec.crossings:
        variables = list(crossing.variables)
        cid = crossing_id(variables)
        if cid == "concept":
            units.append(Unit(_info(step="crossings", crossing=variables), None, marginal(cid, variables)))
            continue
        if "concept" in variables and concept is not None and concept.level == "concept" and len(concept_rows) > chunk_size:
            chunks = [
                concept_filter_of([r["values"][0] for r in concept_rows[i:i + chunk_size]], dict_keys)
                for i in range(0, len(concept_rows), chunk_size)
            ]
        else:
            chunks = [None]
        for c, chunk in enumerate(chunks):
            for i, s in enumerate(slices):
                sql = None if crossing.sql is None else fill_catalog_sql(
                    crossing.sql, {**fill, "conceptFilter": chunk if chunk is not None else concept_filter, "range": _range_of(s)},
                )
                units.append(Unit(
                    _info(step="crossings", crossing=variables,
                          chunk=[c + 1, len(chunks)] if len(chunks) > 1 else None, slice=_slice_of(slices, i)),
                    sql, merge(cid, variables),
                ))

    labels = None
    if any("concept" in c.variables for c in spec.crossings) and concept is not None and concept.level == "concept" and st.concepts:
        multi = len(dict_keys) > 1
        in_scope = {r["values"][0] for r in concept_rows}
        names = {}
        for c in st.concepts.values():
            key = (
                f"{js_string(c.get('dictionaryKey', UNDEFINED))}:{js_string(c.get('conceptId', UNDEFINED))}"
                if multi else js_string(c.get("conceptId", UNDEFINED))
            )
            if key in in_scope:
                names[key] = c.get("conceptName")
        labels = {"concept": names}

    return CrossingPlan(fill, [list(c.variables) for c in spec.crossings], units, labels)


def estimate_ranking_units(spec: CatalogRunSpec) -> list[Unit]:
    """`estimateRankingUnits`: the rankings over the whole warehouse."""
    return [u for u in base_units(spec, [{}]) if u.info["step"] == "ranking"]


def estimate_of_rows(rows: Sequence[Mapping]) -> dict:
    """`estimateOfRow`."""
    row = rows[0] if rows else {}
    return {
        "cells": _num(row, "cells"),
        "published": _num(row, "published"),
        "mass": _num(row, "mass"),
        "publishedMass": _num(row, "published_mass"),
    }


def step_counts(units: Sequence[Unit], offset: int, base: Mapping | None = None) -> dict:
    """Units done and planned per step (`stepCounts` of catalog-run.ts)."""
    steps = {k: dict(v) for k, v in (base or {}).items()}
    for i, u in enumerate(units):
        s = steps.get(u.info["step"]) or {"done": 0, "total": 0}
        steps[u.info["step"]] = {"done": s["done"] + (1 if i < offset else 0), "total": (s["total"] or 0) + 1}
    return steps


# ---------------------------------------------------------------------------
# Modalities
# ---------------------------------------------------------------------------


def _js_parse_int(text: str) -> int | None:
    m = re.match(r"[ \t\n\r\f\v]*([+-]?[0-9]+)", text)
    return int(m.group(1)) if m else None


def _js_rem(a: int, b: int) -> int:
    """`a % b`: the sign of the dividend."""
    return int(math.fmod(a, b))


def period_range(first: str, last: str, granularity: str, step: float = 1) -> list[str]:
    """`periodRange` (lib/data-catalog/config.ts)."""

    def parse(v: str) -> int | None:
        y = _js_parse_int(v[:4])
        if y is None:
            return None
        if granularity == "year":
            return y
        if granularity == "quarter":
            q = _js_parse_int(v[6:])
            return None if q is None else y * 4 + (q - 1)
        m = _js_parse_int(v[5:7])
        return None if m is None else y * 12 + (m - 1)

    def fmt(n: int) -> str:
        if granularity == "year":
            return str(n)
        if granularity == "quarter":
            return f"{math.floor(n / 4)}-Q{_js_rem(n, 4) + 1}"
        return f"{math.floor(n / 12)}-{str(_js_rem(n, 12) + 1).rjust(2, '0')}"

    a, b = parse(first), parse(last)
    if a is None or b is None or b < a:
        return []
    every = max(1, math.floor(step))
    return [fmt(n) for n in range(a, b + 1, every)]


def order_modalities(modalities: CatalogModalityPlan, crossings: Sequence[Mapping]) -> dict:
    def marginal(v: str) -> list[dict]:
        return next((c["rows"] for c in crossings if c["id"] == v), [])

    def by_patients(v: str) -> list[str]:
        rows = sorted(marginal(v), key=lambda r: (r["values"][0] == OTHER_MODALITY, -r["patients"], js_code_units(r["values"][0])))
        return [r["values"][0] for r in rows]

    out: dict = {}
    if modalities.age is not None:
        out["age"] = list(modalities.age)
    if modalities.sex:
        present = {r["values"][0] for r in marginal("sex")}
        out["sex"] = [s for s in SEX_MODALITIES if s != "other" or s in present]
    if modalities.period is not None:
        periods = sorted((r["values"][0] for r in marginal("period")), key=js_code_units)
        out["period"] = (
            period_range(periods[0], periods[-1], modalities.period.granularity, modalities.period.step) if periods else []
        )
    if modalities.service:
        out["service"] = by_patients("service")
    if modalities.concept:
        out["concept"] = by_patients("concept")
    return out
