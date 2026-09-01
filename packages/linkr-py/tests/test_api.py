import pytest

from linkr._api import LinkrError, api_call, find_database

FIXTURE = [
    {"id": "a1b2", "alias": "mimic_iv", "name": "MIMIC-IV", "engine": "postgresql",
     "dialect": "duckdb", "kind": "external", "connectable": True},
    {"id": "c3d4", "alias": "datamart", "name": "Datamart", "engine": "duckdb",
     "dialect": "duckdb", "kind": "managed", "connectable": True},
]


def test_resolves_by_alias():
    assert find_database(FIXTURE, "mimic_iv")["id"] == "a1b2"


def test_the_display_name_is_not_an_address():
    # Addressing by name would break the day someone renames the database, and a
    # name can be localized — there is no single "the" name to match on.
    with pytest.raises(LinkrError, match="No database with alias"):
        find_database(FIXTURE, "MIMIC-IV")


def test_the_uuid_is_not_an_address():
    # Stable, but unreadable in the code a reviewer has to read.
    with pytest.raises(LinkrError, match="No database with alias"):
        find_database(FIXTURE, "a1b2")


def test_duplicate_alias_is_reported_not_silently_resolved():
    # Nothing enforces alias uniqueness today. Returning whichever row came first
    # is how a script quietly reads the wrong database.
    dupes = [
        {"id": "c3d4", "alias": "datamart", "name": "A"},
        {"id": "e5f6", "alias": "datamart", "name": "B"},
    ]
    with pytest.raises(LinkrError, match="Several databases share the alias"):
        find_database(dupes, "datamart")
    with pytest.raises(LinkrError, match="e5f6"):
        find_database(dupes, "datamart")


def test_unknown_alias_lists_what_is_available():
    with pytest.raises(LinkrError, match="mimic_iv"):
        find_database(FIXTURE, "nope")


def test_empty_project_reports_none():
    with pytest.raises(LinkrError, match=r"\(none\)"):
        find_database([], "anything")


def test_api_call_outside_a_session_says_what_is_missing(monkeypatch):
    for var in ("LINKR_API_URL", "LINKR_TOKEN", "LINKR_PROJECT_UID"):
        monkeypatch.delenv(var, raising=False)

    with pytest.raises(LinkrError, match="only set inside a Linkr IDE session"):
        api_call("/databases")
