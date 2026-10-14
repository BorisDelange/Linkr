"""core/redact: the password a driver quotes back in its error never travels on."""
import duckdb
import pytest

from app.core import audit
from app.core.redact import redact_secrets
from app.services.data import db_connect

# What DuckDB's extensions actually raise when a server does not answer.
POSTGRES = 'IO Error: Unable to connect to Postgres at "host=10.0.0.5 port=5432 user=u password=S3cret dbname=d": connection refused'
MYSQL = 'IO Error: Failed to connect to MySQL database with parameters "host=10.0.0.5 port=9030 user=u password=S3cret database=d": Can\'t connect'


@pytest.mark.parametrize("text", [POSTGRES, MYSQL])
def test_the_dsn_password_is_hidden_and_the_rest_kept(text):
    out = redact_secrets(text)
    assert "S3cret" not in out and "password=***" in out
    assert "host=10.0.0.5" in out and out.endswith(text[text.index('": ') + 3:])


def test_an_escaped_space_does_not_end_the_password():
    # db_connect._dsn_value backslash-escapes whitespace inside a value.
    out = redact_secrets(r'at "host=h password=two\ words\"q user=u": refused')
    assert "words" not in out and "q user" not in out and "user=u" in out


def test_text_without_a_dsn_password_is_unchanged():
    for text in ("password authentication failed for user \"u\"", "Access denied for user 'u'@'h' (using password: YES)"):
        assert redact_secrets(text) == text


def test_a_failed_attach_raises_the_same_error_redacted():
    class Con:
        def execute(self, sql):
            raise duckdb.IOException(POSTGRES)

    with pytest.raises(duckdb.IOException) as raised:
        db_connect.attach_dsn(Con(), "host=10.0.0.5 password=S3cret", "ext", "TYPE postgres")
    assert "S3cret" not in str(raised.value) and raised.value.__cause__ is None
    assert raised.value.__suppress_context__


def test_the_access_log_never_keeps_it():
    token = audit._current.set({})
    try:
        audit.bind(error=POSTGRES)
        assert "S3cret" not in audit._current.get()["error"]
    finally:
        audit._current.reset(token)
