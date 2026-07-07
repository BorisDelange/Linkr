"""Server-side Python execution endpoint (POST /execute)."""

API = "/api/v1"


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


async def test_execute_unsupported_language_is_400(client):
    headers = await _admin_headers(client)
    r = await _run(client, headers, "1", language="julia")
    assert r.status_code == 400


async def test_execute_requires_auth(client):
    r = await client.post(f"{API}/execute", json={"language": "python", "code": "print(1)"})
    assert r.status_code == 401
