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
