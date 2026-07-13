"""Parity tests for the server-side port of the frontend's effective-status
logic (app/services/data/mapping_status.py ↔ mapping-status.ts). If these
diverge, server-computed stats/mapped-keys drift from standalone mode."""

from app.models.mapping_project import ConceptMapping
from app.services.data.mapping_status import effective_mapping_status, source_key


def _m(status=None, reviews=None, vocab=None, code=None) -> ConceptMapping:
    return ConceptMapping(
        status=status,
        reviews=reviews,
        source_vocabulary_id=vocab,
        source_concept_code=code,
    )


def test_no_reviews_falls_back_to_stored_status():
    assert effective_mapping_status(_m(status="approved")) == "approved"
    assert effective_mapping_status(_m(status="unchecked", reviews=[])) == "unchecked"


def test_single_decisive_reviewer_wins():
    m = _m(status="unchecked", reviews=[{"status": "approved"}])
    assert effective_mapping_status(m) == "approved"


def test_disagreement_is_disputed():
    m = _m(
        status="unchecked",
        reviews=[{"status": "approved"}, {"status": "rejected"}],
    )
    assert effective_mapping_status(m) == "disputed"


def test_pending_only_reviews_fall_back_to_stored_status():
    # 'unchecked' and 'suggested' are not decisions — ignored for the vote.
    m = _m(
        status="flagged",
        reviews=[{"status": "unchecked"}, {"status": "suggested"}],
    )
    assert effective_mapping_status(m) == "flagged"


def test_pending_plus_one_decisive_uses_the_decisive():
    m = _m(
        status="unchecked",
        reviews=[{"status": "unchecked"}, {"status": "flagged"}],
    )
    assert effective_mapping_status(m) == "flagged"


def test_agreeing_reviewers_not_disputed():
    m = _m(
        status="unchecked",
        reviews=[{"status": "approved"}, {"status": "approved"}],
    )
    assert effective_mapping_status(m) == "approved"


def test_source_key_uses_nul_separator_and_empty_for_null():
    assert source_key(_m(vocab="LOINC", code="1234-5")) == "LOINC\x001234-5"
    assert source_key(_m(vocab=None, code=None)) == "\x00"
