"""core/redact: the password a driver quotes back in its error never travels on."""
import asyncio

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


@pytest.mark.parametrize("quoted", ['"abc def"', "'abc def'", r"'abc\' def'", '"abc def'])
def test_a_quoted_password_is_hidden_whole(quoted):
    out = redact_secrets(f"host=h password={quoted} user=u")
    assert "abc" not in out and "def" not in out and "password=***" in out


@pytest.mark.parametrize("url", ["mysql://u:S3cret@h:3306/d", "postgresql://u:S3cret@h/d", "https://oauth2:S3cret@gitlab.com/g/r.git"])
def test_a_url_password_is_hidden_and_its_user_kept(url):
    out = redact_secrets(f"could not connect to {url}: refused")
    head, host = url.split(":S3cret@")
    assert "S3cret" not in out and f"{head}:***@{host}: refused" in out


def test_a_url_without_a_password_is_unchanged():
    for text in ("see https://gitlab.com/g/r and git@gitlab.com:g/r.git", "https://host:8443/x", "mysql://u@h/d"):
        assert redact_secrets(text) == text


def test_a_port_and_a_path_holding_an_at_sign_are_not_a_password():
    for text in ("http://host:8080/path@x", "https://h:443/users/@me/repos"):
        assert redact_secrets(text) == text


@pytest.mark.parametrize("text", ["a." * 50000, "a://b:c" * 15000, "a://" + "b" * 100000, "password=" * 12000, 'password="' * 10000])
def test_long_adversarial_text_is_redacted_in_linear_time(text):
    import time

    start = time.perf_counter()
    redact_secrets(text)
    assert time.perf_counter() - start < 0.5


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


def test_an_escaped_newline_does_not_end_the_password():
    out = redact_secrets('at "host=h password=ab\\\ncdSECRET user=u": refused')
    assert "SECRET" not in out and "password=***" in out


def test_the_server_log_never_keeps_it():
    import logging

    from app.core.logging import RedactSecrets, _redact_event

    record = logging.LogRecord("app.x", logging.INFO, __file__, 1, "query failed: %s", (POSTGRES,), None)
    try:
        raise duckdb.IOException(POSTGRES)
    except duckdb.IOException:
        import sys

        record.exc_info = sys.exc_info()
    assert RedactSecrets().filter(record)
    line = logging.Formatter("%(message)s").format(record)
    assert "S3cret" not in line and "password=***" in line and "IOException" in line
    assert "S3cret" not in str(_redact_event(None, "error", {"event": "unhandled_error", "exception": POSTGRES}))


async def test_a_jobs_log_and_error_never_keep_it(db, engine, monkeypatch):
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from app.core.security import hash_password
    from app.models.user import User
    from app.models.workspace import Workspace
    from app.services.execution import jobs

    monkeypatch.setattr(jobs, "async_session", async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False))
    db.add(Workspace(id="ws1"))
    db.add(User(id=1, username="u", password_hash=hash_password("x"), role="user"))
    await db.commit()
    job = await jobs.create(db, None, 1, "query", "Q", workspace_id="ws1")
    handle = jobs.JobHandle(job.id)
    await handle.log(POSTGRES)
    await handle.set_result({"done": [], "error": POSTGRES, "errors": {"u0": POSTGRES}})
    await db.refresh(job)
    assert "S3cret" not in job.log_tail and "S3cret" not in str(job.result)
    assert job.result["done"] == []

    async def failing():
        raise duckdb.IOException(POSTGRES)

    task = asyncio.create_task(failing())
    await asyncio.gather(task, return_exceptions=True)
    await jobs.adopt(job.id, task)
    await asyncio.gather(*jobs._status_writes)
    await db.refresh(job)
    assert job.status == "error" and "S3cret" not in job.log_tail


def test_a_log_call_with_mismatched_args_does_not_raise():
    import logging

    from app.core.logging import RedactSecrets

    record = logging.LogRecord("app.x", logging.INFO, __file__, 1, "two %s %s", (POSTGRES,), None)
    assert RedactSecrets().filter(record)
    line = logging.Formatter("%(message)s").format(record)
    assert line.startswith("two %s %s") and "S3cret" not in line


def test_uvicorn_tracebacks_and_access_lines_are_redacted():
    import logging
    import sys

    from app.core.logging import setup_logging

    setup_logging()
    setup_logging()
    error = logging.getLogger("uvicorn.error")
    assert len(error.filters) == len(set(map(type, error.filters)))
    try:
        raise duckdb.IOException(POSTGRES)
    except duckdb.IOException:
        record = error.makeRecord("uvicorn.error", logging.ERROR, __file__, 1, "Exception in ASGI application", (), sys.exc_info())
    assert error.filter(record)
    assert "S3cret" not in logging.Formatter("%(message)s").format(record)

    access = logging.getLogger("uvicorn.access")
    args = ("1.2.3.4:5", "GET", "/x?u=mysql://u:S3cret@h/d", "1.1", 200)
    record = access.makeRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d', args, None)
    assert access.filter(record)
    assert record.args[2] == "/x?u=mysql://u:***@h/d" and record.args[4] == 200

