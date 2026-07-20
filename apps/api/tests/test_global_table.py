"""Parity tests for the cross-project global table merge (mirrors the browser's
global-summary-queries.ts flat/dedup build)."""

import tempfile
from pathlib import Path

from app.services.data import global_table_service as gts


def _fixtures():
    projects = [
        {
            "id": "p1", "name": {"en": "Proj 1"}, "source_type": "file",
            # Badge label is a LocalizedString (as real projects carry) — dedup mode
            # must resolve it to a string, not join the raw dict (No-results bug).
            "updated_at": "t1", "badges": [{"label": {"en": "ICU", "fr": "Réa"}}],
            "raw_file_sha": "sha1",
            # No conceptIdColumn → artificial id → resolved via registry.
            "file_source_data": {"columnMapping": {}},
        },
    ]
    mappings = {"p1": [
        {
            "id": "m1", "source_vocabulary_id": "LOINC", "source_concept_code": "1234-5",
            "source_concept_name": "Glucose", "source_concept_id": 1,
            "target_concept_id": 3000905, "target_concept_name": "Tidal volume",
            "target_vocabulary_id": "LOINC", "equivalence": "skos:exactMatch",
            "status": "approved", "reviews": [{"status": "approved"}], "updated_at": "u1",
        },
    ]}
    source_concepts = {"p1": [
        {"vocabulary_id": "LOINC", "concept_code": "1234-5", "concept_name": "Glucose", "concept_id": 1},
        {"vocabulary_id": "LOINC", "concept_code": "6789-0", "concept_name": "Sodium", "concept_id": 2},
    ]}
    registry = {"LOINC__1234-5": 2000001, "LOINC__6789-0": 2000002}
    return projects, mappings, source_concepts, registry


def test_flat_maps_and_unmaps_with_registry_resolution():
    projects, mappings, source_concepts, registry = _fixtures()
    rows = gts.build_flat_rows(projects, mappings, source_concepts, registry)
    assert len(rows) == 2
    mapped = next(r for r in rows if not r["is_unmapped"])
    unmapped = next(r for r in rows if r["is_unmapped"])
    assert mapped["source_concept_code"] == "1234-5"
    assert mapped["resolved_source_concept_id"] == 2000001  # artificial → registry
    assert mapped["votes_approved"] == 1
    assert unmapped["source_concept_code"] == "6789-0"
    assert unmapped["resolved_source_concept_id"] == 2000002


def test_flat_real_concept_id_not_registry():
    projects, mappings, source_concepts, registry = _fixtures()
    # File project WITH a real conceptIdColumn → use the source's own id, not registry.
    projects[0]["file_source_data"]["columnMapping"] = {"conceptIdColumn": "id"}
    rows = gts.build_flat_rows(projects, mappings, source_concepts, registry)
    mapped = next(r for r in rows if not r["is_unmapped"])
    assert mapped["resolved_source_concept_id"] == 1  # source_concept_id, not 2000001


def test_dedup_one_row_per_source_target_badge():
    projects, mappings, source_concepts, registry = _fixtures()
    rows = gts.build_dedup_rows(projects, mappings, source_concepts, registry)
    assert len(rows) == 2  # one mapped + one unmapped
    mapped = next(r for r in rows if not r["is_unmapped"])
    assert mapped["project_count"] == 1
    # LocalizedString badge label resolved to the 'en' string (not the raw dict).
    assert mapped["badge_labels"] == "ICU"


def test_materialize_and_page_with_filters():
    projects, mappings, source_concepts, registry = _fixtures()
    rows = gts.build_flat_rows(projects, mappings, source_concepts, registry)
    with tempfile.TemporaryDirectory() as d:
        dest = Path(d) / "flat.parquet"
        gts.materialize(rows, "flat", dest)

        page, total = gts.query_page(dest, "flat", {}, None, 10, 0)
        assert total == 2 and len(page) == 2

        _, search_total = gts.query_page(dest, "flat", {"globalSearch": "sodium"}, None, 10, 0)
        assert search_total == 1

        _, unmapped_total = gts.query_page(dest, "flat", {"statusFilter": ["unmapped"]}, None, 10, 0)
        assert unmapped_total == 1

        _, vocab_total = gts.query_page(dest, "flat", {"sourceVocabularyId": "LOINC"}, None, 10, 0)
        assert vocab_total == 2

        # Assigned source-concept-id filter (was silently ignored — no where clause).
        _, id_total = gts.query_page(dest, "flat", {"sourceConceptId": "2000001"}, None, 10, 0)
        assert id_total == 1
        # Partial id matches as text.
        _, prefix_total = gts.query_page(dest, "flat", {"sourceConceptId": "200000"}, None, 10, 0)
        assert prefix_total == 2
        # A non-matching id filters everything out.
        _, none_total = gts.query_page(dest, "flat", {"sourceConceptId": "9999999"}, None, 10, 0)
        assert none_total == 0


def test_cache_signature_changes_with_mappings():
    projects, mappings, _, registry = _fixtures()
    sig1 = gts.cache_signature(projects, mappings, registry)
    mappings["p1"][0]["updated_at"] = "u2"
    sig2 = gts.cache_signature(projects, mappings, registry)
    assert sig1 != sig2


def test_cache_path_rejects_malformed_signature():
    import pytest

    # A real signature (16 lowercase hex) is accepted.
    ok = gts.cache_path("ws1", "flat", "0123456789abcdef")
    assert ok.name == "ws1__flat__0123456789abcdef.parquet"
    # Anything else (traversal, wrong length/charset) is refused before it reaches
    # a filename — no reading a Parquet outside the cache dir.
    for bad in ("../../../../etc/passwd", "0123456789abcde", "0123456789ABCDEF", "abc/def", "a" * 64):
        with pytest.raises(ValueError):
            gts.cache_path("ws1", "flat", bad)


def test_cached_path_or_raise_treats_bad_signature_as_miss():
    import pytest

    with pytest.raises(gts.CacheMissing):
        gts.cached_path_or_raise("ws1", "flat", "../escape")
