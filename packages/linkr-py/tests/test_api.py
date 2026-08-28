import pytest

from linkr._api import LinkrError, api_call, find_database

FIXTURE = [
    {"id": "a1b2", "name": "MIMIC-IV", "engine": "postgresql", "dialect": "duckdb",
     "kind": "external", "connectable": True},
    {"id": "c3d4", "name": "Datamart", "engine": "duckdb", "dialect": "duckdb",
     "kind": "managed", "connectable": True},
    {"id": "e5f6", "name": "Datamart", "engine": "duckdb", "dialect": "duckdb",
     "kind": "managed", "connectable": False},
]


def test_resolves_by_name():
    assert find_database(FIXTURE, "MIMIC-IV")["id"] == "a1b2"


def test_resolves_by_id():
    assert find_database(FIXTURE, "c3d4")["name"] == "Datamart"


def test_id_wins_so_an_exact_id_is_never_ambiguous():
    # Two sources share the name "Datamart"; asking by id must still work.
    assert find_database(FIXTURE, "e5f6")["id"] == "e5f6"


def test_ambiguous_name_names_the_ids_to_choose_from():
    with pytest.raises(LinkrError, match="Several databases"):
        find_database(FIXTURE, "Datamart")
    with pytest.raises(LinkrError, match="c3d4"):
        find_database(FIXTURE, "Datamart")


def test_unknown_name_lists_what_is_available():
    with pytest.raises(LinkrError, match="MIMIC-IV"):
        find_database(FIXTURE, "nope")


def test_empty_project_reports_none():
    with pytest.raises(LinkrError, match=r"\(none\)"):
        find_database([], "anything")


def test_api_call_outside_a_session_says_what_is_missing(monkeypatch):
    for var in ("LINKR_API_URL", "LINKR_TOKEN", "LINKR_PROJECT_UID"):
        monkeypatch.delenv(var, raising=False)

    with pytest.raises(LinkrError, match="only set inside a Linkr IDE session"):
        api_call("/databases")
