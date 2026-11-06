"""uv provisioner: requirement parsing + manifest package listing (pure parts)."""

import pytest

from app.services.execution import uv_provisioner as uv


def test_split_requirement_variants():
    assert uv._split_requirement("pandas") == {"name": "pandas", "spec": ""}
    assert uv._split_requirement("numpy==1.26.0") == {"name": "numpy", "spec": "==1.26.0"}
    assert uv._split_requirement("scipy>=1.10") == {"name": "scipy", "spec": ">=1.10"}
    assert uv._split_requirement("requests ~= 2.31") == {"name": "requests", "spec": "~=2.31"}


def test_list_packages_reads_manifest(tmp_path, monkeypatch):
    spec = tmp_path / "environments" / "python"
    spec.mkdir(parents=True)
    (spec / "pyproject.toml").write_text(
        '[project]\nname = "x"\nversion = "0"\n'
        'dependencies = ["pandas==2.1.4", "numpy"]\n'
    )
    monkeypatch.setattr(
        uv.project_fs, "env_spec_dir", lambda project_uid, language: spec
    )
    pkgs = uv.list_packages("proj-1")
    assert {p["name"] for p in pkgs} == {"pandas", "numpy"}
    assert next(p for p in pkgs if p["name"] == "pandas")["spec"] == "==2.1.4"


def test_list_packages_empty_when_no_manifest(tmp_path, monkeypatch):
    spec = tmp_path / "environments" / "python"
    spec.mkdir(parents=True)
    monkeypatch.setattr(
        uv.project_fs, "env_spec_dir", lambda project_uid, language: spec
    )
    assert uv.list_packages("proj-1") == []


_PROJECT_INDEX = """\
[project]
name = "x"
version = "0"
dependencies = ["six"]

[[tool.uv.index]]
name = "own"
url = "https://elsewhere.example/simple"

[tool.uv.sources]
six = { index = "own" }
"""

_LOCK = """\
version = 1

[[package]]
name = "six"
version = "1.17.0"
source = {{ registry = "{registry}" }}
wheels = [{{ url = "{wheel}" }}]
"""


def _spec_dir(tmp_path, monkeypatch, pyproject: str, lock: str | None = None):
    spec = tmp_path / "environments" / "python"
    spec.mkdir(parents=True)
    (spec / "pyproject.toml").write_text(pyproject)
    if lock is not None:
        (spec / "uv.lock").write_text(lock)
    monkeypatch.setattr(uv.project_fs, "env_spec_dir", lambda project_uid, language: spec)
    monkeypatch.setattr(uv.project_fs, "env_cache_dir", lambda project_uid, language: tmp_path / "venv")
    monkeypatch.setattr(uv.project_fs, "env_package_cache", lambda tool: tmp_path / "cache")


def _mirror(monkeypatch, url="https://pypi.chu.local/simple"):
    from app.config import settings

    monkeypatch.setattr(settings, "pip_index_url", url)


def test_without_a_mirror_project_sources_are_left_to_uv(tmp_path, monkeypatch):
    lock = _LOCK.format(registry="https://pypi.org/simple", wheel="https://files.pythonhosted.org/six.whl")
    _spec_dir(tmp_path, monkeypatch, _PROJECT_INDEX, lock)
    uv._require_mirror_sources("p", {}, lock_too=True)
    env = uv._uv_env("p", {})
    assert "UV_NO_SOURCES" not in env and "UV_NO_CONFIG" not in env


def test_under_a_mirror_uv_ignores_the_project_index_and_sources(tmp_path, monkeypatch):
    _mirror(monkeypatch)
    _spec_dir(tmp_path, monkeypatch, _PROJECT_INDEX)
    env = uv._uv_env("p", {"indexUrl": "https://pypi.chu.local/simple"})
    assert env["UV_NO_SOURCES"] == "1" and env["UV_NO_CONFIG"] == "1"
    assert env["UV_INDEX_URL"] == "https://pypi.chu.local/simple"


def test_under_a_mirror_a_lock_stays_on_the_mirror(tmp_path, monkeypatch):
    _mirror(monkeypatch)
    on_mirror = _LOCK.format(registry="https://pypi.chu.local/simple", wheel="https://pypi.chu.local/f/six.whl")
    _spec_dir(tmp_path, monkeypatch, _PROJECT_INDEX, on_mirror)
    uv._require_mirror_sources("p", {}, lock_too=True)


@pytest.mark.parametrize("registry, wheel", [
    ("https://pypi.chu.local/simple", "https://elsewhere.example/six.whl"),
    ("https://elsewhere.example/simple", "https://pypi.chu.local/f/six.whl"),
    ("https://pypi.chu.local/simple", "file:///srv/six.whl"),
])
def test_under_a_mirror_a_lock_reaching_another_host_is_never_synced(tmp_path, monkeypatch, registry, wheel):
    _mirror(monkeypatch)
    _spec_dir(tmp_path, monkeypatch, _PROJECT_INDEX, _LOCK.format(registry=registry, wheel=wheel))
    with pytest.raises(uv.ProvisionError, match="outside the deployment's package mirror"):
        uv._require_mirror_sources("p", {}, lock_too=True)
    result = uv.asyncio.run(uv.build("p"))
    assert not result.ok and "outside the deployment's package mirror" in result.log
    uv._require_mirror_sources("p", {}, lock_too=False)


@pytest.mark.parametrize("req", [
    "six @ https://elsewhere.example/six-1.17.0-py3-none-any.whl",
    "six @ git+https://elsewhere.example/six.git@1.17.0",
])
def test_under_a_mirror_a_direct_reference_elsewhere_is_refused(tmp_path, monkeypatch, req):
    _mirror(monkeypatch)
    _spec_dir(tmp_path, monkeypatch, f'[project]\nname = "x"\nversion = "0"\ndependencies = ["{req}"]\n')
    with pytest.raises(uv.ProvisionError):
        uv._require_mirror_sources("p", {}, lock_too=False)
    with pytest.raises(uv.ProvisionError):
        uv.add_packages("p", ["pandas"])


@pytest.mark.parametrize("manifest", [
    '[tool.uv]\n{key} = ["six @ https://elsewhere.example/six.whl"]\n'.format(key=key)
    for key in ("dev-dependencies", "override-dependencies", "constraint-dependencies", "build-constraint-dependencies")
] + [
    '[tool.uv.workspace]\nmembers = ["sub"]\n',
    '[project]\nname = "x"\nversion = "0"\ndependencies = ["six @ http://127.0.0.1:9\\\\@pypi.chu.local/six.whl"]\n',
])
def test_under_a_mirror_no_part_of_the_manifest_reaches_another_host(tmp_path, monkeypatch, manifest):
    _mirror(monkeypatch)
    _spec_dir(tmp_path, monkeypatch, manifest)
    with pytest.raises(uv.ProvisionError):
        uv._require_mirror_sources("p", {}, lock_too=False)
