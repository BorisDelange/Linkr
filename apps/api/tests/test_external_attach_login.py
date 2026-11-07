"""An external database's login stays out of what a query can read: the password
goes through a temporary secret, never into the ATTACH path that
`duckdb_databases()` and `PRAGMA database_list` show. And each DSN value stays one
value in the grammar its engine's parser implements, so a value cannot add a
connection parameter."""

import pytest

from app.services.data import db_connect, derive_writers

PASSWORD = "S3cret-pw 'x\" \\y"


class _Recorder:
    def __init__(self):
        self.sql: list[str] = []

    def execute(self, sql, *_args):
        self.sql.append(sql)
        return self


def _attached(engine: str) -> list[str]:
    con = _Recorder()
    db_connect._attach_external(
        con, "ext", {"engine": engine, "host": "db.internal", "database": "omop", "username": "reader",
                     "sslmode": "require", "application_name": "linkr"},
        PASSWORD,
    )
    return con.sql


@pytest.mark.parametrize("engine", ["postgresql", "mysql", "doris"])
def test_the_attach_path_never_holds_the_password(engine, monkeypatch):
    monkeypatch.setattr(db_connect, "_require_read_only_doris_login", lambda _con, _alias: None)
    sql = _attached(engine)
    attaches = [s for s in sql if s.lstrip().upper().startswith("ATTACH")]
    assert len(attaches) == 1
    assert "S3cret" not in attaches[0]
    assert "password" not in attaches[0].lower()
    secrets = [s for s in sql if "SECRET" in s and "S3cret" in s]
    assert len(secrets) == 1 and "TEMPORARY" in secrets[0]


def test_postgres_keeps_its_non_secret_options_in_the_path(monkeypatch):
    attach = next(s for s in _attached("postgresql") if s.lstrip().upper().startswith("ATTACH"))
    assert "sslmode=require" in attach and "application_name=linkr" in attach


def test_a_derived_database_is_written_without_the_password_in_its_path():
    con = _Recorder()
    dest = derive_writers.Destination(
        kind="external",
        config={"engine": "postgresql", "host": "db.internal", "database": "omop", "username": "writer"},
        password=PASSWORD,
    )
    derive_writers.writer_for(con, dest, "out")
    attaches = [s for s in con.sql if s.lstrip().upper().startswith("ATTACH")]
    assert len(attaches) == 1 and "S3cret" not in attaches[0]
    assert any("SECRET" in s and "S3cret" in s for s in con.sql)


def _mysql_parse(dsn: str) -> dict[str, str]:
    """The mysql extension's DSN grammar: `key=value` pairs separated by blank
    space; a value is either bare up to the next blank, or double-quoted with a
    backslash escaping only a backslash or a double quote. A key may follow a
    quoted value directly. A repeated key is refused."""
    out: dict[str, str] = {}
    pos, n = 0, len(dsn)
    while True:
        while pos < n and dsn[pos].isspace():
            pos += 1
        if pos >= n:
            return out
        eq = dsn.index("=", pos)
        key = dsn[pos:eq].strip()
        pos = eq + 1
        value = ""
        if pos < n and dsn[pos] == '"':
            pos += 1
            while True:
                if pos >= n:
                    raise ValueError("unterminated quote")
                ch = dsn[pos]
                if ch == '"':
                    pos += 1
                    break
                if ch == "\\":
                    if pos + 1 >= n or dsn[pos + 1] not in '\\"':
                        raise ValueError("bad escape")
                    value += dsn[pos + 1]
                    pos += 2
                    continue
                value += ch
                pos += 1
        else:
            while pos < n and not dsn[pos].isspace():
                value += dsn[pos]
                pos += 1
        if key in out:
            raise ValueError(f"duplicate {key}")
        out[key] = value


_HOSTILE = [
    "d host=127.0.0.2",
    '"d"host=127.0.0.2',
    '"d" host=127.0.0.2',
    'd" host=127.0.0.2',
    "d\\",
    "d\tssl_mode=BOGUS",
    "d\nsocket=/tmp/fake.sock",
    "it's \"quoted\" \\ here",
]


@pytest.mark.parametrize("engine", ["mysql", "doris"])
@pytest.mark.parametrize("field", ["database", "username"])
@pytest.mark.parametrize("value", _HOSTILE)
def test_a_mysql_dsn_value_stays_one_value(engine, field, value):
    config = {"engine": engine, "host": "db.internal", "database": "omop", "username": "reader", field: value}
    parsed = _mysql_parse(db_connect._dsn(config, "pw"))
    key = {"database": "database", "username": "user"}[field]
    assert parsed[key] == value
    assert set(parsed) == {"host", "port", "database", "user", "password"}
    assert parsed["host"] == "db.internal"


@pytest.mark.parametrize("value", _HOSTILE)
def test_a_mysql_dsn_password_stays_one_value(value):
    parsed = _mysql_parse(db_connect._dsn({"engine": "mysql", "host": "db.internal", "username": "u"}, value))
    assert parsed == {"host": "db.internal", "port": "3306", "user": "u", "password": value}
