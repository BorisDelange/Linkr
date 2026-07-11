"""db_connect DSN builder: client-controlled connection fields must not inject
extra DSN keywords or break the ATTACH SQL literal.

DuckDB's postgres/mysql ATTACH parser follows libpq's backslash escaping, NOT
its ``key="value"`` double-quoting (double quotes would be taken as literal
characters of the value). So each value is kept a single token by
backslash-escaping the delimiters (space, backslash) and the single quote."""

import re

from app.services.data import db_connect


def _top_level_keys(dsn: str) -> list[str]:
    """DSN keywords at the top level: a ``word=`` not preceded by a backslash
    (an escaped space keeps a smuggled ``key=`` inside the previous value)."""
    return re.findall(r"(?:^|(?<!\\)\s)(\w+)=", dsn)


def test_dsn_keeps_each_value_as_one_token():
    dsn = db_connect._dsn(
        {"engine": "postgresql", "host": "db.internal", "database": "omop",
         "username": "reader"},
        "s3cr3t",
    )
    assert _top_level_keys(dsn) == ["host", "dbname", "user", "password"]


def test_simple_value_is_not_quoted():
    """A benign host/user has no special chars, so it stays bare — the form DuckDB
    actually connects with (double-quoting it would break host resolution)."""
    dsn = db_connect._dsn({"engine": "postgresql", "host": "localhost"}, None)
    assert dsn == "host=localhost"


def test_dsn_injection_via_username_is_neutralised():
    """A username smuggling ` password=... host=...` must stay one token (its
    spaces escaped), not add top-level keywords."""
    dsn = db_connect._dsn(
        {"engine": "postgresql", "host": "ok",
         "username": "x password=STOLEN host=evil.example"},
        "realpw",
    )
    keys = _top_level_keys(dsn)
    assert keys.count("host") == 1
    assert keys.count("password") == 1
    assert keys.count("user") == 1
    assert r"user=x\ password=STOLEN\ host=evil.example" in dsn


def test_dsn_value_escapes_space_backslash_and_quote():
    assert db_connect._dsn_value("a b") == "a\\ b"
    assert db_connect._dsn_value("a\\b") == "a\\\\b"
    assert db_connect._dsn_value("a'b") == "a\\'b"


def test_dsn_value_escapes_all_whitespace_not_just_space():
    """libpq treats tab/newline/CR/form-feed/vertical-tab as token separators
    too, so a value must escape every whitespace char — otherwise a `\\t`-
    separated `key=value` breaks out just like a space-separated one would."""
    assert db_connect._dsn_value("a\tb") == "a\\\tb"
    assert db_connect._dsn_value("a\nb") == "a\\\nb"
    assert db_connect._dsn_value("a\rb") == "a\\\rb"
    assert db_connect._dsn_value("a\fb") == "a\\\fb"
    assert db_connect._dsn_value("a\vb") == "a\\\vb"


def test_dsn_injection_via_tab_is_neutralised():
    """A username smuggling keywords separated by TABs must stay one token."""
    dsn = db_connect._dsn(
        {"engine": "postgresql", "host": "ok",
         "username": "x\tpassword=STOLEN\thost=evil.example"},
        "realpw",
    )
    keys = _top_level_keys(dsn)
    assert keys.count("host") == 1
    assert keys.count("password") == 1
    assert keys.count("user") == 1


def test_port_is_coerced_to_int():
    dsn = db_connect._dsn({"engine": "mysql", "port": "3306"}, None)
    assert "port=3306" in dsn  # not escaped, numeric


def test_scope_rejects_non_identifier():
    import pytest

    with pytest.raises(ValueError):
        db_connect._scope({"engine": "postgresql", "schema": "public; DROP TABLE x"})
