"""db_connect DSN builder: client-controlled connection fields must not inject
extra DSN keywords or break the ATTACH SQL literal."""

import re

from app.services.data import db_connect


def _top_level_keys(dsn: str) -> list[str]:
    """DSN keywords at the top level (each value is double-quoted)."""
    return re.findall(r'(?:^|\s)(\w+)="', dsn)


def test_dsn_quotes_each_value_as_one_token():
    dsn = db_connect._dsn(
        {"engine": "postgresql", "host": "db.internal", "database": "omop",
         "username": "reader"},
        "s3cr3t",
    )
    assert _top_level_keys(dsn) == ["host", "dbname", "user", "password"]


def test_dsn_injection_via_username_is_neutralised():
    """A username smuggling ` password=... host=...` must stay one quoted token,
    not add top-level keywords."""
    dsn = db_connect._dsn(
        {"engine": "postgresql", "host": "ok",
         "username": "x password=STOLEN host=evil.example"},
        "realpw",
    )
    keys = _top_level_keys(dsn)
    assert keys.count("host") == 1
    assert keys.count("password") == 1
    assert keys.count("user") == 1
    assert 'user="x password=STOLEN host=evil.example"' in dsn


def test_dsn_value_escapes_double_quote_and_backslash():
    v = db_connect._dsn_value('a"b\\c')
    assert v == '"a\\"b\\\\c"'


def test_port_is_coerced_to_int():
    dsn = db_connect._dsn({"engine": "mysql", "port": "3306"}, None)
    assert "port=3306" in dsn  # not quoted, numeric


def test_scope_rejects_non_identifier():
    import pytest

    with pytest.raises(ValueError):
        db_connect._scope({"engine": "postgresql", "schema": "public; DROP TABLE x"})
