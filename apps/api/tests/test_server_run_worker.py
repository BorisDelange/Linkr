"""The killable query worker of a concept run: one child process per run, its
connection opened once and locked down as the pooled paths lock theirs, and a
stop that always ends the query — interrupt, then SIGTERM, then SIGKILL."""

import asyncio
import os
import signal
import time

import duckdb
import pyarrow as pa
import pytest

from app.services.data import connection_pool, db_connect
from app.services.server_runs.worker import (
    QueryFailed,
    QueryStalled,
    QueryTimedOut,
    QueryWorker,
    SetupFailed,
    WorkerDied,
    temp_root,
)

GRACE_S = 0.5
# A query DuckDB stops on its interrupt, for a second or more.
LONG_QUERY = "SELECT max(md5(i::VARCHAR)) AS m FROM range(10000000000) t(i)"


def hang(con: duckdb.DuckDBPyConnection) -> None:
    """A query calling sleep_through() ignores its interrupt: DuckDB only checks
    the flag between chunks, and the function holds this one for a minute."""

    def sleep_through(x: int) -> int:
        time.sleep(60)
        return x

    con.create_function("sleep_through", sleep_through)


def hang_and_ignore_sigterm(con: duckdb.DuckDBPyConnection) -> None:
    hang(con)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)


def _parquet(path, sql: str) -> str:
    duckdb.execute(f"COPY ({sql}) TO '{path}' (FORMAT PARQUET)")
    return str(path)


@pytest.fixture
def parquet_inputs(tmp_path):
    folder = tmp_path / "omop"
    folder.mkdir()
    person = _parquet(folder / "person.parquet", "SELECT * FROM (VALUES (1, 8507), (2, 8532), (3, 8532)) t(person_id, gender_concept_id)")
    return {"engine": "parquet"}, None, [("person.parquet", person)], ["person"]


@pytest.fixture
def duckdb_file(tmp_path):
    path = tmp_path / "src.duckdb"
    con = duckdb.connect(str(path))
    con.execute("CREATE TABLE person AS SELECT * FROM (VALUES (1), (2)) t(person_id)")
    con.close()
    return str(path)


def _worker(inputs, **kwargs) -> QueryWorker:
    kwargs.setdefault("interrupt_grace_s", GRACE_S)
    kwargs.setdefault("term_grace_s", GRACE_S)
    return QueryWorker(*inputs, **kwargs)


async def _in_flight(worker: QueryWorker, sql: str, **kwargs) -> asyncio.Task:
    task = asyncio.create_task(worker.run(sql, **kwargs))
    await asyncio.sleep(0.3)
    assert not task.done()
    return task


async def test_runs_queries_on_one_connection(parquet_inputs):
    worker = _worker(parquet_inputs)
    try:
        await worker.start()
        pid = worker._child.process.pid
        rows = await worker.run("SELECT gender_concept_id, COUNT(*) AS n FROM person GROUP BY 1 ORDER BY 1")
        assert rows == [{"gender_concept_id": 8507, "n": 1}, {"gender_concept_id": 8532, "n": 2}]
        [spill] = await worker.run("SELECT current_setting('temp_directory') AS d")
        assert spill["d"].startswith(str(temp_root()))
        assert os.path.isdir(spill["d"])
        assert worker._child.process.pid == pid
    finally:
        await worker.stop()
    assert not worker.alive
    assert not os.path.exists(spill["d"])


async def test_arrow_returns_the_whole_table(parquet_inputs):
    worker = _worker(parquet_inputs)
    try:
        table = await worker.run("SELECT person_id FROM person ORDER BY 1", arrow=True)
    finally:
        await worker.stop()
    assert isinstance(table, pa.Table)
    assert table.column("person_id").to_pylist() == [1, 2, 3]


async def test_a_query_error_keeps_the_worker(parquet_inputs):
    worker = _worker(parquet_inputs)
    try:
        await worker.start()
        pid = worker._child.process.pid
        with pytest.raises(QueryFailed, match="nope") as failed:
            await worker.run("SELECT * FROM nope")
        assert failed.value.kind == "CatalogException"
        # What a query creates lives only as long as its own run.
        assert await worker.run("CREATE TABLE t AS SELECT 7 AS x; SELECT x FROM t") == [{"x": 7}]
        with pytest.raises(QueryFailed):
            await worker.run("SELECT x FROM t")
        assert await worker.run("SELECT COUNT(*) AS n FROM person") == [{"n": 3}]
        assert worker._child.process.pid == pid
    finally:
        await worker.stop()


async def test_the_lock_down_holds(tmp_path, duckdb_file):
    secret = tmp_path / "secret.csv"
    secret.write_text("password\nhunter2\n")
    worker = _worker(({"engine": "duckdb"}, None, [("src.duckdb", duckdb_file)], None))
    try:
        assert await worker.run("SELECT COUNT(*) AS n FROM person") == [{"n": 2}]
        with pytest.raises(QueryFailed, match="disabled by configuration|Cannot access file"):
            await worker.run(f"SELECT * FROM read_csv('{secret}')")
        with pytest.raises(QueryFailed, match="read-only"):
            await worker.run("CREATE TABLE ext.main.leak AS SELECT 1 AS x")
        with pytest.raises(QueryFailed, match="COPY is not allowed") as copied:
            await worker.run(f"COPY (SELECT * FROM person) TO '{tmp_path / 'out.csv'}'")
        assert copied.value.kind == "ValueError"
        with pytest.raises(QueryFailed):
            await worker.run("SET enable_external_access = true")
        with pytest.raises(QueryFailed, match="ATTACH"):
            await worker.run(f"ATTACH '{tmp_path / 'other.duckdb'}' AS other")
        assert await worker.run("SELECT COUNT(*) AS n FROM person") == [{"n": 2}]
    finally:
        await worker.stop()
    assert not (tmp_path / "out.csv").exists()


async def test_a_parquet_folder_reads_its_own_files_only(tmp_path, parquet_inputs):
    other = _parquet(tmp_path / "other.parquet", "SELECT 42 AS s")
    worker = _worker(parquet_inputs)
    try:
        with pytest.raises(QueryFailed, match="disabled by configuration|Cannot access file"):
            await worker.run(f"SELECT * FROM read_parquet('{other}')")
    finally:
        await worker.stop()


async def test_cancel_interrupts_a_query_that_listens(parquet_inputs):
    worker = _worker(parquet_inputs, interrupt_grace_s=10.0)
    try:
        await worker.start()
        pid = worker._child.process.pid
        task = await _in_flight(worker, LONG_QUERY)
        started = time.monotonic()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert time.monotonic() - started < 3
        assert worker.alive and worker._child.process.pid == pid
        assert await worker.run("SELECT COUNT(*) AS n FROM person") == [{"n": 3}]
    finally:
        await worker.stop()


async def test_cancel_kills_a_query_that_ignores_its_interrupt(parquet_inputs):
    worker = _worker(parquet_inputs, prepare=f"{__name__}:hang")
    try:
        await worker.start()
        child = worker._child
        task = await _in_flight(worker, "SELECT sleep_through(1) AS x")
        started = time.monotonic()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert time.monotonic() - started < GRACE_S + 2
        assert child.process.exitcode == -signal.SIGTERM
        assert not worker.alive
        assert not child.temp_dir.exists()
        assert await worker.run("SELECT COUNT(*) AS n FROM person") == [{"n": 3}]
        assert worker._child.process.pid != child.process.pid
    finally:
        await worker.stop()


async def test_sigkill_ends_a_child_that_ignores_sigterm(parquet_inputs):
    worker = _worker(parquet_inputs, prepare=f"{__name__}:hang_and_ignore_sigterm")
    try:
        await worker.start()
        child = worker._child
        task = await _in_flight(worker, "SELECT sleep_through(1) AS x")
        started = time.monotonic()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert time.monotonic() - started < 2 * GRACE_S + 2
        assert child.process.exitcode == -signal.SIGKILL
        assert not child.temp_dir.exists()
    finally:
        await worker.stop()


async def test_a_second_cancel_does_not_cut_the_ladder_short(parquet_inputs):
    worker = _worker(parquet_inputs, prepare=f"{__name__}:hang")
    try:
        await worker.start()
        child = worker._child
        task = await _in_flight(worker, "SELECT sleep_through(1) AS x")
        task.cancel()
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert child.process.exitcode is not None
        assert not child.temp_dir.exists()
    finally:
        await worker.stop()


async def test_a_deadline_stops_the_query(parquet_inputs):
    worker = _worker(parquet_inputs, prepare=f"{__name__}:hang")
    try:
        await worker.start()
        pid = worker._child.process.pid
        started = time.monotonic()
        with pytest.raises(QueryTimedOut):
            await worker.run(LONG_QUERY, deadline=0.3)
        assert time.monotonic() - started < 2
        assert worker._child.process.pid == pid

        started = time.monotonic()
        with pytest.raises(QueryTimedOut):
            await worker.run("SELECT sleep_through(1) AS x", deadline=0.3)
        assert time.monotonic() - started < 0.3 + GRACE_S + 2
        assert not worker.alive
        assert await worker.run("SELECT COUNT(*) AS n FROM person", deadline=30) == [{"n": 3}]
    finally:
        await worker.stop()


async def test_a_query_that_stops_working_is_stopped_before_its_deadline(parquet_inputs):
    # sleep_through() sleeps as a hung DuckDB does (duckdb#26720): no CPU spent.
    worker = _worker(parquet_inputs, prepare=f"{__name__}:hang", stall_after_s=1.0)
    try:
        started = time.monotonic()
        with pytest.raises(QueryStalled):
            await worker.run("SELECT sleep_through(1) AS x", deadline=60)
        assert time.monotonic() - started < 1.0 + 1.0 + GRACE_S + 3
        assert await worker.run("SELECT COUNT(*) AS n FROM person", deadline=30) == [{"n": 3}]
    finally:
        await worker.stop()


async def test_a_query_that_works_is_never_taken_as_stalled(parquet_inputs):
    worker = _worker(parquet_inputs, stall_after_s=0.6)
    try:
        # Busy for its whole deadline, five windows long: it times out, not stalls.
        with pytest.raises(QueryTimedOut):
            await worker.run(LONG_QUERY, deadline=3)
    finally:
        await worker.stop()


async def test_a_child_that_dies_fails_its_query_and_is_replaced(parquet_inputs):
    worker = _worker(parquet_inputs, prepare=f"{__name__}:hang")
    try:
        await worker.start()
        child = worker._child
        task = await _in_flight(worker, "SELECT sleep_through(1) AS x")
        os.kill(child.process.pid, signal.SIGKILL)
        with pytest.raises(WorkerDied):
            await task
        assert not child.temp_dir.exists()
        assert await worker.run("SELECT COUNT(*) AS n FROM person") == [{"n": 3}]
    finally:
        await worker.stop()


async def test_progress_of_the_query_in_flight(tmp_path):
    big = _parquet(tmp_path / "big.parquet", "SELECT i, md5(i::VARCHAR) AS h FROM range(2000000) t(i)")
    worker = _worker(({"engine": "parquet"}, None, [("big.parquet", big)], ["big"]), threads=1)
    try:
        await worker.start()
        assert await worker.progress() is None
        task = asyncio.create_task(worker.run("SELECT max(md5(md5(md5(md5(h))))) AS m FROM big"))
        seen = []
        while not task.done():
            if (value := await worker.progress()) is not None:
                seen.append(value)
            await asyncio.sleep(0.02)
        await task
    finally:
        await worker.stop()
    assert seen and all(0 < v <= 100 for v in seen)


async def test_a_file_the_api_pool_holds_read_only_opens_in_the_worker(duckdb_file):
    """The pooled connection attaches the file READ_ONLY: a shared lock, which the
    worker's own READ_ONLY attach can share."""
    assert db_connect.query_file("duckdb", duckdb_file, "SELECT COUNT(*) AS n FROM person", pool_key="held") == [{"n": 2}]
    worker = _worker(({"engine": "duckdb"}, None, [("src.duckdb", duckdb_file)], None))
    try:
        assert await worker.run("SELECT COUNT(*) AS n FROM person") == [{"n": 2}]
        assert db_connect.query_file("duckdb", duckdb_file, "SELECT COUNT(*) AS n FROM person", pool_key="held") == [{"n": 2}]
    finally:
        await worker.stop()
        connection_pool.clear()


async def test_a_file_held_read_write_does_not_open(duckdb_file):
    writer = duckdb.connect(duckdb_file)
    worker = _worker(({"engine": "duckdb"}, None, [("src.duckdb", duckdb_file)], None))
    try:
        with pytest.raises(SetupFailed, match="lock"):
            await worker.start()
        assert not worker.alive
        assert not list(temp_root().iterdir())
    finally:
        writer.close()
        await worker.stop()


async def test_spill_directories_of_a_gone_api_are_swept(parquet_inputs):
    gone = await asyncio.create_subprocess_exec("true")
    await gone.wait()
    orphan = temp_root() / f"{gone.pid}-0123"
    orphan.mkdir(parents=True)
    ours_unused = temp_root() / f"{os.getpid()}-4567"
    ours_unused.mkdir()
    worker = _worker(parquet_inputs)
    try:
        await worker.start()
        assert not orphan.exists() and not ours_unused.exists()
        assert worker._child.temp_dir.exists()
    finally:
        await worker.stop()


def test_external_databases_stay_in_the_api_process():
    with pytest.raises(ValueError, match="API process"):
        QueryWorker({"engine": "postgresql", "host": "db"}, "secret", None, None)
