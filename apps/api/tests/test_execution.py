"""Server-side R/Python execution endpoint (POST /execute)."""

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


async def test_execute_injects_dataset_python(client):
    headers = await _admin_headers(client)
    project_uid, ds_id = await _import_dataset(client, headers)
    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python", "code": "print(list(dataset.columns)); print(float(dataset['age'].mean()))",
        "projectUid": project_uid, "datasetFileId": ds_id,
    })
    assert r.status_code == 200
    out = r.json()["stdout"]
    assert "age" in out and "grp" in out and "35" in out


async def test_execute_injects_filtered_dataset(client):
    headers = await _admin_headers(client)
    project_uid, ds_id = await _import_dataset(client, headers)  # age: 30, 40
    # Filters are keyed by the parser's generated column id.
    ds = (await client.get(f"{API}/datasets/{ds_id}", headers=headers)).json()
    age_col = next(c["id"] for c in ds["columns"] if c["name"] == "age")
    # Keep only age >= 35 -> one row (age 40).
    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python",
        "code": "print(len(dataset))",
        "projectUid": project_uid, "datasetFileId": ds_id,
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
