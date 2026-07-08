"""Server-side R/Python execution endpoint (POST /execute)."""

import asyncio
import shutil

import pytest

API = "/api/v1"

_HAS_R = shutil.which("Rscript") is not None
requires_r = pytest.mark.skipif(not _HAS_R, reason="Rscript not installed")


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _run(client, headers, code: str, language: str = "python"):
    return await client.post(
        f"{API}/execute", headers=headers, json={"language": language, "code": code}
    )


async def test_execute_captures_stdout(client):
    headers = await _admin_headers(client)
    r = await _run(client, headers, "print(6 * 7)")
    assert r.status_code == 200
    body = r.json()
    assert body["stdout"].strip() == "42"
    assert body["stderr"] == ""
    assert body["table"] is None and body["figures"] == []


async def test_execute_user_error_goes_to_stderr_not_500(client):
    headers = await _admin_headers(client)
    r = await _run(client, headers, "raise ValueError('boom')")
    assert r.status_code == 200  # a user error is captured output, not a server error
    assert "ValueError" in r.json()["stderr"]


async def test_execute_dataframe_result_becomes_table(client):
    headers = await _admin_headers(client)
    r = await _run(client, headers, "import pandas as pd\nresult = pd.DataFrame({'a': [1, 2]})")
    body = r.json()
    assert body["table"] == {"headers": ["a"], "rows": [["1"], ["2"]]}


async def test_execute_matplotlib_figure_captured_as_svg(client):
    headers = await _admin_headers(client)
    r = await _run(client, headers, "import matplotlib.pyplot as plt\nplt.plot([1,2],[3,4])")
    figs = r.json()["figures"]
    assert len(figs) == 1 and figs[0]["type"] == "svg" and figs[0]["id"] == "fig-0"


@requires_r
async def test_execute_r_captures_stdout(client):
    headers = await _admin_headers(client)
    r = await _run(client, headers, "cat('hello R\\n')", language="r")
    assert r.status_code == 200
    assert "hello R" in r.json()["stdout"]


@requires_r
async def test_execute_r_plot_captured_as_svg(client):
    headers = await _admin_headers(client)
    r = await _run(client, headers, "plot(1:10)", language="r")
    figs = r.json()["figures"]
    assert len(figs) == 1 and figs[0]["type"] == "svg" and "<svg" in figs[0]["data"]


@requires_r
async def test_execute_r_error_goes_to_stderr(client):
    headers = await _admin_headers(client)
    r = await _run(client, headers, "stop('boom R')", language="r")
    assert r.status_code == 200
    assert "boom R" in r.json()["stderr"]


async def test_persistent_kernel_keeps_variables_between_runs(client):
    headers = await _admin_headers(client)
    body1 = {"language": "python", "code": "a = 40\na = a + 2", "projectUid": "p1"}
    assert (await client.post(f"{API}/execute", headers=headers, json=body1)).status_code == 200
    # A second run in the same project/env sees `a` from the first.
    body2 = {"language": "python", "code": "print(a)", "projectUid": "p1"}
    r = await client.post(f"{API}/execute", headers=headers, json=body2)
    assert r.json()["stdout"].strip() == "42"


async def test_execute_large_output_not_truncated_or_500(client):
    """A result line larger than asyncio's default 64 KB StreamReader limit must
    read fully (raised limit), not raise LimitOverrunError → 500."""
    headers = await _admin_headers(client)
    body = {"language": "python", "code": "print('x' * 200000)", "projectUid": "p-big"}
    r = await client.post(f"{API}/execute", headers=headers, json=body)
    assert r.status_code == 200
    assert len(r.json()["stdout"]) >= 200000


async def test_kernel_recovers_from_dead_subprocess(client):
    """A crashed/killed kernel subprocess must not poison future runs: the next
    execute restarts it (broken-pipe retry) instead of returning a 500."""
    headers = await _admin_headers(client)
    body = {"language": "python", "code": "print('ok')", "projectUid": "p-recover"}
    assert (await client.post(f"{API}/execute", headers=headers, json=body)).status_code == 200
    # Kill the live kernel's subprocess out from under it, leaving a dead pipe.
    from app.services.execution.kernel import manager
    k = await manager.get("p-recover", "python", "default")
    if k._proc is not None:  # noqa: SLF001 — test reaches into the kernel to simulate a crash
        k._proc.kill()
        await k._proc.wait()
    # Next run should transparently restart and succeed, not 500.
    r = await client.post(f"{API}/execute", headers=headers, json=body)
    assert r.status_code == 200
    assert r.json()["stdout"].strip() == "ok"


async def test_kernels_isolated_per_env(client):
    headers = await _admin_headers(client)
    await client.post(f"{API}/execute", headers=headers,
                      json={"language": "python", "code": "x = 1", "projectUid": "p1", "envId": "e1"})
    r = await client.post(f"{API}/execute", headers=headers,
                          json={"language": "python", "code": "print(x)", "projectUid": "p1", "envId": "e2"})
    assert "NameError" in r.json()["stderr"]


async def test_restart_clears_kernel_state(client):
    headers = await _admin_headers(client)
    await client.post(f"{API}/execute", headers=headers,
                      json={"language": "python", "code": "z = 99", "projectUid": "p2"})
    assert (await client.post(f"{API}/execute/restart", headers=headers,
            json={"language": "python", "projectUid": "p2"})).status_code == 204
    r = await client.post(f"{API}/execute", headers=headers,
                          json={"language": "python", "code": "print(z)", "projectUid": "p2"})
    assert "NameError" in r.json()["stderr"]


@requires_r
async def test_persistent_r_kernel_keeps_variables(client):
    headers = await _admin_headers(client)
    await client.post(f"{API}/execute", headers=headers,
                      json={"language": "r", "code": "y <- 41; y <- y + 1", "projectUid": "rp1"})
    r = await client.post(f"{API}/execute", headers=headers,
                          json={"language": "r", "code": "print(y)", "projectUid": "rp1"})
    assert "42" in r.json()["stdout"]


async def _import_dataset(client, headers) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    up = await client.post(f"{API}/uploads", headers=headers, json={"fileName": "d.csv", "totalChunks": 1})
    upid = up.json()["uploadId"]
    await client.put(f"{API}/uploads/{upid}/chunk?index=0", headers=headers, content=b"age,grp\n30,a\n40,b\n")
    sha = (await client.post(f"{API}/uploads/{upid}/complete", headers=headers)).json()["sha"]
    ds = (await client.post(f"{API}/datasets/import", headers=headers,
          json={"projectUid": uid, "name": "d", "sha": sha, "fileName": "d.csv"})).json()
    return uid, ds["id"]


async def _disk_dataset(client, headers) -> tuple[str, str]:
    """Create a project and drop a CSV into its datasets/ dir (disk-source mode).
    Returns (project_uid, dataset_path)."""
    from app.services import project_fs

    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    (project_fs.datasets_dir(uid) / "d.csv").write_text("age,grp\n30,a\n40,b\n")
    return uid, "d.csv"


async def test_execute_injects_dataset_python(client):
    headers = await _admin_headers(client)
    project_uid, path = await _disk_dataset(client, headers)
    # In disk-source mode datasetFileId carries the dataset's relative path.
    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python", "code": "print(list(dataset.columns)); print(float(dataset['age'].mean()))",
        "projectUid": project_uid, "datasetFileId": path,
    })
    assert r.status_code == 200
    out = r.json()["stdout"]
    assert "age" in out and "grp" in out and "35" in out


async def test_execute_injects_filtered_dataset(client):
    headers = await _admin_headers(client)
    project_uid, path = await _disk_dataset(client, headers)  # age: 30, 40
    files = (await client.get(f"{API}/dataset-files", headers=headers, params={"projectUid": project_uid})).json()
    age_col = next(c["id"] for c in files[0]["columns"] if c["name"] == "age")
    # Keep only age >= 35 -> one row (age 40).
    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python",
        "code": "print(len(dataset))",
        "projectUid": project_uid, "datasetFileId": path,
        "datasetFilters": [
            {"colId": age_col, "kind": "number",
             "alternatives": [{"op": "between", "min": 35}]},
        ],
    })
    assert r.status_code == 200
    assert r.json()["stdout"].strip() == "1"


async def test_execute_dataset_not_found_is_404(client):
    headers = await _admin_headers(client)
    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python", "code": "1", "datasetFileId": "nope",
    })
    assert r.status_code == 404


async def test_sql_query_bridge_runs_via_host(client, monkeypatch):
    headers = await _admin_headers(client)
    # Stub the data-source layer so no real DB is needed: any connection_id
    # resolves to a fake source, and query() returns canned rows.
    from app.services import data_source_service

    async def fake_get(db, source_id):
        return object()

    async def fake_query(source, sql):
        assert "person" in sql
        return [{"id": 1, "name": "alice"}, {"id": 2, "name": "bob"}]

    monkeypatch.setattr(data_source_service, "get", fake_get)
    monkeypatch.setattr(data_source_service, "query", fake_query)

    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python",
        "code": "df = sql_query('SELECT * FROM person')\nprint(df['name'].tolist())",
        "projectUid": "sqlp", "connectionId": "conn-1",
    })
    assert r.status_code == 200
    assert "alice" in r.json()["stdout"] and "bob" in r.json()["stdout"]


async def test_sql_query_without_connection_errors_in_kernel(client):
    headers = await _admin_headers(client)
    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python",
        "code": "sql_query('SELECT 1')",
        "projectUid": "sqlp2",
    })
    # No connection -> the RPC resolver returns an error the kernel raises -> stderr.
    assert r.status_code == 200
    assert "connection" in r.json()["stderr"].lower()


async def test_list_kernels_reports_live_sessions(client):
    headers = await _admin_headers(client)
    # No kernels yet for this project.
    r = await client.get(f"{API}/execute/kernels?projectUid=kp", headers=headers)
    assert r.json() == []
    # Running code spins one up; it then shows as alive.
    await client.post(f"{API}/execute", headers=headers,
                      json={"language": "python", "code": "1", "projectUid": "kp"})
    r = await client.get(f"{API}/execute/kernels?projectUid=kp", headers=headers)
    kernels = r.json()
    assert len(kernels) == 1
    assert kernels[0]["language"] == "python" and kernels[0]["alive"] is True


async def test_stateless_run_without_project_does_not_persist(client):
    headers = await _admin_headers(client)
    await _run(client, headers, "b = 7")  # no projectUid -> stateless one-shot
    r = await _run(client, headers, "print(b)")
    assert "NameError" in r.json()["stderr"]


async def test_execute_unsupported_language_is_400(client):
    headers = await _admin_headers(client)
    r = await _run(client, headers, "1", language="julia")
    assert r.status_code == 400


async def test_execute_requires_auth(client):
    r = await client.post(f"{API}/execute", json={"language": "python", "code": "print(1)"})
    assert r.status_code == 401


# --- Streaming core (execute_stream) -------------------------------------------
# These exercise the Kernel directly: the terminal (§07d) streams output chunk by
# chunk, while the batch execute() wrapper (covered by the tests above) proves the
# legacy one-shot contract still holds on the same code path.


def _make_python_kernel(tmp_path):
    import sys

    from app.services.execution.kernel import Kernel, _PY_KERNEL_LOOP

    return Kernel([sys.executable, "-c", _PY_KERNEL_LOOP], cwd=str(tmp_path))


async def test_execute_stream_emits_chunks_before_done(tmp_path):
    """Output produced incrementally must arrive as separate stdout chunks, in
    order, before the final RuntimeOutput — not buffered into one blob."""
    kernel = _make_python_kernel(tmp_path)
    chunks: list[tuple[str, str]] = []
    try:
        out = await kernel.execute_stream(
            "for i in range(3):\n    print(i)",
            lambda kind, data: chunks.append((kind, data)),
        )
    finally:
        await kernel.shutdown()
    stdout_chunks = [c for c in chunks if c[0] == "stdout"]
    assert len(stdout_chunks) >= 3
    joined = "".join(d for _, d in stdout_chunks)
    assert joined.index("0") < joined.index("1") < joined.index("2")
    # Streamed output is not duplicated in the done payload.
    assert out.stdout == ""


async def test_execute_stream_routes_stderr_separately(tmp_path):
    kernel = _make_python_kernel(tmp_path)
    chunks: list[tuple[str, str]] = []
    try:
        await kernel.execute_stream(
            "import sys\nsys.stderr.write('warn\\n')\nprint('ok')",
            lambda kind, data: chunks.append((kind, data)),
        )
    finally:
        await kernel.shutdown()
    assert any(k == "stderr" and "warn" in d for k, d in chunks)
    assert any(k == "stdout" and "ok" in d for k, d in chunks)


async def test_execute_stream_supports_async_chunk_handler(tmp_path):
    kernel = _make_python_kernel(tmp_path)
    chunks: list[str] = []

    async def on_chunk(kind: str, data: str) -> None:
        chunks.append(data)

    try:
        await kernel.execute_stream("print('hi')", on_chunk)
    finally:
        await kernel.shutdown()
    assert any("hi" in c for c in chunks)


async def test_execute_stream_final_payload_carries_table(tmp_path):
    kernel = _make_python_kernel(tmp_path)
    try:
        out = await kernel.execute_stream(
            "import pandas as pd\nresult = pd.DataFrame({'a': [1, 2]})",
            lambda kind, data: None,
        )
    finally:
        await kernel.shutdown()
    assert out.table == {"headers": ["a"], "rows": [["1"], ["2"]]}


async def test_execute_stream_keeps_variables_between_runs(tmp_path):
    kernel = _make_python_kernel(tmp_path)
    collected: list[str] = []
    try:
        await kernel.execute_stream("a = 40", lambda k, d: None)
        await kernel.execute_stream("print(a + 2)", lambda k, d: collected.append(d))
    finally:
        await kernel.shutdown()
    assert any("42" in c for c in collected)


async def test_interrupt_stops_run_and_kernel_survives(tmp_path):
    """SIGINT (Ctrl+C) breaks a long-running loop and the kernel stays alive for
    the next command — the terminal interruption contract."""
    kernel = _make_python_kernel(tmp_path)
    try:
        started = asyncio.Event()
        chunks: list[str] = []

        def on_chunk(kind: str, data: str) -> None:
            chunks.append(data)
            if "started" in data:
                started.set()

        run = asyncio.create_task(
            kernel.execute_stream(
                "import time\nprint('started', flush=True)\n"
                "for _ in range(1000):\n    time.sleep(0.05)",
                on_chunk,
            )
        )
        await asyncio.wait_for(started.wait(), timeout=10)
        assert kernel.interrupt() is True
        await asyncio.wait_for(run, timeout=10)
        # In stream mode the interrupt notice arrives as a stderr chunk, not in
        # the done payload (whose stdout/stderr are empty while streaming).
        assert any("KeyboardInterrupt" in c for c in chunks)

        # Kernel still usable after the interrupt.
        collected: list[str] = []
        await kernel.execute_stream("print(7 * 6)", lambda k, d: collected.append(d))
        assert any("42" in c for c in collected)
    finally:
        await kernel.shutdown()


async def test_interrupt_no_live_process_returns_false(tmp_path):
    kernel = _make_python_kernel(tmp_path)
    assert kernel.interrupt() is False
