"""renv provisioner: package ops build the right isolated install+snapshot R code,
and list_packages reflects the full lockfile tree. R is not shelled out — `_run_r`
is captured — so these run without renv installed."""

import json

import pytest

from app.services.execution import renv_provisioner as R


def _capture(monkeypatch):
    calls = []
    monkeypatch.setattr(R, "_run_r", lambda uid, code, on_log=None, options=None: calls.append(code) or "")
    monkeypatch.setattr(R, "ensure_r_sandbox", lambda on_log=None: None)
    monkeypatch.setattr(R, "ensure_manifest", lambda uid: None)
    return calls


def test_add_packages_installs_with_deps_then_snapshots(monkeypatch, tmp_path):
    monkeypatch.setattr(R.project_fs, "env_spec_dir", lambda uid, lang: tmp_path / uid / lang)
    monkeypatch.setattr(R.project_fs, "r_sandbox", lambda: tmp_path / "sandbox")
    monkeypatch.setattr(R, "_library_dir", lambda uid: tmp_path / uid / "lib")
    calls = _capture(monkeypatch)

    R.add_packages("p1", ["plotly", "dplyr==1.2.1"])

    assert len(calls) == 1
    code = calls[0]
    # Real install of both requested packages (version pin → renv ref pkg@version).
    assert 'renv::install(c("plotly", "dplyr@1.2.1")' in code
    # Installs into the project library, not the default location.
    assert "library='" in code and "/p1/lib" in code
    # Full-tree snapshot afterwards, so the lockfile captures the deps too.
    assert "renv::snapshot(" in code and "type='all'" in code
    # Runs inside the isolation (sandbox as .Library) so deps don't resolve globally.
    assert ".BaseNamespaceEnv" in code and "assign('.Library'" in code
    # renv is loaded BEFORE the .Library swap (it's a contributed package).
    assert code.index("requireNamespace('renv'") < code.index("assign('.Library'")


def test_remove_package_uninstalls_then_snapshots(monkeypatch, tmp_path):
    monkeypatch.setattr(R.project_fs, "r_sandbox", lambda: tmp_path / "sandbox")
    monkeypatch.setattr(R, "_library_dir", lambda uid: tmp_path / uid / "lib")
    calls = _capture(monkeypatch)

    R.remove_package("p1", "plotly")

    code = calls[0]
    assert "remove.packages('plotly'" in code
    assert "renv::snapshot(" in code


def test_list_packages_reads_full_lockfile(monkeypatch, tmp_path):
    lock = tmp_path / "renv.lock"
    lock.write_text(json.dumps({"Packages": {
        "plotly": {"Package": "plotly", "Version": "4.10.4"},
        "ggplot2": {"Package": "ggplot2", "Version": "3.5.1"},
    }}))
    monkeypatch.setattr(R, "_lock_path", lambda uid: lock)

    pkgs = R.list_packages("p1")
    by = {p["name"]: p["spec"] for p in pkgs}
    # Both the declared package AND its dependency appear (snapshot recorded them).
    assert by == {"ggplot2": "==3.5.1", "plotly": "==4.10.4"}


def test_list_kernel_packages_reads_version_from_description(monkeypatch, tmp_path):
    """The kernel infra rows carry the version installed in the shared kernel library
    (read from each package's DESCRIPTION), are flagged system, and a not-yet-installed
    one shows an empty version."""
    monkeypatch.setattr(R.project_fs, "kernel_r_lib", lambda: tmp_path)
    # jsonlite installed with a version; base64enc without DESCRIPTION; svglite absent.
    (tmp_path / "jsonlite").mkdir()
    (tmp_path / "jsonlite" / "DESCRIPTION").write_text("Package: jsonlite\nVersion: 1.8.9\n")

    pkgs = R.list_kernel_packages()
    by = {p["name"]: p for p in pkgs}
    assert by["jsonlite"]["spec"] == "==1.8.9" and by["jsonlite"]["system"] is True
    assert by["base64enc"]["spec"] == "" and by["base64enc"]["system"] is True
    assert by["svglite"]["spec"] == "" and by["svglite"]["system"] is True


def test_upgrade_kernel_package_rejects_non_kernel(monkeypatch, tmp_path):
    """Only the three infra packages can be reinstalled via the kernel-lib path."""
    monkeypatch.setattr(R.project_fs, "kernel_r_lib", lambda: tmp_path)
    with pytest.raises(R.ProvisionError):
        R.upgrade_kernel_package("dplyr")


def test_check_updates_parses_json_object(monkeypatch, tmp_path):
    monkeypatch.setattr(R.project_fs, "r_sandbox", lambda: tmp_path / "sandbox")
    monkeypatch.setattr(R, "_library_dir", lambda uid: tmp_path / uid / "lib")
    # Fake the R call: it prints a JSON object of outdated {name: latest}.
    monkeypatch.setattr(R, "_run_r", lambda uid, code, on_log=None, options=None: 'some warning\n{"glue":"1.8.1","cli":"3.6.3"}')

    out = R.check_updates("p1")
    assert out == {"glue": "1.8.1", "cli": "3.6.3"}


def test_check_updates_empty_when_nothing_outdated(monkeypatch, tmp_path):
    monkeypatch.setattr(R.project_fs, "r_sandbox", lambda: tmp_path / "sandbox")
    monkeypatch.setattr(R, "_library_dir", lambda uid: tmp_path / uid / "lib")
    monkeypatch.setattr(R, "_run_r", lambda uid, code, on_log=None, options=None: "{}")
    assert R.check_updates("p1") == {}
