"""Stored code that runs on its own needs the running user's own acceptance.

The app starts dashboard widgets, dataset analyses and patient-board plugins by
itself when a page opens. Whatever wrote that code (an import, a colleague, an API
key), the server refuses the run until this user, in a web session, has accepted
exactly this text.
"""

import pytest

from app.api.v1.routes import execution as execution_routes
from app.services.execution import injection, runtime
from app.services.execution import kernel as kernel_module

API = "/api/v1"
CODE = "print('from a stored widget')"
AUTO_PURPOSES = ("dashboards", "datasets", "patient-data")


async def _login(client, username: str) -> dict:
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    return await _login(client, "admin")


async def _project(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    return (await client.post(
        f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws},
    )).json()["uid"]


async def _editor(client, admin: dict, project_uid: str, username: str) -> dict:
    ws = (await client.get(f"{API}/projects/{project_uid}", headers=admin)).json()["workspaceId"]
    await client.post(f"{API}/users", headers=admin,
                      json={"username": username, "password": "pw-for-tests-only", "role": "user"})
    user_id = next(u["id"] for u in (await client.get(f"{API}/users", headers=admin)).json() if u["username"] == username)
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": user_id, "role": "editor"})
    return await _login(client, username)


def _run(project_uid: str, purpose: str = "dashboards", code: str = CODE, **extra) -> dict:
    return {"language": "python", "code": code, "projectUid": project_uid, "purpose": purpose, "ephemeral": True, **extra}


@pytest.fixture
def ran(monkeypatch) -> list[str]:
    """The code that reached an interpreter, with no interpreter behind it."""
    calls: list[str] = []
    output = runtime.RuntimeOutput(stdout="ok", stderr="", figures=[], table=None, html=None)

    async def run_ephemeral(language, project_uid, code, environment=None, resolver=None):
        calls.append(code)
        return output

    class FakeKernel:
        async def execute(self, code, query_resolver=None):
            calls.append(code)
            return output

    async def get_kernel(*args, **kwargs):
        return FakeKernel()

    async def ensure_ready(*args, **kwargs):
        return None

    monkeypatch.setattr(kernel_module, "run_ephemeral", run_ephemeral)
    monkeypatch.setattr(kernel_module.manager, "get", get_kernel)
    monkeypatch.setattr(execution_routes.environments, "ensure_ready", ensure_ready)
    return calls


@pytest.mark.parametrize("purpose", AUTO_PURPOSES)
async def test_code_that_runs_on_its_own_waits_for_acceptance(client, ran, purpose):
    admin = await _admin(client)
    uid = await _project(client, admin)

    refused = await client.post(f"{API}/execute", headers=admin, json=_run(uid, purpose))
    assert refused.status_code == 428
    assert refused.json()["detail"]["code"] == "code_acceptance_required"
    assert ran == []

    assert (await client.post(f"{API}/code-acceptances", headers=admin, json={"codes": [CODE]})).status_code == 204
    assert (await client.post(f"{API}/execute", headers=admin, json=_run(uid, purpose))).status_code == 200
    assert ran == [CODE]


async def test_a_background_job_holds_to_the_same_gate(client, ran):
    admin = await _admin(client)
    uid = await _project(client, admin)
    refused = await client.post(f"{API}/execute/run-as-job", headers=admin, json=_run(uid))
    assert refused.status_code == 428


async def test_any_change_to_the_code_asks_again(client, ran):
    admin = await _admin(client)
    uid = await _project(client, admin)
    await client.post(f"{API}/code-acceptances", headers=admin, json={"codes": [CODE]})
    changed = await client.post(f"{API}/execute", headers=admin, json=_run(uid, code=CODE + "\nprint(2)"))
    assert changed.status_code == 428
    assert ran == []


async def test_an_acceptance_binds_only_the_user_who_gave_it(client, ran):
    admin = await _admin(client)
    uid = await _project(client, admin)
    other = await _editor(client, admin, uid, "other")
    await client.post(f"{API}/code-acceptances", headers=admin, json={"codes": [CODE]})
    assert (await client.post(f"{API}/execute", headers=other, json=_run(uid))).status_code == 428
    assert ran == []


async def test_an_explicit_ide_run_is_not_gated(client, ran):
    admin = await _admin(client)
    uid = await _project(client, admin)
    assert (await client.post(f"{API}/execute", headers=admin, json=_run(uid, "ide"))).status_code == 200
    assert ran == [CODE]


async def test_an_unknown_purpose_is_gated_rather_than_treated_as_the_ide(client, ran):
    admin = await _admin(client)
    uid = await _project(client, admin)
    assert (await client.post(f"{API}/execute", headers=admin, json=_run(uid, "something-new"))).status_code == 428
    assert ran == []


async def test_an_api_key_can_never_accept_code(client, ran):
    """An agent holds its user's key: its acceptance would be no one having seen it."""
    admin = await _admin(client)
    uid = await _project(client, admin)
    token = (await client.post(f"{API}/auth/api-tokens", headers=admin, json={"name": "agent"})).json()["token"]
    key = {"Authorization": f"Bearer {token}"}

    assert (await client.post(f"{API}/code-acceptances", headers=key, json={"codes": [CODE]})).status_code == 401
    assert (await client.post(f"{API}/execute", headers=admin, json=_run(uid))).status_code == 428
    assert (await client.post(f"{API}/execute", headers=key, json=_run(uid))).status_code == 428
    assert ran == []


async def test_a_kernel_token_can_never_accept_code(client, ran):
    """Code already running must not be able to clear the way for other code."""
    from app.core.security import create_kernel_token

    admin = await _admin(client)
    uid = await _project(client, admin)
    me = (await client.get(f"{API}/auth/me", headers=admin)).json()
    token = create_kernel_token(me["id"], me["username"], me["role"], uid, via="web")
    kernel = {"Authorization": f"Bearer {token}"}

    assert (await client.post(f"{API}/code-acceptances", headers=kernel, json={"codes": [CODE]})).status_code == 401
    assert (await client.post(f"{API}/execute", headers=admin, json=_run(uid))).status_code == 428


async def test_code_stored_by_a_member_without_ide_execute_stays_unrun_on_another_member(client, ran):
    """Storing a plugin takes plugins:write alone. What that member wrote reaches an
    interpreter under another account only after that account accepted it."""
    admin = await _admin(client)
    uid = await _project(client, admin)
    ws = (await client.get(f"{API}/projects/{uid}", headers=admin)).json()["workspaceId"]
    viewer = next(r for r in (await client.get(f"{API}/roles", headers=admin)).json() if r["name"] == "viewer")
    assert (await client.patch(f"{API}/roles/{viewer['id']}", headers=admin, json={
        "permissions": [*viewer["permissions"], "plugins:write"],
    })).status_code == 200
    await client.post(f"{API}/users", headers=admin,
                      json={"username": "pat", "password": "pw-for-tests-only", "role": "user"})
    pat_id = next(u["id"] for u in (await client.get(f"{API}/users", headers=admin)).json() if u["username"] == "pat")
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": pat_id, "role": "viewer"})
    pat = await _login(client, "pat")
    template = "print('stored by a member')"
    stored = await client.post(f"{API}/user-plugins", headers=pat, json={
        "id": "00000000-0000-4000-8000-000000000001", "workspaceId": ws,
        "files": {"plugin.json": "{}", "analysis.py.template": template},
    })
    assert stored.status_code < 300

    victim = await _editor(client, admin, uid, "victim")
    assert (await client.post(f"{API}/execute", headers=victim, json=_run(uid, "patient-data", template))).status_code == 428
    assert ran == []

    # Pat cannot run anything, and accepting does not widen what Pat may do.
    assert (await client.post(f"{API}/code-acceptances", headers=pat, json={"codes": [template]})).status_code == 204
    assert (await client.post(f"{API}/execute", headers=pat, json=_run(uid, "patient-data", template))).status_code == 403
    assert (await client.post(f"{API}/execute", headers=victim, json=_run(uid, "patient-data", template))).status_code == 428
    assert ran == []


async def test_check_says_whether_this_user_accepted_a_text(client):
    admin = await _admin(client)
    url = f"{API}/code-acceptances/check"
    assert (await client.post(url, headers=admin, json={"code": CODE})).json() == {"accepted": False}
    await client.post(f"{API}/code-acceptances", headers=admin, json={"codes": [CODE, CODE]})
    await client.post(f"{API}/code-acceptances", headers=admin, json={"codes": [CODE]})
    assert (await client.post(url, headers=admin, json={"code": CODE})).json() == {"accepted": True}


async def test_a_new_patient_needs_no_new_acceptance_and_its_id_stays_data(client, ran):
    """The run's context changes with each patient: it is not part of what was accepted,
    and being values, not text, it cannot carry code past the check."""
    admin = await _admin(client)
    uid = await _project(client, admin)
    await client.post(f"{API}/code-acceptances", headers=admin, json={"codes": [CODE]})
    hostile = '1"; import os; "'

    for person in (12, hostile):
        r = await client.post(f"{API}/execute", headers=admin, json=_run(
            uid, "patient-data", contextVars={"person_id": person, "visit_occurrence_id": None},
        ))
        assert r.status_code == 200
    assert ran[0].startswith("import pandas as pd\nimport numpy as np\n\nperson_id = 12\nvisit_occurrence_id = None\n")
    assert ran[0].endswith(CODE)
    namespace: dict = {}
    exec(injection.context_preamble("python", {"person_id": hostile}).split("\n\n", 1)[1], namespace)
    assert namespace["person_id"] == hostile


async def test_a_context_variable_is_a_plain_name(client, ran):
    admin = await _admin(client)
    uid = await _project(client, admin)
    await client.post(f"{API}/code-acceptances", headers=admin, json={"codes": [CODE]})
    r = await client.post(f"{API}/execute", headers=admin, json=_run(
        uid, "patient-data", contextVars={"x = 1; import os; y": 2},
    ))
    assert r.status_code == 400
    assert ran == []


def test_context_preamble_writes_each_language():
    assert injection.context_preamble("r", {"person_id": 3, "visit_id": None, "sql": 'a "b"'}) == (
        'library(jsonlite)\n\nperson_id <- 3\nvisit_id <- NULL\nsql <- "a \\"b\\""\n'
    )
