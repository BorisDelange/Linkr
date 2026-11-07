"""One dataset file has one cache and one sidecar: a read under another spelling
of its path writes nothing new."""

import pytest

from app.services import project_fs
from app.services.data import dataset_fs


@pytest.fixture
def dataset():
    uid = "cache-key-project"
    root = project_fs.datasets_dir(uid)
    (root / "sub").mkdir(parents=True, exist_ok=True)
    (root / "a.csv").write_text("x,y\n1,2\n3,4\n")
    (root / "sub" / "b.csv").write_text("x\n1\n")
    return uid, root


def _cache_files(uid: str) -> set[str]:
    root = project_fs.cache_dir(uid) / "datasets"
    return {p.name for p in root.iterdir()} if root.exists() else set()


@pytest.mark.parametrize("spelling", [
    "./a.csv", "././a.csv", "does-not-exist/../a.csv", "x/./y/../../a.csv", "sub/../a.csv", "sub//b.csv",
])
def test_another_spelling_of_a_dataset_writes_no_cache(dataset, spelling):
    uid, _ = dataset
    dataset_fs.resolve_cache(uid, "a.csv")
    before = _cache_files(uid)
    with pytest.raises((ValueError, FileNotFoundError)):
        dataset_fs.resolve_cache(uid, spelling)
    assert _cache_files(uid) == before


def test_the_absolute_path_of_a_dataset_writes_no_cache(dataset):
    uid, root = dataset
    dataset_fs.resolve_cache(uid, "a.csv")
    before = _cache_files(uid)
    for spelling in (str(root / "a.csv"), "/" + str(root / "a.csv")):
        with pytest.raises((ValueError, FileNotFoundError)):
            dataset_fs.resolve_cache(uid, spelling)
    assert _cache_files(uid) == before


def test_a_dataset_keeps_one_cache_and_its_sidecars(dataset):
    uid, _ = dataset
    first = dataset_fs.resolve_cache(uid, "a.csv")
    files = _cache_files(uid)
    assert dataset_fs.resolve_cache(uid, "a.csv")["rowCount"] == first["rowCount"] == 2
    assert dataset_fs.resolve_cache(uid, "sub/b.csv")["rowCount"] == 1
    assert len(_cache_files(uid)) == len(files) * 2
    with pytest.raises(ValueError):
        dataset_fs.append_ops(uid, "./a.csv", [])
