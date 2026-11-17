"""A server missing a program or a package that project environments need: R, renv,
uv, the dataset readers. Each case either works anyway (Linkr installs or finds what
it needs) or fails saying what is missing and how to fix it."""

import os
import shutil
import stat
import subprocess
import sys

import pytest

from app.config import settings
from app.services import project_fs
from app.services.execution import injection, renv_provisioner, toolchain, uv_provisioner

needs_r = pytest.mark.skipif(shutil.which("Rscript") is None, reason="R is not installed here")


@pytest.fixture(autouse=True)
def _renv_unchecked(monkeypatch, tmp_path, request):
    monkeypatch.setattr(renv_provisioner, "_renv_ready", False)
    if "slow" not in request.keywords:
        lib = tmp_path / "renv-lib"
        lib.mkdir()
        monkeypatch.setattr(project_fs, "renv_r_lib", lambda: lib)


def _fake_rscript(tmp_path, body: str):
    script = tmp_path / "Rscript"
    script.write_text(f"#!/bin/sh\necho \"$@\" >> {tmp_path}/calls\n{body}\n")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


# ── No R ─────────────────────────────────────────────────────────────────────

def test_without_r_an_r_build_says_r_is_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "rscript_bin", str(tmp_path / "no-such-Rscript"))
    with pytest.raises(renv_provisioner.ProvisionError, match="R is not installed"):
        renv_provisioner.ensure_renv()


async def test_without_r_the_environment_build_fails_with_the_reason(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "rscript_bin", str(tmp_path / "no-such-Rscript"))
    result = await renv_provisioner.build("p-no-r")
    assert not result.ok and "R is not installed" in result.log


def test_without_r_the_boot_check_names_it(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "rscript_bin", str(tmp_path / "no-such-Rscript"))
    assert "Rscript" in toolchain.missing()


# ── No renv ──────────────────────────────────────────────────────────────────

def test_a_server_r_without_renv_gets_it_from_the_configured_repository(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "rscript_bin", str(_fake_rscript(tmp_path, "exit 0")))
    monkeypatch.setattr(settings, "r_repos", "http://mirror/repository/cran/latest")
    renv_provisioner.ensure_renv()
    call = (tmp_path / "calls").read_text()
    lib = str(project_fs.renv_r_lib())
    assert f"install.packages('renv', lib='{lib}', repos='http://mirror/repository/cran/latest')" in call
    renv_provisioner.ensure_renv()
    assert (tmp_path / "calls").read_text() == call


def test_renv_installed_by_linkr_is_not_looked_for_again(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "rscript_bin", str(_fake_rscript(tmp_path, "exit 0")))
    (project_fs.renv_r_lib() / "renv").mkdir()
    (project_fs.renv_r_lib() / "renv" / "DESCRIPTION").write_text("Package: renv\n")
    renv_provisioner.ensure_renv()
    assert not (tmp_path / "calls").exists()


def test_renv_that_cannot_be_installed_says_how_to_install_it(monkeypatch, tmp_path):
    rscript = _fake_rscript(tmp_path, "echo 'unable to access index for repository' >&2; exit 3")
    monkeypatch.setattr(settings, "rscript_bin", str(rscript))
    with pytest.raises(renv_provisioner.ProvisionError) as raised:
        renv_provisioner.ensure_renv()
    assert "unable to access index" in str(raised.value)
    assert "install.packages(\"renv\")" in str(raised.value)
    assert renv_provisioner._renv_ready is False


def test_every_renv_command_loads_renv_from_linkrs_library_first():
    prefix = renv_provisioner._isolation_prefix("p1")
    assert f"requireNamespace('renv', lib.loc=c('{project_fs.renv_r_lib().as_posix()}', .libPaths())" in prefix


def test_linkrs_renv_library_is_not_on_a_kernels_library_path():
    from app.services.execution import kernel

    spec = kernel.runtime_spec("r", "p1", None, "token")
    assert str(project_fs.renv_r_lib()) not in " ".join(str(v) for v in spec.env.values())


@pytest.mark.slow
@needs_r
def test_renv_is_loadable_after_the_check_on_a_real_r():
    renv_provisioner.ensure_renv()
    lib = project_fs.renv_r_lib().as_posix()
    probe = subprocess.run(
        [settings.rscript_bin, "--vanilla", "-e",
         f"quit(status = if (requireNamespace('renv', lib.loc=c('{lib}', .libPaths()), quietly=TRUE)) 0 else 1)"],
        capture_output=True, text=True, timeout=120,
    )
    assert probe.returncode == 0, probe.stderr


# ── First R run: Linkr's own R packages ──────────────────────────────────────

def _shared_r_dirs(monkeypatch, tmp_path):
    for name in ("r_sandbox", "kernel_r_lib", "client_r_lib"):
        d = tmp_path / name
        d.mkdir()
        monkeypatch.setattr(project_fs, name, lambda d=d: d)
    return tmp_path


def _install_everything(root):
    (root / "r_sandbox" / "stats").mkdir()
    for lib, deps in (("kernel_r_lib", renv_provisioner._KERNEL_DEPS), ("client_r_lib", renv_provisioner._CLIENT_DEPS)):
        for dep in deps:
            (root / lib / dep).mkdir()
            (root / lib / dep / "DESCRIPTION").write_text(f"Package: {dep}\n")
    source = renv_provisioner.client_r_source()
    (root / "kernel_r_lib" / "linkr").mkdir()
    (root / "kernel_r_lib" / "linkr" / "linkr-source-fingerprint").write_text(
        renv_provisioner._client_source_fingerprint(source)
    )


def test_a_server_with_linkrs_r_packages_in_place_has_nothing_to_prepare(monkeypatch, tmp_path):
    _install_everything(_shared_r_dirs(monkeypatch, tmp_path))
    assert renv_provisioner.shared_r_ready()


def test_a_server_missing_the_kernel_packages_has_to_prepare_before_a_session(monkeypatch, tmp_path):
    root = _shared_r_dirs(monkeypatch, tmp_path)
    _install_everything(root)
    shutil.rmtree(root / "kernel_r_lib" / "svglite")
    assert not renv_provisioner.shared_r_ready()


def test_a_server_missing_duckdb_still_starts_sessions_at_once(monkeypatch, tmp_path):
    root = _shared_r_dirs(monkeypatch, tmp_path)
    _install_everything(root)
    shutil.rmtree(root / "client_r_lib" / "duckdb")
    assert renv_provisioner.shared_r_ready() and not renv_provisioner.client_r_deps_ready()


def test_a_client_library_built_ahead_is_used_as_is(monkeypatch, tmp_path):
    import importlib.util

    # A fresh copy of the module: the conftest stubs this function on the shared one.
    spec = importlib.util.find_spec("app.services.project_fs")
    real = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(real)
    monkeypatch.setattr(settings, "client_r_lib", str(tmp_path / "image-client-lib"))
    assert real.client_r_lib() == tmp_path / "image-client-lib"


def test_an_install_shows_its_output_as_it_comes(monkeypatch, tmp_path):
    _shared_r_dirs(monkeypatch, tmp_path)
    seen: list[str] = []
    code, out = renv_provisioner._install_streamed(
        ["sh", "-c", "echo compiling; echo linking; exit 2"], tmp_path / "client_r_lib", seen.append
    )
    assert code == 2 and seen == ["compiling", "linking"] and out == "compiling\nlinking"


def test_an_install_cut_short_earlier_does_not_block_the_next(monkeypatch, tmp_path):
    root = _shared_r_dirs(monkeypatch, tmp_path)
    (root / "client_r_lib" / "00LOCK-duckdb").mkdir()
    (root / "kernel_r_lib" / "00LOCK-linkr").mkdir()
    renv_provisioner._install_streamed(["true"], root / "client_r_lib")
    assert not (root / "client_r_lib" / "00LOCK-duckdb").exists()
    assert (root / "kernel_r_lib" / "00LOCK-linkr").exists(), "another library's install may be running"


def test_an_install_that_hangs_stops_at_the_build_timeout(monkeypatch, tmp_path):
    _shared_r_dirs(monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "build_timeout_seconds", 1)
    code, out = renv_provisioner._install_streamed(["sleep", "30"], tmp_path / "client_r_lib")
    assert code != 0 and "Timed out after 1s" in out


# ── No uv ────────────────────────────────────────────────────────────────────

def test_uv_installed_with_the_api_is_found_without_being_on_path(monkeypatch, tmp_path):
    bin_dir = tmp_path / "venv" / "bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "uv").write_text("")
    monkeypatch.setattr(uv_provisioner.shutil, "which", lambda _name: None)
    monkeypatch.setattr(uv_provisioner.sys, "executable", str(bin_dir / "python"))
    assert uv_provisioner.uv_bin() == str(bin_dir / "uv")


def test_a_configured_uv_wins(monkeypatch):
    monkeypatch.setattr(settings, "uv_bin", "/opt/tools/uv")
    assert uv_provisioner.uv_bin() == "/opt/tools/uv"


def test_without_uv_a_python_package_operation_says_uv_is_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(uv_provisioner, "uv_bin", lambda: str(tmp_path / "no-such-uv"))
    with pytest.raises(uv_provisioner.ProvisionError, match="uv is not installed"):
        uv_provisioner._run("p-no-uv", ["--version"])


async def test_without_uv_the_environment_build_fails_with_the_reason(monkeypatch, tmp_path):
    monkeypatch.setattr(uv_provisioner, "uv_bin", lambda: str(tmp_path / "no-such-uv"))
    result = await uv_provisioner.build("p-no-uv")
    assert not result.ok and "uv is not installed" in result.log


def test_without_uv_the_boot_check_names_it(monkeypatch, tmp_path):
    monkeypatch.setattr(toolchain, "uv_bin", lambda: str(tmp_path / "no-such-uv"))
    assert "uv" in toolchain.missing()


# ── No dataset readers in the project environment ────────────────────────────

@needs_r
def test_an_r_environment_without_arrow_says_the_dataset_needs_it(tmp_path):
    empty = tmp_path / "empty-lib"
    empty.mkdir()
    code = f".libPaths('{empty.as_posix()}')\n" + injection.r_preamble_from("/no/such.parquet", [])
    run = subprocess.run(
        ["Rscript", "--vanilla", "-e", code], capture_output=True, text=True, timeout=120,
        env={**os.environ, "R_LIBS_SITE": str(empty), "R_LIBS_USER": str(empty)},
    )
    assert run.returncode != 0
    assert "needs the R package arrow" in run.stderr


def test_a_python_environment_without_pandas_says_the_dataset_needs_it():
    code = injection.python_preamble_from("/no/such.parquet", [])
    run = subprocess.run([sys.executable, "-I", "-S", "-c", code], capture_output=True, text=True, timeout=60)
    assert run.returncode != 0
    assert "needs pandas and pyarrow" in run.stderr
