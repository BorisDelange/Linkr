"""compare_versions against the SAME cases the frontend twin runs
(packages/linkr-format/src/app-version.fixture.json), so the two can't drift."""

import json
from pathlib import Path

import pytest

from app.export_version import compare_versions

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages" / "linkr-format" / "src" / "app-version.fixture.json"
)
_CASES = json.loads(_FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _CASES, ids=[f"{c['a']}|{c['b']}" for c in _CASES])
def test_compare_versions_matches_shared_fixture(case):
    assert compare_versions(case["a"], case["b"]) == case["expected"]
