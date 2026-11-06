"""A project's files are data until a member imports one: starting a kernel, or
installed code probing for an optional module, must never execute them. Runs real
interpreters, since the search order is what is under test."""

import sys
from pathlib import Path

import pytest

from app.services import project_fs
from app.services.execution.kernel import _PY_KERNEL_LOOP, _PY_PROJECT_IMPORTS, Kernel, KernelManager

MARK = "ran-from-project"


def plant(folder: Path, *names: str) -> None:
    for name in names:
        (folder / f"{name}.py").write_text(f"open({str(folder / MARK)!r}, 'a').write({name!r} + chr(10))\n")


def planted_ran(folder: Path) -> str:
    mark = folder / MARK
    return mark.read_text() if mark.exists() else ""


@pytest.fixture
def ide(tmp_path, monkeypatch):
    monkeypatch.setattr(project_fs, "ide_dir", lambda _uid: tmp_path)
    return tmp_path


async def run(kernel: Kernel, code: str):
    try:
        return await kernel.execute(code)
    finally:
        await kernel.shutdown()


def user_kernel() -> Kernel:
    return KernelManager()._make("python", "project-under-test")


async def test_starting_a_kernel_runs_no_project_file(ide):
    plant(ide, "json", "signal", "traceback", "base64", "pandas", "numpy", "matplotlib")
    out = await run(user_kernel(), "import json, pandas, numpy\nprint(json.__name__, pandas.__name__, numpy.__name__)")
    assert planted_ran(ide) == ""
    assert "json pandas numpy" in out.stdout


async def test_installed_code_probing_a_module_never_gets_a_project_file(ide):
    plant(ide, "linkr_absent_module")
    out = await run(user_kernel(), (
        "import pkgutil\n"
        "try:\n"
        "    pkgutil.resolve_name('linkr_absent_module')\n"
        "    print('imported')\n"
        "except ModuleNotFoundError:\n"
        "    print('not found')\n"
    ))
    assert planted_ran(ide) == ""
    assert "not found" in out.stdout


async def test_pandas_optional_dependencies_never_come_from_the_project(ide):
    plant(ide, "numexpr", "bottleneck")
    await run(user_kernel(), "import pandas")
    assert planted_ran(ide) == ""


async def test_what_the_kernel_itself_needs_never_comes_from_the_project_when_not_installed(ide):
    plant(ide, "pandas", "numpy", "matplotlib", "plotly", "jedi")
    kernel = Kernel([sys.executable, "-S", "-c", _PY_PROJECT_IMPORTS + _PY_KERNEL_LOOP], cwd=str(ide))
    out = await run(kernel, (
        "for name in ('pandas', 'numpy', 'matplotlib', 'plotly', 'jedi'):\n"
        "    try:\n"
        "        __import__(name)\n"
        "    except ModuleNotFoundError:\n"
        "        print('not found', name)\n"
    ))
    assert planted_ran(ide) == ""
    assert out.stdout.count("not found") == 5


async def test_a_members_code_still_imports_project_modules(ide):
    (ide / "helper.py").write_text("import sibling\nVALUE = sibling.VALUE + 1\n")
    (ide / "sibling.py").write_text("VALUE = 41\n")
    (ide / "other.py").write_text("VALUE = 'other'\n")
    (ide / "third.py").write_text("VALUE = 'third'\n")
    (ide / "sub").mkdir()
    (ide / "sub" / "beside.py").write_text("VALUE = 'beside'\n")
    out = await run(user_kernel(), (
        "import importlib, os\n"
        "import helper\n"
        "print(helper.VALUE)\n"
        "print(importlib.import_module('other').VALUE)\n"
        "exec('import third; print(third.VALUE)')\n"
        "os.chdir('sub')\n"
        "import beside\n"
        "print(beside.VALUE)\n"
    ))
    assert out.stdout.split() == ["42", "other", "third", "beside"], out.stderr


async def test_a_module_already_imported_by_the_member_stays_available_to_installed_code(ide):
    (ide / "helper.py").write_text("VALUE = 1\n")
    out = await run(user_kernel(), "import helper, pkgutil\nprint(pkgutil.resolve_name('helper').VALUE)")
    assert "1" in out.stdout


async def test_a_server_owned_kernel_has_no_project_folder_on_its_path(ide):
    plant(ide, "linkr_absent_module")
    kernel = KernelManager()._make("python", "project-under-test", server_owned=True)
    out = await run(kernel, "import sys\nprint('' in sys.path)")
    assert "False" in out.stdout
    assert planted_ran(ide) == ""
