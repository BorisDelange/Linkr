"""The Python twins of a concept run's pure functions against the golden fixture
the TypeScript generates (apps/web/src/lib/concept-mapping/concept-runs-twins.test.ts):
the server must rank, pack, assemble, merge and write exactly what the browser
did, or every profile it writes is a silent diff.

Compared as `JSON.stringify` text, so key order and number formatting count.
"""

import json
import math
from decimal import Decimal
from pathlib import Path

import pytest

from app.services.server_runs import js_values as js
from app.services.server_runs.concepts import profiles as p

_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "web" / "src" / "lib" / "__fixtures__" / "concept-runs" / "profiles.json"
)
_CASES = json.loads(_FIXTURE.read_text(encoding="utf-8"))


def _pairs(entries):
    return {k: v for k, v in entries}


def _run(section: str, c: dict):
    if section == "sortNeedsCounts":
        return p.sort_needs_counts(c["sort"])
    if section == "dictionaryWalkIds":
        return p.dictionary_walk_ids(c["rows"])
    if section == "mergeTableCounts":
        counts, homes = p.merge_table_counts(c["perTable"])
        return {"counts": counts, "homes": [[k, v] for k, v in homes.items()]}
    if section == "rankConceptIds":
        return p.rank_concept_ids(c["counts"], c["sort"], c.get("allIds"))
    if section == "planConceptWalk":
        return p.plan_concept_walk(c["counts"], c["sort"], c["dictionaryIds"], c["onlyWithRecords"])
    if section == "packProfileBatches":
        rows = _pairs(c["rows"])
        limits = {k: c[n] for k, n in (("max_rows", "maxRows"), ("max_concepts", "maxConcepts")) if n in c}
        return p.pack_profile_batches(c["conceptIds"], rows.get, **limits)
    if section == "frequencyLabel":
        return p.frequency_label(c.get("medianHours"))
    if section == "batchProfiles":
        concept_ids = [x["conceptId"] for x in c["concepts"]]
        names = {x["conceptId"]: x.get("conceptName") for x in c["concepts"]}
        out = p.read_batch_profiles(
            c["rows"], concept_ids, names, c["sections"], c["options"], c["emptyScalar"], c.get("dataSource"),
        )
        return [[k, v] for k, v in out.items()]
    if section == "sectionsOf":
        return p.sections_of(c["sections"])
    if section == "sectionSet":
        return p.section_set(c["keys"])
    if section == "variantOf":
        return p.variant_of(c["options"])
    if section == "exactOptions":
        return p.exact_options(c["options"], c.get("sections"))
    if section == "missingSections":
        return p.missing_sections(c.get("stored"), c["wanted"], c["variant"], c["fingerprint"])
    if section == "mergeProfile":
        return p.merge_profile(
            c.get("stored"), c["fresh"], c["computed"], c["identity"], c["variant"], c["fingerprint"], c["computedAt"],
        )
    if section == "filterProfile":
        return p.filter_profile(c["stored"], c["options"]) if "options" in c else p.filter_profile(c["stored"])
    if section == "extractedRows":
        totals = c.get("recordTotals")
        rows = p.extracted_rows(
            c["page"], _pairs(c["profiles"]),
            metadata=c["metadata"], counts=c["counts"], record_totals=None if totals is None else _pairs(totals),
        )
        return {"rows": rows, "csv": p.extraction_csv_rows(rows)}
    if section == "extractionCsvHeader":
        return p.extraction_csv_header()
    if section == "numberToString":
        return js.js_number_str(c["value"])
    if section == "jsonStringify":
        return js.js_json_dumps(_pairs(c["entries"]) if "entries" in c else c["value"])
    raise AssertionError(f"no twin for fixture section {section}")


_PARAMS = [
    pytest.param(section, c, id=f"{section}: {c['name']}")
    for section, cases in _CASES.items()
    for c in cases
]


@pytest.mark.parametrize(("section", "case"), _PARAMS)
def test_matches_the_typescript(section, case):
    assert js.js_json_dumps(_run(section, case)) == js.js_json_dumps(case["expected"])


def test_every_section_has_cases():
    assert {s for s, cases in _CASES.items() if cases} >= {
        "rankConceptIds", "packProfileBatches", "batchProfiles", "mergeProfile", "filterProfile", "extractedRows",
    }


def test_extracted_text_is_the_typescript_text_byte_for_byte():
    # The CSV and its info_json are text the user reviews in git: the fixture's
    # strings are what JSON.stringify wrote, compared as they are.
    for c in _CASES["extractedRows"]:
        got = _run("extractedRows", c)
        assert got["csv"] == c["expected"]["csv"]
        assert [r["info_json"] for r in got["rows"]] == [r["info_json"] for r in c["expected"]["rows"]]
    for c in _CASES["jsonStringify"]:
        assert _run("jsonStringify", c) == c["expected"]


# What a JSON fixture cannot carry: the shapes a Python row has and JavaScript
# never sees, read as the browser reads them once they cross HTTP.


@pytest.mark.parametrize(("value", "text"), [
    (12.0, "12"),
    (-0.0, "0"),
    (math.nan, "null"),
    (math.inf, "null"),
    (2**53 + 1, "9007199254740992"),
    (10**400, "null"),
    (Decimal("1.50"), "1.5"),
    ([1.0, None, "é"], '[1,null,"é"]'),
    ({"10": 1, "9": 2, "b": 3, "a": {"2": 0, "1": 1.25}}, '{"9":2,"10":1,"b":3,"a":{"1":1.25,"2":0}}'),
    ("\ud83d\ude00 \ud83d", '"😀 \\ud83d"'),
])
def test_json_text_of_python_values(value, text):
    assert js.js_json_dumps(value) == text


@pytest.mark.parametrize(("value", "number"), [
    (None, 0), (True, 1), ("", 0), ("  \u00a0 ", 0), (" 12 ", 12), ("0x1F", 31), ("0b101", 5), ("0o17", 15),
    ("1e3", 1000), (".5", 0.5), ("5.", 5), ("+3", 3), ("-Infinity", -math.inf), ("\ufeff7", 7), ("1.5", 1.5),
])
def test_number_of_text(value, number):
    assert js.js_number(value) == number


@pytest.mark.parametrize("value", ["1_000", "inf", "nan", "infinity", "0x", "-0x1F", "1e", "\u001c7", "١٢", [1, 2], {}])
def test_text_that_is_not_a_number(value):
    assert math.isnan(js.js_number(value))


def test_math_round_rounds_half_up():
    assert [js.js_round(x) for x in (2.5, 3.5, -2.5, 11.49, 11.5)] == [3, 4, -2, 11, 12]
