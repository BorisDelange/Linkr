"""The three independent path bindings (ide_path / scripts_path / datasets_path):
each resolves to its own dir with its own default, the IDE scan reads ide_dir while
the export scan reads scripts_dir (so a broad ide_path never leaks datasets), and
LINKR_* env carries all four dirs."""

from app.config import settings
from app.services import project_fs

UID = "proj-bindings-test"


def _default(sub: str):
    return settings.data_path / "projects" / UID / sub


def test_defaults_when_unbound():
    project_fs.invalidate_binding(UID)
    project_fs.prime_binding(UID, None, None, None)
    # ide_dir defaults to scripts (IDE shows exactly the exported code out of the box).
    assert project_fs.ide_dir(UID) == _default("scripts")
    assert project_fs.scripts_dir(UID) == _default("scripts")
    assert project_fs.datasets_dir(UID) == _default("datasets")


def test_three_paths_resolve_independently(tmp_path):
    home = tmp_path / "home"
    study = home / "my_study"
    data = home / "content" / "data"
    study.mkdir(parents=True)
    data.mkdir(parents=True)
    project_fs.prime_binding(UID, str(home), str(study), str(data))
    assert project_fs.ide_dir(UID) == home
    assert project_fs.scripts_dir(UID) == study
    assert project_fs.datasets_dir(UID) == data


def test_ide_scan_reads_ide_dir_export_scan_reads_scripts_dir(tmp_path):
    home = tmp_path / "home"
    study = home / "my_study"
    data = home / "data"
    study.mkdir(parents=True)
    data.mkdir(parents=True)
    (study / "model.R").write_text("1")
    (data / "cohort.csv").write_text("a,b")
    project_fs.prime_binding(UID, str(home), str(study), str(data))

    # IDE scan sees the whole working dir (both my_study/ and data/ as folders).
    ide_names = {n["name"] for n in project_fs.scan_scripts(UID) if n["parentId"] is None}
    assert {"my_study", "data"} <= ide_names

    # Export scan sees only the code sub-tree — never the datasets living elsewhere.
    export_paths = {n["path"] for n in project_fs.scan_scripts_for_export(UID)}
    assert export_paths == {"model.R"}
    assert "cohort.csv" not in export_paths


def test_runtime_env_exposes_all_dirs(tmp_path):
    home = tmp_path / "h"
    study = home / "s"
    data = home / "d"
    study.mkdir(parents=True)
    data.mkdir(parents=True)
    project_fs.prime_binding(UID, str(home), str(study), str(data))
    env = project_fs.runtime_env(UID)
    assert env["LINKR_IDE"] == str(home)
    assert env["LINKR_SCRIPTS"] == str(study)
    assert env["LINKR_DATASETS"] == str(data)
    assert env["LINKR_PROJECT"].endswith(f"projects/{UID}")


def test_ide_crud_targets_ide_dir(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    project_fs.prime_binding(UID, str(home), None, None)
    project_fs.write_script(UID, "notebook.py", "x = 1")
    assert (home / "notebook.py").read_text() == "x = 1"
    project_fs.invalidate_binding(UID)
