"""Parity + behavior tests for deterministic column ids.

The parity cases come from the SAME fixture the frontend test consumes
(apps/web/src/lib/column-id.fixture.json), so the TS and Python twins can't drift.
"""

import json
from pathlib import Path

from app.services.data.column_id import build_column_ids, column_id, unique_column_id

_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "web" / "src" / "lib" / "column-id.fixture.json"
)


def _cases():
    data = json.loads(_FIXTURE.read_text())
    return [(c["names"], c["ids"]) for c in data["cases"]]


def test_build_column_ids_matches_shared_fixture():
    for names, expected in _cases():
        assert build_column_ids(names) == expected, names


def test_column_id_single():
    assert column_id("Âge") == "col_age"
    assert column_id("hospit_unit") == "col_hospit_unit"
    assert column_id("mean SpO2 (%)") == "col_mean_spo2"


def test_column_id_empty_folds_to_col_col():
    assert column_id("") == "col_col"
    assert column_id("   ") == "col_col"
    assert column_id("!!!") == "col_col"


def test_unique_column_id_collision_suffixes():
    taken: set[str] = set()
    assert unique_column_id("sex", taken) == "col_sex"
    assert unique_column_id("sex", taken) == "col_sex_2"
    assert unique_column_id("sex", taken) == "col_sex_3"
