"""uv provisioner: requirement parsing + manifest package listing (pure parts)."""

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


def _fake_venv(tmp_path, dist_infos: list[str]):
    """Build a fake venv site-packages with the given *.dist-info dirs."""
    site = tmp_path / "venv" / "lib" / "python3.12" / "site-packages"
    site.mkdir(parents=True)
    for name in dist_infos:
        (site / name).mkdir()
    return tmp_path / "venv"


def test_installed_names_reads_dist_info(tmp_path, monkeypatch):
    venv = _fake_venv(tmp_path, ["pandas-2.1.4.dist-info", "numpy-1.26.0.dist-info"])
    monkeypatch.setattr(uv, "_venv_dir", lambda project_uid: venv)
    assert uv.installed_names("proj-1") == ["numpy", "pandas"]


def test_detect_extra_names_is_venv_minus_lockfile(tmp_path, monkeypatch):
    # requests + its dep urllib3 are locked; seaborn was pip-installed (not locked).
    venv = _fake_venv(
        tmp_path,
        ["requests-2.31.0.dist-info", "urllib3-2.0.0.dist-info", "seaborn-0.13.2.dist-info"],
    )
    lock = tmp_path / "environments" / "python"
    lock.mkdir(parents=True)
    (lock / "uv.lock").write_text(
        '[[package]]\nname = "requests"\nversion = "2.31.0"\n\n'
        '[[package]]\nname = "urllib3"\nversion = "2.0.0"\n'
    )
    monkeypatch.setattr(uv, "_venv_dir", lambda project_uid: venv)
    monkeypatch.setattr(uv.project_fs, "env_spec_dir", lambda project_uid, language: lock)
    # Only the un-locked, imperatively-installed package is drift.
    assert uv.detect_extra_names("proj-1") == ["seaborn"]
