"""The disclosure audit of a published data catalog — the twin of `auditPublished`
(apps/web src/lib/data-catalog/audit.ts, where the method is explained), checked
against it by tests/test_catalog_audit_twin.py.

Which examples a finding keeps and in what order the unknowns come follow the
insertion order of the TypeScript's Sets and Maps: dicts stand for them here,
never a `set` that is iterated.

`Audit` solves one independent system at a time (`solve`), so the run can keep
where it is (`checkpoint`) and go on from there; `child_main` is the process the
run computes it in.
"""

import math
import time
from dataclasses import dataclass
from itertools import product
from multiprocessing.connection import Connection

from app.services.server_runs.js_values import js_code_units, js_number, js_string

# CATALOG_VARIABLE_ORDER of apps/web src/types/catalog.ts: the findings sort by it.
VARIABLE_ORDER = ("concept", "period", "service", "age", "sex")

ADDS = {
    "visit": {"patients": ("sex",), "stays": ("period", "age", "sex"), "unit_stays": ("period", "age", "sex")},
    "event": {"patients": ("sex",), "stays": ("sex",), "records": ("period", "age", "sex", "concept")},
}
BOUNDS = {
    "visit": (("patients", "stays"),),
    "event": (("patients", "records"), ("stays", "records")),
}

EXAMPLES = 20
ROUNDS = 40
PUBLISHED = 0
CONCEPT_LIST = "concept-list"
UNLISTED = "…"
NO_GROUP = -1
NO_GROUP_NAME = "—"
INF = math.inf


@dataclass
class Table:
    id: str
    vars: list[str]
    measures: list[str]
    cells: dict[str, list]
    # The concept list at category level: concepts per category (indices into
    # `names`, None for those the list leaves out), cells keyed `category:concept`.
    of: dict[int, list[int]] | None = None
    names: list[str | None] | None = None


def _nth(values, i: int):
    """`values?.[i]`: a negative or missing index reads nothing, as in JavaScript."""
    return values[i] if values is not None and 0 <= i < len(values) else None


def _index_of(values: list, value) -> int:
    try:
        return values.index(value)
    except ValueError:
        return -1


def _join(values) -> str:
    """`values.join(',')`."""
    return ",".join(str(v) if type(v) is int else js_string([v]) for v in values)


def _number(text: str) -> float:
    """`Number(text)`, an integral one as an `int`: it prints as JavaScript's does."""
    n = js_number(text)
    return int(n) if math.isfinite(n) and n == int(n) else n


def _array_index(text: str) -> int | None:
    """`Number(text)` as an array index: None where JavaScript's would read nothing."""
    n = _number(text)
    return n if isinstance(n, int) else None


def _fact(vars_: list[str]) -> str:
    return "event" if "concept" in vars_ else "visit"


def tables_of(inp: dict) -> dict[str, Table]:
    tables: dict[str, Table] = {}
    for c in inp["published"]["crossings"]:
        k = len(c["vars"])
        measures = ["patients", *c["measures"]]
        cells: dict[str, list] = {}
        for cell in c["cells"]:
            if cell[-1] != PUBLISHED:
                continue
            cells[_join(cell[:k])] = cell[k:k + len(measures)]
        tables["-".join(c["vars"])] = Table(c["id"], list(c["vars"]), measures, cells)
    concept = inp["published"]["variables"].get("concept")
    concepts = inp["concepts"]
    if not concept or not concepts:
        return tables
    index = {m: i for i, m in enumerate(concept["mods"])}
    with_stays = any(c.get("stays") is not None for c in concepts)
    measures = ["patients", "stays", "records"] if with_stays else ["patients", "records"]

    def values_of(c: dict) -> list:
        return [c.get("patients"), c.get("stays"), c.get("records")] if with_stays else [c.get("patients"), c.get("records")]

    cells = {}
    if (concept.get("level") or "concept") == "concept":
        if "concept" in tables:
            return tables
        for c in concepts:
            i = index.get(c["key"])
            if i is not None and c.get("records") is not None:
                cells[str(i)] = values_of(c)
        tables["concept"] = Table("concept", ["concept"], measures, cells)
        return tables
    of: dict[int, list[int]] = {}
    names: list[str | None] = []

    def add(g: int, name: str | None) -> int:
        names.append(name)
        m = len(names) - 1
        of.setdefault(g, []).append(m)
        return m

    for c in concepts:
        g = NO_GROUP if c.get("group") is None else index.get(c["group"])
        if g is None:
            continue
        m = add(g, c["name"] if c.get("name") is not None else c["key"])
        if c.get("records") is not None:
            cells[f"{g}:{m}"] = values_of(c)
    if inp.get("hidesMasked"):
        for g in range(NO_GROUP, len(concept["mods"])):
            add(g, None)
    tables[CONCEPT_LIST] = Table(CONCEPT_LIST, ["concept"], measures, cells, of, names)
    return tables


# An equation: (terms [(coef, unknown)], cLo, cHi) for Σ coef·x + c = 0, c within [cLo, cHi].
Equation = tuple[list[tuple[int, str]], float, float]


def _exists(x: str) -> Equation:
    return ([(1, x)], -INF, -1)


def equations_of(tables: dict[str, Table], inp: dict, concept: int | None) -> list[Equation]:
    noise = inp["noise"]
    totals = inp["totals"]
    variables = inp["published"]["variables"]

    def size(v: str) -> int:
        var = variables.get(v)
        return len(var["mods"]) if var else 0

    grand = {"patients": totals.get("patients"), "stays": totals.get("stays"), "unit_stays": totals.get("unitStays")}
    eqs: list[Equation] = []
    if concept is None:
        eqs.extend(grand_record_equations(tables, inp))
    for t in tables.values():
        if t.of is not None:
            if concept is not None:
                eqs.extend(member_equations(t, tables.get("concept"), concept, noise))
            continue
        if (concept is None) != ("concept" not in t.vars):
            continue
        fact = _fact(t.vars)
        n = len(t.vars)
        for mi, m in enumerate(t.measures):
            adds = ADDS[fact].get(m, ())
            for subset in range(1, 1 << n):
                across = [v for p, v in enumerate(t.vars) if subset & (1 << p)]
                if "concept" in across or not all(v in adds for v in across):
                    continue
                kept = [v for p, v in enumerate(t.vars) if not subset & (1 << p)]
                margin = tables.get("-".join(kept)) if kept else None
                margin_measure = _index_of(margin.measures, m) if margin else -1
                if kept and (not margin or margin_measure < 0):
                    continue
                if not kept and (fact == "event" or grand.get(m) is None):
                    continue
                kept_spaces = [1 if v == "concept" else size(v) for v in kept]
                across_spaces = [size(v) for v in across]
                for s in product(*map(range, kept_spaces)):
                    at = {v: (concept if v == "concept" else s[i]) for i, v in enumerate(kept)}
                    terms: list[tuple[int, str]] = []
                    c = 0
                    published = 0
                    for d in product(*map(range, across_spaces)):
                        for i, v in enumerate(across):
                            at[v] = d[i]
                        key = ",".join(str(at[v]) for v in t.vars)
                        value = _nth(t.cells.get(key), mi)
                        if value is None:
                            terms.append((1, f"{t.id}|{key}|{m}"))
                        else:
                            c += value
                            published += 1
                    if margin:
                        key = ",".join(str(at[v]) for v in kept)
                        value = _nth(margin.cells.get(key), margin_measure)
                        if value is None:
                            terms.append((-1, f"{margin.id}|{key}|{m}"))
                        else:
                            c -= value
                            published += 1
                    else:
                        c -= grand[m]
                        published += 1
                    if terms:
                        eqs.append((terms, c - noise * published, c + noise * published))
    return eqs


def member_equations(t: Table, margin: Table | None, g: int, noise) -> list[Equation]:
    eqs: list[Equation] = []
    of = t.of.get(g, [])
    for mi, m in enumerate(t.measures):
        if "concept" not in ADDS["event"].get(m, ()):
            continue
        margin_measure = _index_of(margin.measures, m) if margin else -1
        total = _nth(margin.cells.get(str(g)), margin_measure) if margin_measure >= 0 else None
        if total is None:
            continue
        terms: list[tuple[int, str]] = []
        c = -total
        published = 1
        for member in of:
            value = _nth(t.cells.get(f"{g}:{member}"), mi)
            x = f"{t.id}|{g}:{member}|{m}"
            if value is not None:
                c += value
                published += 1
            else:
                terms.append((1, x))
                if t.names[member] is not None:
                    eqs.append(_exists(x))
        if terms:
            eqs.append((terms, c - noise * published, c + noise * published))
    return eqs


def grand_record_equations(tables: dict[str, Table], inp: dict) -> list[Equation]:
    concept = inp["published"]["variables"].get("concept")
    margin = tables.get("concept")
    mi = _index_of(margin.measures, "records") if margin else -1
    listed = tables.get(CONCEPT_LIST)
    if listed is not None and listed.of is not None:
        if not inp.get("everyConcept"):
            return []
        li = _index_of(listed.measures, "records")
        cells = [
            (_nth(margin.cells.get(str(g)), mi) if mi >= 0 else None, f"concept|{g}|records", False)
            for g in range(len(concept["mods"]))
        ] + [
            (_nth(listed.cells.get(f"{NO_GROUP}:{m}"), li), f"{listed.id}|{NO_GROUP}:{m}|records", listed.names[m] is not None)
            for m in listed.of.get(NO_GROUP, [])
        ]
        return records_cap(cells, inp)
    if not (concept and concept.get("everyConcept")) or not margin or mi < 0:
        return []
    masked = {c["key"] for c in inp["concepts"] if c.get("records") is None}
    return records_cap(
        [(_nth(margin.cells.get(str(i)), mi), f"{margin.id}|{i}|records", code in masked) for i, code in enumerate(concept["mods"])],
        inp,
    )


def records_cap(cells: list[tuple], inp: dict) -> list[Equation]:
    eqs: list[Equation] = []
    terms: list[tuple[int, str]] = []
    c = -inp["totals"]["records"]
    published = 1
    for value, x, named in cells:
        if value is not None:
            c += value
            published += 1
        else:
            terms.append((1, x))
            if named:
                eqs.append(_exists(x))
    if terms:
        eqs.append((terms, c - inp["noise"] * published, INF))
    return eqs


def propagate(eqs: list[Equation], fact_of: dict[str, str], measures_of: dict[str, list[str]]) -> tuple[dict, dict, int]:
    lo: dict[str, float] = {}
    hi: dict[str, float] = {}
    ids: dict[str, None] = {}
    for terms, _, _ in eqs:
        for _, x in terms:
            ids[x] = None
    pairs: list[tuple[str, str]] = []
    paired: set[str] = set()
    for x in list(ids):
        parts = x.split("|")
        table, key = parts[0], parts[1]
        measures = measures_of.get(table, [])
        for small, big in BOUNDS[fact_of.get(table, "visit")]:
            if small not in measures or big not in measures:
                continue
            a = f"{table}|{key}|{small}"
            b = f"{table}|{key}|{big}"
            if (x == a or x == b) and a + b not in paired:
                paired.add(a + b)
                pairs.append((a, b))
                ids[a] = None
                ids[b] = None
    for x in ids:
        lo[x] = 0
        hi[x] = INF

    for _ in range(ROUNDS):
        changed = False
        for terms, c_lo, c_hi in eqs:
            min_sum = max_sum = 0
            min_inf = max_inf = 0
            mins = []
            maxs = []
            for a, x in terms:
                lx, hx = lo[x], hi[x]
                mn = lx if a > 0 else -hx
                mx = hx if a > 0 else -lx
                mins.append(mn)
                maxs.append(mx)
                if mn == -INF:
                    min_inf += 1
                else:
                    min_sum += mn
                if mx == INF:
                    max_inf += 1
                else:
                    max_sum += mx
            for i, (a, x) in enumerate(terms):
                mx, mn = maxs[i], mins[i]
                rest_max = INF if max_inf - (1 if mx == INF else 0) > 0 else max_sum - (0 if mx == INF else mx)
                rest_min = -INF if min_inf - (1 if mn == -INF else 0) > 0 else min_sum - (0 if mn == -INF else mn)
                ax_lo = -c_hi - rest_max
                ax_hi = -c_lo - rest_min
                n_lo, n_hi = (ax_lo, ax_hi) if a > 0 else (-ax_hi, -ax_lo)
                if n_lo > lo[x] + 1e-9 and math.isfinite(n_lo):
                    lo[x] = math.ceil(n_lo - 1e-9)
                    changed = True
                if n_hi < hi[x] - 1e-9 and math.isfinite(n_hi):
                    hi[x] = math.floor(n_hi + 1e-9)
                    changed = True
        for small, big in pairs:
            if hi[big] < hi[small]:
                hi[small] = hi[big]
                changed = True
            if lo[small] > lo[big]:
                lo[big] = lo[small]
                changed = True
            if lo[big] >= 1 and lo[small] < 1:
                lo[small] = 1
                changed = True
        if not changed:
            break
    inconsistent = sum(1 for x in ids if lo[x] > hi[x])
    return lo, hi, inconsistent


class Audit:
    """`auditPublished`, one system at a time: `solve(n)` adds system n's
    findings; `checkpoint`/`Audit(inp, checkpoint)` carry what is found over."""

    def __init__(self, inp: dict, checkpoint: dict | None = None):
        self.inp = inp
        self.tables = tables_of(inp)
        self.fact_of = {t.id: _fact(t.vars) for t in self.tables.values()}
        self.measures_of = {t.id: t.measures for t in self.tables.values()}
        self.vars_of = {t.id: t.vars for t in self.tables.values()}
        margin = self.tables.get("concept")
        # One system per concept whose total is published: a concept without one has nothing to subtract from.
        self.components: list[int | None] = [None, *(_number(k) for k in (margin.cells if margin else {}))]
        cp = checkpoint or {}
        self.unknowns: int = cp.get("unknowns", 0)
        self.inconsistent: int = cp.get("inconsistent", 0)
        self.found: dict[str, dict] = {f"{f['crossing']}|{f['measure']}|{f['kind']}": f for f in cp.get("found", [])}

    def solve(self, n: int) -> None:
        eqs = equations_of(self.tables, self.inp, self.components[n])
        if not eqs:
            return
        lo, hi, bad = propagate(eqs, self.fact_of, self.measures_of)
        self.inconsistent += bad
        self.unknowns += len(lo)
        threshold = self.inp["threshold"]
        for x, lx in lo.items():
            hx = hi[x]
            if lx > hx:
                continue
            parts = x.split("|")
            table, key, measure = parts[0], parts[1], parts[2]
            if measure == "patients":
                kind = ("exact" if lx == hx else "small") if lx >= 1 and hx <= threshold - 1 else None
            else:
                kind = ("exact" if lx == hx else "narrow") if lx >= 1 and hx - lx <= 2 else None
            if not kind:
                continue
            fid = f"{table}|{measure}|{kind}"
            f = self.found.get(fid)
            if f is None:
                f = self.found[fid] = {
                    "crossing": table, "variables": self.vars_of.get(table), "measure": measure, "kind": kind,
                    "count": 0, "examples": [],
                }
            f["count"] += 1
            if len(f["examples"]) < EXAMPLES:
                f["examples"].append({"cell": self._cell(table, key), "lo": lx, "hi": hx})

    def _cell(self, table: str, key: str) -> list[str]:
        variables = self.inp["published"]["variables"]
        t = self.tables.get(table)
        if t is not None and t.of is not None:
            concept_names = (variables.get("concept") or {}).get("names")
            out = []
            for p, i in enumerate(key.split(":")):
                at = _array_index(i)
                if p == 0:
                    name = NO_GROUP_NAME if at == NO_GROUP else _nth(concept_names, at) if at is not None else None
                else:
                    name = _nth(t.names, at) if at is not None else None
                    name = UNLISTED if name is None else name
                out.append(i if name is None else name)
            return out
        vars_ = self.vars_of[table]
        out = []
        for p, i in enumerate(key.split(",")):
            var = variables.get(vars_[p])
            at = _array_index(i)
            name = _nth(var["names"], at) if var and at is not None else None
            out.append(i if name is None else name)
        return out

    def checkpoint(self, next_: int) -> dict:
        return {"next": next_, "unknowns": self.unknowns, "inconsistent": self.inconsistent, "found": list(self.found.values())}

    def result(self) -> dict:
        def rank(f: dict) -> tuple:
            first = f["variables"][0]
            return (
                0 if f["measure"] == "patients" else 1,
                VARIABLE_ORDER.index(first) if first in VARIABLE_ORDER else -1,
                js_code_units(f["crossing"]),
            )

        return {
            "components": len(self.components),
            "unknowns": self.unknowns,
            "inconsistent": self.inconsistent,
            "findings": sorted(self.found.values(), key=rank),
        }


def audit_published(inp: dict) -> dict:
    audit = Audit(inp)
    for n in range(len(audit.components)):
        audit.solve(n)
    return audit.result()


def child_main(inp: dict, checkpoint: dict | None, every: int, seconds: float, pace: float, conn: Connection) -> None:
    """The run's process: ("total", n), then ("checkpoint", …) after `every`
    systems or `seconds`, whichever first, then ("done", checkpoint, result) —
    or ("error", message). `elapsedMs` adds up the attempts' computing time.
    `pace`: seconds slept per system, for a test to stop it midway."""
    try:
        started = time.monotonic()
        elapsed = (checkpoint or {}).get("elapsedMs", 0)
        audit = Audit(inp, checkpoint)
        total = len(audit.components)
        conn.send(("total", total))

        def mark(done: int) -> dict:
            return {**audit.checkpoint(done), "elapsedMs": elapsed + round((time.monotonic() - started) * 1000)}

        sent_at, sent = time.monotonic(), (checkpoint or {}).get("next", 0)
        for n in range(sent, total):
            audit.solve(n)
            done = n + 1
            if pace:
                time.sleep(pace)
            if done < total and (done - sent >= every or time.monotonic() - sent_at >= seconds):
                conn.send(("checkpoint", mark(done)))
                sent_at, sent = time.monotonic(), done
        conn.send(("done", mark(total), audit.result()))
    except Exception as e:  # noqa: BLE001 — told to the run, which fails with it
        conn.send(("error", f"{type(e).__name__}: {e}"))
    finally:
        conn.close()
