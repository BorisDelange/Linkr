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


async def _project(client, headers) -> str:
    """Create a real (workspace-less) project and return its uid. Execution
    endpoints require the project to exist (access derives from it), so kernel
    tests can't use a made-up uid."""
    r = await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}})
    return r.json()["uid"]


async def _run(client, headers, code: str, language: str = "python", project: str | None = None):
    """Run code in a project context. /execute now refuses context-less runs, so
    tests that don't care about a specific project get a throwaway one."""
    if project is None:
        project = await _project(client, headers)
    return await client.post(
        f"{API}/execute",
        headers=headers,
        json={"language": language, "code": code, "projectUid": project},
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


async def test_execute_trailing_expression_dataframe_becomes_table(client):
    """A DataFrame as the LAST expression (no `result =`) is captured like a REPL
    auto-print — so `df` on the final line shows a table."""
    headers = await _admin_headers(client)
    r = await _run(client, headers, "import pandas as pd\npd.DataFrame({'a': [1, 2]})")
    assert r.json()["table"] == {"headers": ["a"], "rows": [["1"], ["2"]]}


async def test_execute_repr_html_object_captured_as_html(client):
    """An object whose last-expression value has _repr_html_ (plotly/leaflet/DT all
    do) is captured as an HTML widget for the iframe tab."""
    headers = await _admin_headers(client)
    code = (
        "class W:\n"
        "    def _repr_html_(self):\n"
        "        return '<div id=widget>hello widget</div>'\n"
        "W()"
    )
    r = await _run(client, headers, code)
    body = r.json()
    assert body["html"] and "hello widget" in body["html"]


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
    uid = await _project(client, headers)
    body1 = {"language": "python", "code": "a = 40\na = a + 2", "projectUid": uid}
    assert (await client.post(f"{API}/execute", headers=headers, json=body1)).status_code == 200
    # A second run in the same project/env sees `a` from the first.
    body2 = {"language": "python", "code": "print(a)", "projectUid": uid}
    r = await client.post(f"{API}/execute", headers=headers, json=body2)
    assert r.json()["stdout"].strip() == "42"


async def _wait_job(client, headers, uid, job_id, timeout=30.0):
    """Poll a project's jobs until `job_id` leaves queued/running (or times out)."""
    for _ in range(int(timeout / 0.2)):
        jobs = (await client.get(f"{API}/projects/{uid}/jobs", headers=headers)).json()
        job = next((j for j in jobs if j["id"] == job_id), None)
        if job and job["status"] not in ("queued", "running"):
            return job
        await asyncio.sleep(0.2)
    raise AssertionError("job did not finish in time")


async def test_run_as_job_batch_captures_output_and_result(client):
    """Run-as-job runs in a fresh process, streams stdout to the job log, and stores
    a result table on the finished job — surfaced in the jobs panel."""
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    code = "import pandas as pd\nprint('batch ran')\nresult = pd.DataFrame({'x': [1, 2]})"
    r = await client.post(
        f"{API}/execute/run-as-job",
        headers=headers,
        json={"language": "python", "code": code, "projectUid": uid, "label": "run.py"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "run"
    assert body["label"] == "run.py"

    job = await _wait_job(client, headers, uid, body["id"])
    assert job["status"] == "done", job.get("logTail")
    assert "batch ran" in job["logTail"]
    # The DataFrame result was collected as a table artifact on the job.
    assert job["result"]["table"]["headers"] == ["x"]


async def test_run_as_job_fresh_process_no_session_namespace(client):
    """A batch run does NOT see the interactive session's variables (fresh process)."""
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    # Set a variable in the interactive kernel.
    await client.post(f"{API}/execute", headers=headers, json={"language": "python", "code": "z = 99", "projectUid": uid})
    # The batch job runs in a fresh namespace → NameError on z.
    r = await client.post(
        f"{API}/execute/run-as-job",
        headers=headers,
        json={"language": "python", "code": "print(z)", "projectUid": uid},
    )
    job = await _wait_job(client, headers, uid, r.json()["id"])
    assert "NameError" in job["logTail"] or "not defined" in job["logTail"]


async def test_execute_large_output_not_truncated_or_500(client):
    """A result line larger than asyncio's default 64 KB StreamReader limit must
    read fully (raised limit), not raise LimitOverrunError → 500."""
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    body = {"language": "python", "code": "print('x' * 200000)", "projectUid": uid}
    r = await client.post(f"{API}/execute", headers=headers, json=body)
    assert r.status_code == 200
    assert len(r.json()["stdout"]) >= 200000


async def test_kernel_recovers_from_dead_subprocess(client):
    """A crashed/killed kernel subprocess must not poison future runs: the next
    execute restarts it (broken-pipe retry) instead of returning a 500."""
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    body = {"language": "python", "code": "print('ok')", "projectUid": uid}
    assert (await client.post(f"{API}/execute", headers=headers, json=body)).status_code == 200
    # Kill the live kernel's subprocess out from under it, leaving a dead pipe.
    # The kernel is keyed by user too now, so grab the one live kernel from the
    # registry instead of guessing the key.
    from app.services.execution.kernel import manager
    k = next(iter(manager._kernels.values()))  # noqa: SLF001 — test reaches in
    if k._proc is not None:  # noqa: SLF001 — test reaches into the kernel to simulate a crash
        k._proc.kill()
        await k._proc.wait()
    # Next run should transparently restart and succeed, not 500.
    r = await client.post(f"{API}/execute", headers=headers, json=body)
    assert r.status_code == 200
    assert r.json()["stdout"].strip() == "ok"


async def test_kernels_isolated_per_session(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    await client.post(f"{API}/execute", headers=headers,
                      json={"language": "python", "code": "x = 1", "projectUid": uid, "sessionId": "e1"})
    r = await client.post(f"{API}/execute", headers=headers,
                          json={"language": "python", "code": "print(x)", "projectUid": uid, "sessionId": "e2"})
    assert "NameError" in r.json()["stderr"]


async def test_restart_clears_kernel_state(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    await client.post(f"{API}/execute", headers=headers,
                      json={"language": "python", "code": "z = 99", "projectUid": uid})
    assert (await client.post(f"{API}/execute/restart", headers=headers,
            json={"language": "python", "projectUid": uid})).status_code == 204
    r = await client.post(f"{API}/execute", headers=headers,
                          json={"language": "python", "code": "print(z)", "projectUid": uid})
    assert "NameError" in r.json()["stderr"]


@requires_r
async def test_persistent_r_kernel_keeps_variables(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    await client.post(f"{API}/execute", headers=headers,
                      json={"language": "r", "code": "y <- 41; y <- y + 1", "projectUid": uid})
    r = await client.post(f"{API}/execute", headers=headers,
                          json={"language": "r", "code": "print(y)", "projectUid": uid})
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
    # Columns are resolved lazily via /meta (the listing carries none).
    meta = (await client.get(f"{API}/dataset-files/meta", headers=headers,
                             params={"projectUid": project_uid, "path": path})).json()
    age_col = next(c["id"] for c in meta["columns"] if c["name"] == "age")
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
    uid = await _project(client, headers)
    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python", "code": "1", "datasetFileId": "nope", "projectUid": uid,
    })
    assert r.status_code == 404


async def test_render_table1_produces_table1data(client):
    """POST /execute/render runs the server-owned table1 program from a spec (no
    client code) and returns the same Table1Data shape the component consumes."""
    headers = await _admin_headers(client)
    project_uid, path = await _disk_dataset(client, headers)  # cols: age (num), grp
    # Mirrors buildTable1Spec (table1-server.ts): `group` is {name, label} and the
    # labels travel in the spec, because they can come from a locale the server
    # does not know and both ends must print the same words.
    r = await client.post(f"{API}/execute/render", headers=headers, json={
        "kind": "table1",
        "spec": {
            "selected": [{"name": "age", "label": "Age", "numeric": True}],
            "group": {"name": "grp", "label": "Group"},
            "stat": "mean_sd",
            "showMissing": False,
            "missingLabel": "Missing",
            "maxLevels": 10,
            "othersLabel": "Others",
        },
        "projectUid": project_uid, "datasetFileId": path,
    })
    assert r.status_code == 200, r.text
    import json
    data = json.loads(r.json()["stdout"].strip())
    assert data["groups"] == ["a", "b"]
    assert data["groupSizes"] == {"a": 1, "b": 1}
    # The row prints the label from the spec, and carries one cell per group.
    assert data["rows"][0]["label"] == "Age"
    assert len(data["rows"][0]["cells"]) == len(data["groups"])


async def test_render_correlation_matrix_end_to_end(client):
    """A second kind through the real kernel (scipy) — proves the render path is
    generic, not table1-specific."""
    from app.services import project_fs

    headers = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    (project_fs.datasets_dir(uid) / "d.csv").write_text("a,b\n1,2\n2,4\n3,6\n4,8\n")
    r = await client.post(f"{API}/execute/render", headers=headers, json={
        "kind": "correlation-matrix",
        "spec": {"names": ["a", "b"], "method": "pearson"},
        "projectUid": uid, "datasetFileId": "d.csv",
    })
    assert r.status_code == 200, r.text
    import json
    data = json.loads(r.json()["stdout"].strip())
    assert data["names"] == ["a", "b"]
    # a and b are perfectly correlated (b = 2a) → r ≈ 1.
    assert data["matrix"][0][1]["r"] > 0.999


async def test_render_rejects_unknown_kind(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    r = await client.post(f"{API}/execute/render", headers=headers, json={
        "kind": "totally-not-a-render", "spec": {}, "projectUid": uid,
    })
    assert r.status_code == 400


async def test_render_rejects_malformed_spec(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    r = await client.post(f"{API}/execute/render", headers=headers, json={
        "kind": "table1", "spec": {"selected": "not-a-list"}, "projectUid": uid,
    })
    assert r.status_code == 400


async def test_execute_refuses_purpose_render_with_free_code(client):
    """The old hole: a viewer could run arbitrary code under purpose='render'
    (viewer-gated). /execute must now refuse render entirely — renders go through
    /execute/render (server-owned code), never as free-form code here."""
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python", "code": "print('should not run')",
        "projectUid": uid, "purpose": "render",
    })
    assert r.status_code == 400
    # The code must not have executed.
    assert "should not run" not in r.text


async def test_sql_query_bridge_runs_via_host(client, monkeypatch):
    headers = await _admin_headers(client)
    # Stub the data-source layer so no real DB is needed: any connection_id
    # resolves to a fake source, and query() returns canned rows.
    from app.services import data_source_service

    uid = await _project(client, headers)

    class _FakeSource:
        workspace_id = None  # workspace-less → access check skipped

    async def fake_get(db, source_id):
        return _FakeSource()

    async def fake_query(db, source, sql):
        assert "person" in sql
        return [{"id": 1, "name": "alice"}, {"id": 2, "name": "bob"}]

    monkeypatch.setattr(data_source_service, "get", fake_get)
    monkeypatch.setattr(data_source_service, "query", fake_query)

    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python",
        "code": "df = sql_query('SELECT * FROM person')\nprint(df['name'].tolist())",
        "projectUid": uid, "connectionId": "conn-1",
    })
    assert r.status_code == 200
    assert "alice" in r.json()["stdout"] and "bob" in r.json()["stdout"]


@requires_r
async def test_sql_query_bridge_runs_via_host_r(client, monkeypatch):
    """R reaches the host through the same RPC as Python. The R kernel runs user
    code under capture.output(), so this also guards that the request escapes the
    capture instead of landing in the run's stdout (which would hang the kernel)."""
    headers = await _admin_headers(client)
    from app.services import data_source_service

    uid = await _project(client, headers)

    class _FakeSource:
        workspace_id = None

    async def fake_get(db, source_id):
        return _FakeSource()

    async def fake_query(db, source, sql):
        assert "person" in sql
        return [{"id": 1, "name": "alice"}, {"id": 2, "name": "bob"}]

    monkeypatch.setattr(data_source_service, "get", fake_get)
    monkeypatch.setattr(data_source_service, "query", fake_query)

    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "r",
        "code": "df <- sql_query('SELECT * FROM person')\ncat(nrow(df), paste(df$name, collapse=','), '\\n')",
        "projectUid": uid, "connectionId": "conn-1",
    })
    assert r.status_code == 200
    out = r.json()["stdout"]
    assert "2" in out and "alice" in out and "bob" in out


@requires_r
async def test_sql_query_r_null_becomes_na(client, monkeypatch):
    """A SQL NULL must keep its column's length (NA), not collapse the column."""
    headers = await _admin_headers(client)
    from app.services import data_source_service

    uid = await _project(client, headers)

    class _FakeSource:
        workspace_id = None

    async def fake_get(db, source_id):
        return _FakeSource()

    async def fake_query(db, source, sql):
        return [{"a": 1}, {"a": None}]

    monkeypatch.setattr(data_source_service, "get", fake_get)
    monkeypatch.setattr(data_source_service, "query", fake_query)

    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "r",
        "code": "df <- sql_query('SELECT a FROM t')\ncat(nrow(df), sum(is.na(df$a)), '\\n')",
        "projectUid": uid, "connectionId": "conn-1",
    })
    assert r.status_code == 200
    assert "2 1" in r.json()["stdout"]


@requires_r
async def test_sql_query_without_connection_errors_in_kernel_r(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "r",
        "code": "sql_query('SELECT 1')",
        "projectUid": uid,
    })
    assert r.status_code == 200
    assert "connection" in r.json()["stderr"].lower()


async def test_sql_query_without_connection_errors_in_kernel(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python",
        "code": "sql_query('SELECT 1')",
        "projectUid": uid,
    })
    # No connection -> the RPC resolver returns an error the kernel raises -> stderr.
    assert r.status_code == 200
    assert "connection" in r.json()["stderr"].lower()


async def test_list_kernels_reports_live_sessions(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    # No kernels yet for this project.
    r = await client.get(f"{API}/execute/kernels?projectUid={uid}", headers=headers)
    assert r.json() == []
    # Running code spins one up; it then shows as alive.
    await client.post(f"{API}/execute", headers=headers,
                      json={"language": "python", "code": "1", "projectUid": uid})
    r = await client.get(f"{API}/execute/kernels?projectUid={uid}", headers=headers)
    kernels = r.json()
    assert len(kernels) == 1
    assert kernels[0]["language"] == "python" and kernels[0]["alive"] is True


async def test_run_without_project_is_refused(client):
    """Context-less execution has no workspace/project scope, so it's rejected
    (guards against any authenticated account running arbitrary server code)."""
    headers = await _admin_headers(client)
    r = await client.post(
        f"{API}/execute", headers=headers, json={"language": "python", "code": "b = 7"}
    )
    assert r.status_code == 400


async def test_execute_unsupported_language_is_400(client):
    headers = await _admin_headers(client)
    r = await _run(client, headers, "1", language="julia")
    assert r.status_code == 400


async def test_execute_requires_auth(client):
    r = await client.post(f"{API}/execute", json={"language": "python", "code": "print(1)"})
    assert r.status_code == 401


async def test_execute_forbidden_without_project_membership(client):
    """A user who is not a member of the project's workspace cannot run code in it
    (nor spin up / list / restart its kernel). Guards cross-project code execution."""
    admin = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(
        f"{API}/projects", headers=admin, json={"name": {"en": "P"}, "workspaceId": ws}
    )).json()["uid"]

    await client.post(f"{API}/users", headers=admin,
                      json={"username": "mallory", "password": "pw", "role": "user"})
    r = await client.post(f"{API}/auth/login", json={"username": "mallory", "password": "pw"})
    mallory = {"Authorization": f"Bearer {r.json()['access_token']}"}

    run = await client.post(f"{API}/execute", headers=mallory,
                            json={"language": "python", "code": "print(1)", "projectUid": uid})
    assert run.status_code == 403
    assert (await client.get(f"{API}/execute/kernels?projectUid={uid}", headers=mallory)).status_code == 403
    assert (await client.post(f"{API}/execute/restart", headers=mallory,
            json={"language": "python", "projectUid": uid})).status_code == 403


async def test_code_execution_requires_write_not_just_read(client):
    """A viewer can see the project but cannot run code (ide:execute is an
    editor+ permission); an editor can."""
    admin = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(
        f"{API}/projects", headers=admin, json={"name": {"en": "P"}, "workspaceId": ws}
    )).json()["uid"]
    await client.post(f"{API}/users", headers=admin,
                      json={"username": "val", "password": "pw", "role": "user"})
    val_id = (await client.get(f"{API}/users", headers=admin)).json()
    val_id = next(u["id"] for u in val_id if u["username"] == "val")
    val = {"Authorization": f"Bearer {(await client.post(f'{API}/auth/login', json={'username': 'val', 'password': 'pw'})).json()['access_token']}"}

    # Viewer: no code execution.
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": val_id, "role": "viewer"})
    assert (await client.post(f"{API}/execute", headers=val,
            json={"language": "python", "code": "print(1)", "projectUid": uid})).status_code == 403

    # Editor: allowed.
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": val_id, "role": "editor"})
    assert (await client.post(f"{API}/execute", headers=val,
            json={"language": "python", "code": "print(1)", "projectUid": uid})).status_code == 200


async def test_render_execute_gated_per_resource(client):
    """A render purpose maps to <resource>:execute (running R/Python) — an editor
    holds it, a viewer does NOT (a viewer sees only code-less widgets)."""
    admin = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(
        f"{API}/projects", headers=admin, json={"name": {"en": "P"}, "workspaceId": ws}
    )).json()["uid"]
    await client.post(f"{API}/users", headers=admin,
                      json={"username": "val", "password": "pw", "role": "user"})
    val_id = next(u["id"] for u in (await client.get(f"{API}/users", headers=admin)).json() if u["username"] == "val")
    val = {"Authorization": f"Bearer {(await client.post(f'{API}/auth/login', json={'username': 'val', 'password': 'pw'})).json()['access_token']}"}

    # Viewer: no code execution (IDE / code-backed widget). A built-in component
    # render is a view op, but it must go through /execute/render (server-owned
    # code) — NOT /execute with free-form code, which is now refused for render.
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": val_id, "role": "viewer"})
    assert (await client.post(f"{API}/execute", headers=val,
            json={"language": "python", "code": "print(1)", "projectUid": uid})).status_code == 403
    assert (await client.post(f"{API}/execute", headers=val,
            json={"language": "python", "code": "print(1)", "projectUid": uid, "purpose": "dashboards"})).status_code == 403
    # purpose="render" on /execute is refused outright (closes the viewer-RCE hole).
    assert (await client.post(f"{API}/execute", headers=val,
            json={"language": "python", "code": "print(1)", "projectUid": uid, "purpose": "render"})).status_code == 400
    # The viewer CAN render via the spec endpoint (server owns the code).
    assert (await client.post(f"{API}/execute/render", headers=val, json={
        "kind": "table1", "spec": {"selected": [], "group": None, "metrics": []},
        "projectUid": uid})).status_code == 200

    # Editor: holds dashboards:execute (and ide:execute) → both allowed.
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": val_id, "role": "editor"})
    assert (await client.post(f"{API}/execute", headers=val,
            json={"language": "python", "code": "print(1)", "projectUid": uid, "purpose": "dashboards"})).status_code == 200


# --- Streaming core (execute_stream) -------------------------------------------
# These exercise the Kernel directly: the terminal (§07d) streams output chunk by
# chunk, while the batch execute() wrapper (covered by the tests above) proves the
# legacy one-shot contract still holds on the same code path.


def _make_python_kernel(tmp_path):
    import sys

    from app.services.execution.kernel import Kernel, _PY_KERNEL_LOOP

    return Kernel([sys.executable, "-c", _PY_KERNEL_LOOP], cwd=str(tmp_path))


async def test_execute_stream_emits_chunks_before_done(tmp_path):
    """Output produced OVER TIME must arrive as separate stdout chunks, in order,
    before the final RuntimeOutput — not buffered into one blob at the end.

    The separation that matters is temporal, not per-line: writes issued back to back
    are coalesced on purpose (print() calls write() once per line, so a large frame
    would otherwise cost one websocket frame per row). The sleeps here are what make
    each print a distinct event, which is exactly what a REPL user perceives."""
    kernel = _make_python_kernel(tmp_path)
    chunks: list[tuple[str, str]] = []
    try:
        out = await kernel.execute_stream(
            "import time\nfor i in range(3):\n    print(i)\n    time.sleep(0.2)",
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


async def test_execute_stream_coalesces_a_burst(tmp_path):
    """A burst of lines is delivered whole, not one message per line: sql_query on a
    large table took longer to display than to run, at one JSON encode, one flush and
    one websocket frame per row."""
    kernel = _make_python_kernel(tmp_path)
    chunks: list[tuple[str, str]] = []
    try:
        await kernel.execute_stream(
            "for i in range(500):\n    print(i)",
            lambda kind, data: chunks.append((kind, data)),
        )
    finally:
        await kernel.shutdown()
    stdout_chunks = [c for c in chunks if c[0] == "stdout"]
    assert len(stdout_chunks) < 50, f"500 lines sent as {len(stdout_chunks)} messages"
    # Nothing is dropped by the coalescing.
    joined = "".join(d for _, d in stdout_chunks)
    assert joined.count("\n") == 500


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


def _make_r_kernel(tmp_path):
    from app.services.execution.kernel import Kernel, _R_KERNEL_LOOP
    from app.services import project_fs

    # Run the loop from a file, exactly as _make() does: `Rscript -e` silently
    # truncates a program this long, which hangs the kernel at boot.
    loop_path = project_fs.kernel_r_script(_R_KERNEL_LOOP)
    return Kernel(["Rscript", "--vanilla", str(loop_path)], cwd=str(tmp_path))


@requires_r
async def test_r_kernel_only_prints_visible_values(tmp_path):
    """The R kernel auto-prints like the REPL: invisible-returning expressions
    (assignment, for loops, invisible()) print nothing; a bare value prints. This
    guards the regression where every expression's value was force-printed, which
    leaked the injected dataset preamble's intermediate values into widget output."""
    kernel = _make_r_kernel(tmp_path)
    chunks: list[str] = []
    try:
        out = await kernel.execute_stream(
            "x <- 3\n"                       # assignment → invisible, no print
            "for (i in 1:2) i\n"             # for loop → invisible, no print
            "invisible(99)\n"                # invisible() → no print
            "x + 1\n",                       # bare value → prints "[1] 4"
            lambda k, d: chunks.append(d),
        )
    finally:
        await kernel.shutdown()
    text = "".join(chunks) + out.stdout
    assert "[1] 4" in text        # the visible value printed
    assert "[1] 3" not in text    # the assignment did NOT print its value


@requires_r
async def test_parallel_r_kernels_do_not_clobber_each_others_figures(tmp_path):
    """Two R kernels sharing the SAME working directory each keep their own figure.

    svglite writes figures to files; the kernel used a fixed name in the cwd, so
    parallel dashboard widgets (all in the project's shared cwd, all at run #1)
    overwrote/deleted each other's SVG — only one widget's plot survived. Figures
    now go to a process-unique tempdir. Same cwd here reproduces the old collision."""
    import asyncio as _asyncio

    plot = ("suppressPackageStartupMessages(library(ggplot2))\n"
            "ggplot(data.frame(x=1:3, y=1:3), aes(x, y)) + geom_line()")

    async def run_one():
        k = _make_r_kernel(tmp_path)  # SAME tmp_path → shared cwd
        try:
            return await k.execute(plot)
        finally:
            await k.shutdown()

    outs = await _asyncio.gather(*(run_one() for _ in range(4)))
    # Every parallel run must have produced its own figure — not 1 winner + 3 blanks.
    assert all(len(o.figures) == 1 for o in outs), [len(o.figures) for o in outs]


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


# --- Bash PTY shell (terminal §07d) --------------------------------------------


async def _drain_until(shell, needle: str, timeout: float = 10.0) -> str:
    """Read PTY output until `needle` appears (or timeout). Returns all seen text."""
    seen = ""
    async def _loop():
        nonlocal seen
        while needle not in seen:
            data = await shell.read()
            if not data:
                return
            seen += data.decode("utf-8", "replace")
    await asyncio.wait_for(_loop(), timeout=timeout)
    return seen


async def test_pty_shell_runs_a_command(tmp_path):
    from app.services.execution.pty_kernel import PtyShell

    shell = PtyShell(str(tmp_path))
    await shell.start()
    try:
        shell.write(b"echo linkr-pty-ok\n")
        out = await _drain_until(shell, "linkr-pty-ok")
        assert "linkr-pty-ok" in out
    finally:
        shell.shutdown()


async def test_pty_shell_starts_in_given_cwd(tmp_path):
    from app.services.execution.pty_kernel import PtyShell

    marker = tmp_path / "marker_dir"
    marker.mkdir()
    shell = PtyShell(str(tmp_path))
    await shell.start()
    try:
        shell.write(b"ls\n")
        out = await _drain_until(shell, "marker_dir")
        assert "marker_dir" in out
    finally:
        shell.shutdown()


async def test_pty_shell_dies_after_shutdown(tmp_path):
    from app.services.execution.pty_kernel import PtyShell

    shell = PtyShell(str(tmp_path))
    await shell.start()
    assert shell.alive is True
    shell.shutdown()
    assert shell.alive is False


# --- WebSocket auth (terminal §07d) --------------------------------------------


class _FakeWebSocket:
    """Minimal WebSocket double: query params in, records the close code."""

    def __init__(self, params: dict[str, str]):
        self.query_params = params
        self.closed_code: int | None = None

    async def close(self, code: int) -> None:
        self.closed_code = code


async def test_ws_auth_accepts_valid_access_token(client):
    from app.core.ws_auth import authenticate_ws

    # Create a real user via setup, then mint an access token for them.
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    login = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    token = login.json()["access_token"]

    ws = _FakeWebSocket({"token": token})
    user = await authenticate_ws(ws)
    assert user is not None and user.username == "admin"
    assert ws.closed_code is None


async def test_ws_auth_rejects_missing_token(client):
    from app.core.ws_auth import authenticate_ws, WS_AUTH_FAILED

    ws = _FakeWebSocket({})
    assert await authenticate_ws(ws) is None
    assert ws.closed_code == WS_AUTH_FAILED


async def test_ws_auth_rejects_refresh_token(client):
    from app.core.security import create_refresh_token
    from app.core.ws_auth import authenticate_ws, WS_AUTH_FAILED

    ws = _FakeWebSocket({"token": create_refresh_token(1, "admin", "admin")})
    assert await authenticate_ws(ws) is None
    assert ws.closed_code == WS_AUTH_FAILED


async def test_ws_auth_rejects_garbage_token(client):
    from app.core.ws_auth import authenticate_ws, WS_AUTH_FAILED

    ws = _FakeWebSocket({"token": "not-a-jwt"})
    assert await authenticate_ws(ws) is None
    assert ws.closed_code == WS_AUTH_FAILED


async def test_pty_manager_caps_sessions_per_user(monkeypatch):
    """Each terminal shell is an OS process; a user can't exceed
    max_kernels_per_user concurrent shells, but the cap is per-user and a
    closed session frees a slot."""
    from app.config import settings
    from app.services.execution.pty_kernel import PtyManager, SessionLimitReached

    monkeypatch.setattr(settings, "max_kernels_per_user", 2)
    m = PtyManager()
    try:
        await m.create("p", "s1", user_id=1)
        await m.create("p", "s2", user_id=1)
        with pytest.raises(SessionLimitReached):
            await m.create("p", "s3", user_id=1)
        # A different user has an independent quota.
        await m.create("p", "s4", user_id=2)
        # Freeing a slot lets user 1 open another.
        m.close("p", "s1")
        await m.create("p", "s5", user_id=1)
    finally:
        m.shutdown_all()
