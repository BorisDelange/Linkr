"""A derived database's export: the provenance a rebuild needs travels, the
build's exact count and this instance's server-side names stay behind."""

import io
import json
import zipfile

from app.models.data_source import DataSource
from app.services.workspace_export import _portable_derived_from
from app.services.workspace_export_assemble import build_database_tree

API = "/api/v1"

DERIVED_FROM = {
    "database": {"lineageId": "lin-parent", "entityId": "parent", "label": "Parent"},
    "cohort": {"key": "three", "name": {"en": "Three"}},
    "level": "patient",
    "criteriaTree": {"kind": "group", "id": "root", "operator": "AND", "children": []},
    "target": "new-database",
    "options": {
        "scope": "patient",
        "pseudonymization": {
            "method": "hmac", "keepKey": True, "reuseKeyOf": "local-db-id.dm_other",
            "correspondence": {"dataSourceId": "local-corr-id", "schemaName": "dm_private_corr", "tableName": "linkr_pseudonyms"},
        },
    },
    "derivationId": "tgt.dm_cohort_private",
    "schemaName": "dm_cohort_private",
    "builtAt": "2026-10-01T00:00:00.000Z",
    "patientCount": 3,
}

PORTABLE = {
    "database": DERIVED_FROM["database"],
    "cohort": DERIVED_FROM["cohort"],
    "level": "patient",
    "criteriaTree": DERIVED_FROM["criteriaTree"],
    "target": "new-database",
    "options": {"scope": "patient", "pseudonymization": {"method": "hmac", "keepKey": True}},
    "builtAt": DERIVED_FROM["builtAt"],
}


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_portable_derived_from_keeps_order_and_leaves_input_untouched():
    out = _portable_derived_from(DERIVED_FROM)
    assert out == PORTABLE
    assert list(out) == list(PORTABLE)
    assert DERIVED_FROM["options"]["pseudonymization"]["correspondence"]["schemaName"] == "dm_private_corr"


async def test_derived_database_exports_without_count_or_server_names(client, db):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    r = await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "cohort_three", "name": "Cohort three", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True}, "derivedFrom": DERIVED_FROM,
    })
    assert r.status_code == 201, r.text
    ds = r.json()["id"]

    tree = await build_database_tree(db, await db.get(DataSource, ds))
    assert json.loads(tree["entity.json"])["derivedFrom"] == PORTABLE

    r = await client.post(f"{API}/workspaces/{ws}/export-zip", headers=headers)
    assert r.status_code == 200, r.text
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        manifests = [json.loads(z.read(n)) for n in z.namelist() if n.startswith("databases/") and n.endswith("/entity.json")]
        everything = b"".join(z.read(n) for n in z.namelist())
    assert [m["derivedFrom"] for m in manifests] == [PORTABLE]
    for local in (b"dm_cohort_private", b"dm_private_corr", b"local-corr-id", b"local-db-id", b'"patientCount"'):
        assert local not in everything
