import os
from pathlib import Path

import pytest

from linkr import _paths


@pytest.fixture(autouse=True)
def _reset_warnings():
    _paths._warned.clear()


def test_each_path_comes_from_its_own_variable(monkeypatch):
    monkeypatch.setenv("LINKR_PROJECT", "/srv/proj")
    monkeypatch.setenv("LINKR_SCRIPTS", "/srv/code")
    monkeypatch.setenv("LINKR_DATASETS", "/mnt/big/data")
    monkeypatch.setenv("LINKR_IDE", "/srv/home")

    # The bindings are independent: datasets living on another volume must not be
    # derived from the project dir.
    assert _paths.project_dir() == Path("/srv/proj")
    assert _paths.scripts_dir() == Path("/srv/code")
    assert _paths.datasets_dir() == Path("/mnt/big/data")
    assert _paths.ide_dir() == Path("/srv/home")


def test_unset_variable_falls_back_to_cwd_and_warns(monkeypatch):
    monkeypatch.delenv("LINKR_DATASETS", raising=False)

    with pytest.warns(RuntimeWarning, match="not running inside a Linkr"):
        assert _paths.datasets_dir() == Path(os.getcwd())


def test_fallback_warns_once(monkeypatch, recwarn):
    monkeypatch.delenv("LINKR_SCRIPTS", raising=False)

    with pytest.warns(RuntimeWarning):
        _paths.scripts_dir()
    recwarn.clear()
    _paths.scripts_dir()
    assert len(recwarn) == 0


def test_empty_variable_counts_as_unset(monkeypatch):
    monkeypatch.setenv("LINKR_PROJECT", "")

    with pytest.warns(RuntimeWarning):
        assert _paths.project_dir() == Path(os.getcwd())
