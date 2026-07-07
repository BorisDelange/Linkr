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
