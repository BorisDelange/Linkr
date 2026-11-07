"""A project's environment specs in its export: the versioned spec files only,
and never a package mirror's credentials, whoever downloads it."""

import io
import json
import zipfile

from app.core.security import hash_password
from app.models.user import User
from app.services import project_fs
from app.services.project_export_assemble import _read_env_specs

API = "/api/v1"


def test_only_spec_files_leave_and_without_mirror_credentials(tmp_path, monkeypatch):
    uid = "p-env"
    r_dir = project_fs.env_spec_dir(uid, "r")
    r_dir.mkdir(parents=True, exist_ok=True)
    (r_dir / "options.json").write_text(json.dumps({"repos": "https://dummyuser:dummySECRET@mirror.example/cran,https://cran.example/"}))
    (r_dir / "renv.lock").write_text(json.dumps({
        "R": {"Repositories": [{"Name": "CRAN", "URL": "https://dummyuser:dummySRVSECRET@mirror.example/cran"}]},
        "Packages": {"x": {"Package": "x", "Maintainer": "someone@example.org"}},
    }, indent=2))
    (r_dir / "notes.txt").write_text("not a spec file")
    py_dir = project_fs.env_spec_dir(uid, "python")
    py_dir.mkdir(parents=True, exist_ok=True)
    (py_dir / "requirements.txt").write_text("--index-url https://tok:dummyPYSECRET@pypi.example/simple\npandas\n")

    specs = _read_env_specs(uid)

    assert sorted(specs) == ["environments/python/requirements.txt", "environments/r/options.json", "environments/r/renv.lock"]
    joined = b"".join(specs.values())
    for secret in (b"dummySECRET", b"dummySRVSECRET", b"dummyPYSECRET", b"dummyuser"):
        assert secret not in joined
    assert json.loads(specs["environments/r/options.json"]) == {"repos": "https://mirror.example/cran,https://cran.example/"}
    lock = json.loads(specs["environments/r/renv.lock"])
    assert lock["R"]["Repositories"][0]["URL"] == "https://mirror.example/cran"
    assert lock["Packages"]["x"]["Maintainer"] == "someone@example.org"
    assert specs["environments/python/requirements.txt"] == b"--index-url https://pypi.example/simple\npandas\n"


def test_a_spec_without_credentials_leaves_byte_for_byte():
    uid = "p-env-clean"
    r_dir = project_fs.env_spec_dir(uid, "r")
    r_dir.mkdir(parents=True, exist_ok=True)
    text = '{\n  "R": {"Repositories": [{"Name": "CRAN", "URL": "https://cran.example/"}]},\n  "Packages": {}\n}'
    (r_dir / "renv.lock").write_text(text)
    assert _read_env_specs(uid) == {"environments/r/renv.lock": text.encode()}


async def test_a_viewers_project_export_holds_no_mirror_credential(client, db, seed_roles):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    login = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    h = {"Authorization": f"Bearer {login.json()['access_token']}"}
    viewer = User(username="viewer", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(viewer)
    await db.commit()
    v_login = await client.post(f"{API}/auth/login", json={"username": "viewer", "password": "pw-for-tests-only"})
    v = {"Authorization": f"Bearer {v_login.json()['access_token']}"}
    ws = (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "w"}})).json()["id"]
    await client.put(f"{API}/workspaces/{ws}/members", headers=h, json={"userId": viewer.id, "role": "viewer"})
    uid = (await client.post(f"{API}/projects", headers=h, json={"workspaceId": ws, "name": {"en": "p"}})).json()["uid"]
    r = await client.put(
        f"{API}/projects/{uid}/environments/r/options", headers=h,
        json={"repos": "https://dummyuser:dummySECRET@mirror.example/cran"},
    )
    assert r.status_code in (200, 204), r.text

    for url, method in ((f"{API}/projects/{uid}/export-zip", "get"), (f"{API}/workspaces/{ws}/export-zip", "post")):
        r = await getattr(client, method)(url, headers=v)
        assert r.status_code == 200, r.text
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            names = z.namelist()
            assert any(n.endswith("environments/r/options.json") for n in names)
            assert not any(b"dummySECRET" in z.read(n) for n in names)
