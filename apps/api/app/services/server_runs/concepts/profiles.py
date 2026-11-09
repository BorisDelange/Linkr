"""The pure half of a concept run, as the browser computes it: the walk's ranking
(`source-extraction.ts`), the batch packing and the profile assembly from a batch
query's rows (`concept-profile.ts`), the profile store's merge and filter
(`profile-store.ts`), and the extracted CSV rows.

Twins of that TypeScript, held to one golden fixture
(apps/web/src/lib/__fixtures__/concept-runs/profiles.json) by
apps/web/src/lib/concept-mapping/concept-runs-twins.test.ts and
tests/test_concept_runs_profiles.py. What they write is read back by the
TypeScript UI and versioned in git, so a drift is a silent diff in every
profile.

Rows are the dicts `db_connect._row_to_json` gives, the values the browser gets
over HTTP. Every number is read as JavaScript reads it — a double, through
`js_number` — and every JSON text written as `JSON.stringify` writes it
(`js_values`).
"""

import math
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any

from app.services.server_runs.js_values import (
    MAX_SAFE_INTEGER,
    UNDEFINED,
    js_is_finite,
    js_json_dumps,
    js_len,
    js_number,
    js_number_str,
    js_round,
    js_slice_head,
    js_sorted,
    js_string,
    js_trim,
    js_trunc,
    js_truthy,
    nullish,
)

# ---------------------------------------------------------------------------
# The walk: ranking and order (source-extraction.ts)
# ---------------------------------------------------------------------------


def sort_needs_counts(sort: Mapping) -> bool:
    return sort.get("key") in ("records", "patients")


def dictionary_walk_ids(rows: Sequence[Mapping]) -> list:
    """The ids `buildDictionaryIdsQuery` returned, in walk order: by `ord` when
    the query carried one, whatever order the rows arrived in."""
    ordered = rows
    if any(r.get("ord") is not None for r in rows):
        ordered = js_sorted(rows, lambda a, b: js_number(a.get("ord", UNDEFINED)) - js_number(b.get("ord", UNDEFINED)))
    ids = (js_number(r.get("concept_id", UNDEFINED)) for r in ordered)
    return [i for i in ids if math.isfinite(i) and i != 0]


def merge_table_counts(per_table: Sequence[Sequence[Mapping]]) -> tuple[list[dict], dict]:
    """Each concept's counts over all its event tables, and its home table (the
    one holding most of its records; a tie goes to the earlier, richer one) as
    an index into `per_table`. Records add up across tables, patients do not:
    `patient_count` is the home table's."""
    best: dict = {}
    for table, rows in enumerate(per_table):
        for row in rows:
            cid = js_number(row.get("concept_id", UNDEFINED))
            if not math.isfinite(cid) or cid == 0:
                continue
            records = js_number(nullish(row.get("record_count", UNDEFINED), 0))
            current = best.get(cid)
            if current is None:
                best[cid] = {"row": row, "table": table, "records": records}
                continue
            current["records"] += records
            if records > js_number(nullish(current["row"].get("record_count", UNDEFINED), 0)):
                current["row"] = row
                current["table"] = table
    counts = [
        {"concept_id": cid, "record_count": b["records"], "patient_count": b["row"].get("patient_count")}
        for cid, b in best.items()
    ]
    return counts, {cid: b["table"] for cid, b in best.items()}


def rank_concept_ids(counts: Sequence[Mapping], sort: Mapping, all_ids: Sequence | None = None) -> list:
    """The concept ids in the order a volume sort asks for, ties broken by id so
    the order is total; a concept without counts ranks as zero."""
    column = "patient_count" if sort.get("key") == "patients" else "record_count"
    sign = -1 if sort.get("direction") == "desc" else 1
    by_id = {js_number(row.get("concept_id", UNDEFINED)): js_number(nullish(row.get(column, UNDEFINED), 0)) for row in counts}
    ids = all_ids if all_ids is not None else [js_number(row.get("concept_id", UNDEFINED)) for row in counts]

    def compare(a, b):
        av, bv = by_id.get(a, 0), by_id.get(b, 0)
        if av != bv:
            return sign * (av - bv)
        return a - b

    return js_sorted(ids, compare)


def plan_concept_walk(
    counts: Sequence[Mapping], sort: Mapping, dictionary_ids: Sequence, only_with_records: bool,
) -> list:
    """The concept ids a run walks, in order."""
    ids = [i for i in dictionary_ids if i != 0]
    ordered = rank_concept_ids(counts, sort, ids) if sort_needs_counts(sort) else ids
    if not only_with_records:
        return ordered
    with_records = {
        js_number(row.get("concept_id", UNDEFINED))
        for row in counts
        if js_number(nullish(row.get("record_count", UNDEFINED), 0)) > 0
    }
    return [i for i in ordered if i in with_records]


# ---------------------------------------------------------------------------
# Batches (concept-profile.ts)
# ---------------------------------------------------------------------------

PROFILE_BATCH_ROWS = 5_000_000
PROFILE_BATCH_CONCEPTS = 100
PROFILE_BATCH_CONCEPTS_UNSIZED = 10


def pack_profile_batches(
    concept_ids: Iterable,
    rows_of: Callable[[Any], float | None] | Mapping,
    max_rows: float = PROFILE_BATCH_ROWS,
    max_concepts: int = PROFILE_BATCH_CONCEPTS,
) -> list[list]:
    """Batches of at most `max_rows` records and `max_concepts` concepts, in
    order. A concept bigger than `max_rows` is a batch of its own; one with no
    known count weighs nothing."""
    weight = rows_of.get if isinstance(rows_of, Mapping) else rows_of
    batches: list[list] = []
    current: list = []
    rows = 0
    for cid in concept_ids:
        n = nullish(weight(cid), 0)
        if current and (rows + n > max_rows or len(current) >= max_concepts):
            batches.append(current)
            current = []
            rows = 0
        current.append(cid)
        rows += n
    if current:
        batches.append(current)
    return batches


# ---------------------------------------------------------------------------
# A batch's profiles from its rows (concept-profile.ts)
# ---------------------------------------------------------------------------

SCALAR_PREFIX = "s_"

BLOCK_COLUMNS: dict[str, tuple[str, ...]] = {
    "numeric": ("min", "max", "mean", "median", "sd", "p5", "p25", "p75", "p95", "numeric_count", "numeric_patients_count"),
    "histogram": ("bin_idx", "step_m", "step_e", "count", "patients_count"),
    "categorical": ("category", "count", "patients_count", "percentage"),
    "temporal": ("year", "count", "patients_count", "percentage", "start_date", "end_date"),
    "hospitalUnits": ("unit", "count", "patients_count", "percentage"),
}

_NUMERIC_KEYS = (
    "min", "p5", "p25", "median", "mean", "p75", "p95", "max", "sd", "numeric_count", "numeric_patients_count",
)


def _pow10(e: float) -> float:
    try:
        return math.pow(10.0, e)
    except OverflowError:
        return math.inf


def bin_centre(i: float, m: float, e: float) -> float:
    """`binCentre` (export-masking.ts), operation for operation."""
    if e >= 0:
        return ((2 * i + 1) * m * _pow10(e)) / 2
    return ((2 * i + 1) * m) / (2 * _pow10(-e))


def histogram_from_rows(rows: Sequence[Mapping]) -> list[dict]:
    out = []
    for row in rows:
        bar = {
            "x": bin_centre(
                js_number(row.get("bin_idx", UNDEFINED)), js_number(row.get("step_m", UNDEFINED)), js_number(row.get("step_e", UNDEFINED)),
            ),
            "count": js_number(row.get("count", UNDEFINED)),
        }
        if row.get("patients_count") is not None:
            bar["patients_count"] = js_number(row["patients_count"])
        out.append(bar)
    return out


def with_cell_counts(row: Mapping) -> dict:
    """The row with its `count` and `patients_count` as numbers, dropped when null."""
    out = {}
    for key, value in row.items():
        if key != "count" and key != "patients_count":
            out[key] = value
        elif value is not None and value is not UNDEFINED:
            out[key] = js_number(value)
    return out


def frequency_label(median_hours: Any) -> str | None:
    """The label the detail view shows for a median interval between records."""
    if not js_is_finite(median_hours) or median_hours <= 0:
        return None
    if median_hours < 1:
        return "per minute"
    if median_hours < 2:
        return "hourly"
    if median_hours < 12:
        return f"every {js_number_str(js_round(median_hours))} hours"
    if median_hours < 36:
        return "daily"
    if median_hours < 168:
        return "weekly"
    return "monthly or less"


def _mask_long_value(value: Any, max_length: Any) -> Any:
    if value is None or value is UNDEFINED:
        raise TypeError("Cannot read properties of null (reading 'length')")
    if isinstance(value, str) and js_len(value) > max_length:
        return None
    return value


def _trimmed(value: Any) -> str:
    if not isinstance(value, str):
        raise TypeError("category.trim is not a function")
    return js_trim(value)


def _names_a_number(trimmed: str) -> bool:
    return trimmed != "" and math.isfinite(js_number(trimmed))


def _categories_mirror_numbers(categories: Sequence[Mapping], has_numeric: bool) -> bool:
    """Whether the categories are the numeric values written as text (MIMIC's
    chartevents keeps `valuenum` and `value`): the same data shown twice."""
    if not has_numeric or not categories:
        return False
    return all(_names_a_number(_trimmed(row.get("category", UNDEFINED))) for row in categories)


def _pick_defined(row: Mapping, keys: Iterable[str]) -> dict:
    return {key: row[key] for key in keys if js_is_finite(row.get(key, UNDEFINED))}


def _present(row: Mapping, keys: Iterable[str]) -> dict:
    """`{a: row.a, …}`: a key the row lacks is undefined, which JSON drops."""
    return {key: row[key] for key in keys if key in row}


def assemble_profile_json(results: Mapping, concept: Mapping, options: Mapping) -> dict | None:
    """`assembleProfileJson`: the profile JSON from the blocks' rows, or None
    under the k-anonymity threshold. Absent keys are omitted, never null."""
    patients = results["base"]["patients_count"]
    if patients is not None and patients < options["minPatients"]:
        return None

    out: dict = {}
    if js_truthy(concept.get("fullName")):
        out["full_name"] = concept["fullName"]
    if js_truthy(concept.get("dataSource")):
        out["data_source"] = concept["dataSource"]

    numeric = results.get("numeric")
    has_numeric = numeric is not None and numeric.get("min") is not None
    masked = []
    for row in results.get("categorical") or []:
        cell = with_cell_counts({**row, "category": _mask_long_value(row.get("category", UNDEFINED), options["maxCategoryLength"])})
        if cell["category"] is not None:
            masked.append(cell)
    categorical = [] if _categories_mirror_numbers(masked, has_numeric) else masked
    has_categorical = len(categorical) > 0

    types = [t for t, on in (("numeric", has_numeric), ("categorical", has_categorical)) if on]
    if len(types) == 1:
        out["data_types"] = types[0]
    elif len(types) > 1:
        out["data_types"] = types

    unit = (results.get("unit") or {}).get("unit")
    if js_truthy(unit):
        out["unit"] = unit

    if has_numeric:
        def counted(value):
            return None if value is None or value is UNDEFINED else js_number(value)

        out["numeric_data"] = _pick_defined(
            {
                **numeric,
                "numeric_count": counted(numeric.get("numeric_count", UNDEFINED)),
                "numeric_patients_count": counted(numeric.get("numeric_patients_count", UNDEFINED)),
            },
            _NUMERIC_KEYS,
        )
    if results.get("histogram"):
        out["histogram"] = [with_cell_counts(r) for r in results["histogram"]]
    if has_categorical:
        out["categorical_data"] = categorical

    interval = frequency_label((results.get("frequency") or {}).get("median_hours"))
    if interval:
        out["measurement_frequency"] = {"typical_interval": interval}

    missing_rate = (results.get("missingRate") or {}).get("missing_rate")
    if missing_rate is not None:
        out["missing_rate"] = missing_rate

    if results.get("perPatient") is not None:
        per_patient = _pick_defined(results["perPatient"], ("mean", "median", "min", "max"))
        if per_patient:
            out["records_per_patient"] = per_patient

    temporal = results.get("temporal") or []
    if temporal:
        out["temporal_distribution"] = {
            **_present(temporal[0], ("start_date", "end_date")),
            "by_year": [with_cell_counts(_present(r, ("year", "percentage", "count", "patients_count"))) for r in temporal],
        }

    if results.get("hospitalUnits"):
        out["hospital_units"] = [with_cell_counts(r) for r in results["hospitalUnits"]]
    return out


def _read_scalar(scalar: Mapping, sections: Mapping, options: Mapping) -> dict:
    """`readScalar` for the batch path, which reads only `numericRead` and
    `numericCount` of the numeric part: the fences are computed in the SQL."""

    def num(key):
        value = scalar.get(key, UNDEFINED)
        return None if value is None or value is UNDEFINED else js_number(value)

    base = {"rows_count": js_number(nullish(scalar.get("rows_count", UNDEFINED), 0)), "patients_count": num("patients_count")}
    results: dict = {"base": base}
    if base["patients_count"] is not None and base["patients_count"] < options["minPatients"]:
        return {"results": results, "withheld": True, "numericRead": False, "numericCount": 0}

    if sections.get("missingRate") and "missing_rate" in scalar:
        results["missingRate"] = {"missing_rate": num("missing_rate")}
    if sections.get("unit") and scalar.get("unit") is not None:
        results["unit"] = {"unit": js_string(scalar["unit"])}
    if sections.get("frequency") and "median_hours" in scalar:
        results["frequency"] = {"median_hours": num("median_hours")}
    if sections.get("perPatient") and "per_patient_mean" in scalar:
        results["perPatient"] = {
            "mean": num("per_patient_mean"),
            "median": num("per_patient_median"),
            "min": num("per_patient_min"),
            "max": num("per_patient_max"),
        }
    numeric_read = bool(sections.get("numeric")) and "numeric_count" in scalar
    numeric_count = js_number(nullish(scalar.get("numeric_count", UNDEFINED), 0)) if numeric_read else 0
    return {"results": results, "withheld": False, "numericRead": numeric_read, "numericCount": numeric_count}


def read_batch_profiles(
    rows: Sequence[Mapping],
    concept_ids: Sequence,
    names: Mapping,
    sections: Mapping,
    options: Mapping,
    empty_scalar: Mapping,
    data_source_label: str | None,
) -> dict:
    """`readBatchProfiles`: each concept's outcome (`{json, rowsCount,
    patientsCount}`) from the rows of its batch query, by truncated id.

    `names`: concept id → its name (`full_name`). `sections`: the effective
    ones the query was built with. `empty_scalar`: `emptyScalar` of the event
    table, the row of a concept without records. `data_source_label`:
    `localizedPresetLabel` of the mapping."""
    scalars: dict[str, Mapping] = {}
    blocks: dict[str, list] = {}
    for row in rows:
        k = js_number_str(js_number(row.get("k", UNDEFINED)))
        if row.get("block", UNDEFINED) == "scalar":
            scalars[k] = {c[len(SCALAR_PREFIX):]: v for c, v in row.items() if c.startswith(SCALAR_PREFIX)}
            continue
        blocks.setdefault(f"{k}:{js_string(row.get('block', UNDEFINED))}", []).append(row)

    def block_rows(cid, block: str) -> list[dict]:
        found = blocks.get(f"{js_number_str(cid)}:{block}", [])
        ordered = js_sorted(found, lambda a, b: js_number(a.get("ord", UNDEFINED)) - js_number(b.get("ord", UNDEFINED)))
        return [_present(row, BLOCK_COLUMNS[block]) for row in ordered]

    out: dict = {}
    for concept_id in concept_ids:
        cid = js_trunc(js_number(concept_id))
        reading = _read_scalar(scalars.get(js_number_str(cid), empty_scalar), sections, options)
        results = reading["results"]
        if not reading["withheld"]:
            numeric = next(iter(block_rows(cid, "numeric")), None)
            if reading["numericRead"] and numeric is not None:
                results["numeric"] = numeric
            if sections.get("histogram") and reading["numericCount"] > 0:
                histogram = block_rows(cid, "histogram")
                if histogram:
                    results["histogram"] = histogram_from_rows(histogram)
            for block in ("categorical", "temporal", "hospitalUnits"):
                found = block_rows(cid, block)
                if found:
                    results[block] = found
        json = None if reading["withheld"] else assemble_profile_json(
            results, {"fullName": names.get(concept_id), "dataSource": data_source_label}, options,
        )
        base = results["base"]
        out[cid] = {"json": json, "rowsCount": base["rows_count"], "patientsCount": base["patients_count"]}
    return out


# ---------------------------------------------------------------------------
# The profile store (profile-store.ts)
# ---------------------------------------------------------------------------

SECTION_KEYS = (
    "counts", "missingRate", "perPatient", "frequency",
    "numeric", "histogram", "unit", "categorical",
    "temporal", "hospitalUnits",
)

SECTION_JSON_KEYS: dict[str, tuple[str, ...]] = {
    "counts": (),
    "numeric": ("numeric_data",),
    "histogram": ("histogram",),
    "categorical": ("categorical_data",),
    "unit": ("unit",),
    "frequency": ("measurement_frequency",),
    "temporal": ("temporal_distribution",),
    "hospitalUnits": ("hospital_units",),
    "missingRate": ("missing_rate",),
    "perPatient": ("records_per_patient",),
}

_SECTION_OF_JSON_KEY = {key: s for s in SECTION_KEYS for key in SECTION_JSON_KEYS[s]}

STORED_TOP_N = 200

DEFAULT_PROFILE_SECTIONS = {
    "counts": True, "numeric": True, "histogram": True, "categorical": True, "unit": True,
    "frequency": True, "temporal": True, "hospitalUnits": True, "missingRate": True, "perPatient": True,
}

DEFAULT_PROFILE_OPTIONS = {
    "metadata": True,
    "sections": DEFAULT_PROFILE_SECTIONS,
    "outlierMethod": "iqr",
    "outlierCoef": 1.5,
    "bins": "auto",
    "minCategoryCount": 50,
    "topN": 10,
    "maxCategoryLength": 50,
    "minPatients": 11,
}


def variant_of(options: Mapping) -> dict:
    return {"outlierMethod": options.get("outlierMethod"), "outlierCoef": options.get("outlierCoef"), "bins": options.get("bins")}


def _strict_equal(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


def _same_variant(a: Mapping, b: Mapping) -> bool:
    return all(_strict_equal(a.get(k), b.get(k)) for k in ("outlierMethod", "outlierCoef", "bins"))


def exact_options(options: Mapping, sections: Mapping | None = None) -> dict:
    """The options a stored profile is computed with: the reader's sections and
    variant, none of its thresholds."""
    return {
        **options,
        "metadata": True,
        "sections": options["sections"] if sections is None else sections,
        "minPatients": 0,
        "minCategoryCount": 1,
        "topN": STORED_TOP_N,
        "maxCategoryLength": MAX_SAFE_INTEGER,
    }


def sections_of(sections: Mapping) -> list[str]:
    return [k for k in SECTION_KEYS if (k == "counts" if sections.get(k) is None else js_truthy(sections[k]))]


def section_set(keys: Iterable[str]) -> dict:
    wanted = set(keys)
    return {k: k in wanted for k in SECTION_KEYS}


def missing_sections(stored: Mapping | None, wanted: Mapping, variant: Mapping, fingerprint: str) -> list[str]:
    """The asked sections a stored profile cannot answer: absent, computed on
    other data, or — for the numeric ones — under another variant."""
    asked = sections_of(wanted)
    if stored is None or stored.get("fingerprint") != fingerprint:
        return asked
    return [
        k for k in asked
        if k not in stored["sections"] or (k in ("numeric", "histogram") and not _same_variant(stored["variant"], variant))
    ]


def merge_profile(
    stored: Mapping | None,
    fresh: Mapping,
    computed: Sequence[str],
    identity: Mapping,
    variant: Mapping,
    fingerprint: str,
    computed_at: str,
) -> dict:
    """The stored profile with `computed` replaced by `fresh`. Sections not
    recomputed are kept — unless the data changed: then only the fresh ones."""
    keep = stored if stored is not None and stored.get("fingerprint") == fingerprint else None
    json = dict((keep or {}).get("json") or {})
    for k in computed:
        for key in SECTION_JSON_KEYS[k]:
            json.pop(key, None)
    for key, value in (fresh.get("json") or {}).items():
        if key == "data_types":
            continue
        section = _SECTION_OF_JSON_KEY.get(key)
        if section is None or section in computed:
            json[key] = value
    numeric_kept = "numeric" not in computed and keep is not None and not _same_variant(keep["variant"], variant)
    if numeric_kept:
        json.pop("numeric_data", None)
        json.pop("histogram", None)
    sections = set(keep["sections"] if keep is not None else ()) | set(computed)
    if numeric_kept:
        sections -= {"numeric", "histogram"}
    return {
        **identity,
        "rowsCount": fresh["rowsCount"],
        "patientsCount": fresh["patientsCount"],
        "json": json,
        "sections": [k for k in SECTION_KEYS if k in sections],
        "variant": variant,
        "fingerprint": fingerprint,
        "computedAt": computed_at,
    }


def _keys_count(value: Any) -> int:
    """`Object.keys(value).length`."""
    if isinstance(value, (Mapping, list, tuple)):
        return len(value)
    return js_len(value) if isinstance(value, str) else 0


def _mirrors_numbers(categories: Sequence[Mapping]) -> bool:
    return len(categories) > 0 and all(
        _names_a_number(js_trim(js_string(row.get("category", UNDEFINED)))) for row in categories
    )


def filter_profile(stored: Mapping, options: Mapping = DEFAULT_PROFILE_OPTIONS) -> dict:
    """What a reader with `options` gets from a stored profile: its sections
    only, its thresholds applied. None JSON under its patient threshold."""
    base = {"rowsCount": stored["rowsCount"], "patientsCount": stored["patientsCount"]}
    if stored["patientsCount"] is not None and stored["patientsCount"] < options["minPatients"]:
        return {**base, "json": None}
    wanted = set(sections_of(options["sections"]))
    json: dict = {}
    for key, value in stored["json"].items():
        if key == "data_types":
            continue
        section = _SECTION_OF_JSON_KEY.get(key)
        if section is not None and section not in wanted:
            continue
        json[key] = value
    numeric = json.get("numeric_data", UNDEFINED)
    has_numeric = js_truthy(numeric) and _keys_count(numeric) > 0
    if isinstance(json.get("categorical_data"), list):
        kept = js_slice_head(
            [
                row for row in json["categorical_data"]
                if js_number(nullish(row.get("count", UNDEFINED), 0)) >= options["minCategoryCount"]
                and js_len(js_string(row.get("category", UNDEFINED))) <= options["maxCategoryLength"]
            ],
            options["topN"],
        )
        if not kept or (has_numeric and _mirrors_numbers(kept)):
            del json["categorical_data"]
        else:
            json["categorical_data"] = kept
    if isinstance(json.get("hospital_units"), list):
        json["hospital_units"] = js_slice_head(json["hospital_units"], options["topN"])
    types = [t for t, on in (("numeric", has_numeric), ("categorical", isinstance(json.get("categorical_data"), list))) if on]
    ordered = {key: json[key] for key in ("full_name", "data_source") if key in json}
    if len(types) == 1:
        ordered["data_types"] = types[0]
    elif len(types) > 1:
        ordered["data_types"] = types
    for key, value in json.items():
        if key not in ordered:
            ordered[key] = value
    return {**base, "json": ordered}


# ---------------------------------------------------------------------------
# The extracted CSV (source-extraction.ts)
# ---------------------------------------------------------------------------

# A contract: `restoreFileSourceDataFromCsv` recognises a re-imported source by
# these names.
EXTRACTION_COLUMNS = (
    "terminology", "concept_code", "concept_id", "concept_name",
    "category", "record_count", "patient_count", "info_json",
)


def csv_escape(value: Any) -> str:
    """`csvEscape` (concept-mapping/export.ts)."""
    if value is None or value is UNDEFINED:
        return ""
    text = js_string(value)
    if "," in text or '"' in text or "\n" in text:
        return '"' + text.replace('"', '""') + '"'
    return text


def extraction_csv_header() -> str:
    return ",".join(EXTRACTION_COLUMNS)


def extraction_csv_rows(rows: Iterable[Mapping]) -> str:
    """A batch's CSV lines, no header — the caller appends."""
    return "\n".join(",".join(csv_escape(row.get(c, UNDEFINED)) for c in EXTRACTION_COLUMNS) for row in rows)


def _dictionary_concepts(page_rows: Iterable[Mapping]) -> list[tuple[Mapping, Any, str]]:
    seen: set = set()
    out = []
    for raw in page_rows:
        cid = js_number(raw.get("concept_id", UNDEFINED))
        if cid in seen:
            continue
        seen.add(cid)
        name = raw.get("concept_name")
        out.append((raw, cid, "" if name is None else js_string(name)))
    return out


def extracted_rows(
    page_rows: Iterable[Mapping],
    profiles: Mapping,
    *,
    metadata: bool,
    counts: bool,
    record_totals: Mapping | None = None,
) -> list[dict]:
    """`extractedRows`: a dictionary page's CSV rows (each concept id once, the
    first row winning), given each concept's outcome by id. With `metadata`,
    the rows stop at the first concept without one: it is profiled again on
    resume. `record_totals`: records over every event table, by id."""
    rows = []
    for concept, cid, name in _dictionary_concepts(page_rows):
        profile = profiles.get(cid)
        if metadata and profile is None:
            break
        code = concept.get("concept_code")
        with_counts = counts and profile is not None
        total = record_totals.get(cid) if record_totals is not None else None
        rows.append({
            "terminology": nullish(concept.get("vocabulary_id", UNDEFINED), ""),
            "concept_code": "" if code is None else js_string(code),
            "concept_id": cid,
            "concept_name": name,
            "category": nullish(concept.get("category", UNDEFINED), ""),
            "record_count": nullish(total, profile.get("rowsCount")) if with_counts else None,
            "patient_count": profile.get("patientsCount") if with_counts else None,
            # Empty, not "null": the source view reads anything unparseable as absent.
            "info_json": js_json_dumps(profile["json"]) if profile is not None and profile.get("json") is not None else "",
        })
    return rows
