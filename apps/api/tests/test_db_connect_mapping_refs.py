"""`mapping.<name>` resolution for ETL runs.

The rows of a mapping project are deliberately absent from the generated (and
versioned) script — they travel with the run and are materialised here. Mirrors
the frontend's resolveMappingRefs (apps/web/src/lib/duckdb/mapping-source.ts);
the two must agree or a script behaves differently front-only and on the server.
"""

import tempfile

import duckdb

from app.services.data.db_connect import _resolve_mapping_refs

CSV = (
    "source_code,source_concept_id,source_code_description\n"
    '50983,2000000001,"Sodium, Plasma"\n'
)


def test_rewrites_the_reference_to_a_readable_file():
    with tempfile.TemporaryDirectory() as tmp:
        sql = _resolve_mapping_refs(
            "SELECT * FROM read_csv('mapping.stcm')", {"stcm": CSV}, tmp
        )
        rows = duckdb.connect().execute(sql).fetchall()
        # The comma inside the quoted field must survive as one value.
        assert rows == [(50983, 2000000001, "Sodium, Plasma")]


def test_leaves_an_unknown_export_as_written():
    # So the error names the missing export rather than a meaningless path.
    with tempfile.TemporaryDirectory() as tmp:
        sql = "SELECT * FROM read_csv('mapping.absent')"
        assert _resolve_mapping_refs(sql, {}, tmp) == sql


def test_writes_each_export_once_but_rewrites_every_occurrence():
    with tempfile.TemporaryDirectory() as tmp:
        out = _resolve_mapping_refs(
            "read_csv('mapping.stcm') UNION ALL SELECT * FROM read_csv('mapping.stcm')",
            {"stcm": CSV},
            tmp,
        )
        assert out.count(tmp) == 2


def test_ignores_a_schema_qualifier_of_the_same_shape():
    # Only the quoted form is a mapping export; this is what keeps the mechanism
    # separate from the source./target./vocab. role prefixes.
    with tempfile.TemporaryDirectory() as tmp:
        sql = "SELECT * FROM mapping.source_to_concept_map"
        assert _resolve_mapping_refs(sql, {"source_to_concept_map": CSV}, tmp) == sql


def test_accepts_a_double_quoted_reference_and_emits_a_string_literal():
    # A double-quoted path would read as an identifier in DuckDB.
    with tempfile.TemporaryDirectory() as tmp:
        out = _resolve_mapping_refs('read_csv("mapping.stcm")', {"stcm": CSV}, tmp)
        assert '"' not in out
        assert out.startswith("read_csv('")
