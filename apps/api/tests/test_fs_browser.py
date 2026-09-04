"""Tests for the server file-browser service (fs_browser): browse-root confinement,
validate semantics (exists + writable, no mkdir), and copy_tree conflict handling."""

import os

import pytest

from app.services import fs_browser


def _set_roots(monkeypatch, roots: str):
    from app.config import settings

    monkeypatch.setattr(settings, "fs_browse_roots", roots)


def test_list_dir_lists_subdirs_only(tmp_path):
    (tmp_path / "sub_a").mkdir()
    (tmp_path / "sub_b").mkdir()
    (tmp_path / ".hidden").mkdir()
    (tmp_path / "file.txt").write_text("x")
    res = fs_browser.list_dir(str(tmp_path))
    names = [e["name"] for e in res["entries"]]
    assert names == ["sub_a", "sub_b"]  # sorted, no files, no dotfiles
    assert res["path"] == str(tmp_path.resolve())


def test_list_dir_missing_raises(tmp_path):
    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.list_dir(str(tmp_path / "nope"))


def test_browse_roots_confinement(monkeypatch, tmp_path):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    _set_roots(monkeypatch, str(allowed))
    # Inside the root: OK.
    assert fs_browser.list_dir(str(allowed))["path"] == str(allowed.resolve())
    # Outside the root: rejected.
    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.list_dir(str(outside))


def test_list_dir_parent_stops_at_root(monkeypatch, tmp_path):
    root = tmp_path / "root"
    child = root / "child"
    child.mkdir(parents=True)
    _set_roots(monkeypatch, str(root))
    # From child, parent is the root (still allowed).
    assert fs_browser.list_dir(str(child))["parent"] == str(root.resolve())
    # From the root itself, parent is outside → None.
    assert fs_browser.list_dir(str(root))["parent"] is None


def test_validate_requires_existing_writable_dir(tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    assert fs_browser.validate_dir(str(d)) == {"ok": True, "path": str(d.resolve())}
    assert fs_browser.validate_dir(str(tmp_path / "absent"))["reason"] == "not_found"
    f = tmp_path / "f.txt"
    f.write_text("x")
    assert fs_browser.validate_dir(str(f))["reason"] == "not_a_dir"
    assert fs_browser.validate_dir("")["reason"] == "empty"


def test_validate_not_writable(tmp_path):
    d = tmp_path / "ro"
    d.mkdir()
    os.chmod(d, 0o500)
    try:
        res = fs_browser.validate_dir(str(d))
        # Root ignores permission bits; skip the assertion when running as root.
        if os.geteuid() != 0:
            assert res["reason"] == "not_writable"
    finally:
        os.chmod(d, 0o700)


def test_copy_tree_conflict_strategies(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    (src / "sub").mkdir(parents=True)
    dst.mkdir()
    (src / "a.txt").write_text("from-src")
    (src / "sub" / "b.txt").write_text("nested")
    (dst / "a.txt").write_text("from-dst")

    # ignore: keep dst's a.txt, still copy the new nested file.
    res = fs_browser.copy_tree(str(src), str(dst), "ignore")
    assert (dst / "a.txt").read_text() == "from-dst"
    assert (dst / "sub" / "b.txt").read_text() == "nested"
    assert res["skipped"] == 1 and res["copied"] == 1

    # overwrite: replace a.txt.
    fs_browser.copy_tree(str(src), str(dst), "overwrite")
    assert (dst / "a.txt").read_text() == "from-src"

    # keep_both: write a suffixed copy alongside.
    (dst / "a.txt").write_text("from-dst-again")
    fs_browser.copy_tree(str(src), str(dst), "keep_both")
    assert (dst / "a.txt").read_text() == "from-dst-again"
    assert (dst / "a (2).txt").read_text() == "from-src"


def test_copy_tree_rejects_dst_inside_src(tmp_path):
    src = tmp_path / "src"
    (src / "inner").mkdir(parents=True)
    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.copy_tree(str(src), str(src / "inner"), "ignore")


def test_copy_tree_invalid_strategy(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    src.mkdir()
    dst.mkdir()
    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.copy_tree(str(src), str(dst), "bogus")


def test_validate_binding_path_enforces_browse_roots(monkeypatch, tmp_path):
    # The bind is persisted via a plain project PATCH, so the browse-root boundary
    # must be re-enforced at persistence time — client-side picker validation is
    # not a security control.
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    _set_roots(monkeypatch, str(allowed))
    # Inside the root, existing dir: accepted (no raise).
    fs_browser.validate_binding_path(str(allowed))
    # Outside the configured roots: rejected.
    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.validate_binding_path(str(outside))
    # A path inside the root that doesn't exist as a dir: rejected.
    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.validate_binding_path(str(allowed / "absent"))
    f = allowed / "f.txt"
    f.write_text("x")
    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.validate_binding_path(str(f))


def test_validate_binding_path_empty_clears_binding(monkeypatch, tmp_path):
    # An empty path clears the binding (falls back to the default dir) and is always
    # allowed, even outside any configured root.
    _set_roots(monkeypatch, str(tmp_path / "root"))
    fs_browser.validate_binding_path("")


def test_validate_binding_path_blocked_when_code_execution_disabled(monkeypatch, tmp_path):
    from app.config import settings

    d = tmp_path / "d"
    d.mkdir()
    _set_roots(monkeypatch, str(tmp_path))
    monkeypatch.setattr(settings, "enable_code_execution", False)
    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.validate_binding_path(str(d))


# --- File listing (the database picker) --------------------------------------


def test_list_dir_includes_files_when_asked(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "b.parquet").write_text("x")
    (tmp_path / "a.duckdb").write_text("x")
    (tmp_path / ".hidden.parquet").write_text("x")
    res = fs_browser.list_dir(str(tmp_path), include_files=True)
    # Directories first, then files, each sorted case-insensitively; no dotfiles.
    assert [e["name"] for e in res["entries"]] == ["sub", "a.duckdb", "b.parquet"]
    assert [e["isDir"] for e in res["entries"]] == [True, False, False]
    assert res["entries"][1]["size"] == 1
    assert res["entries"][1]["readable"] is True


def test_list_dir_filters_by_extension(tmp_path):
    (tmp_path / "keep.parquet").write_text("x")
    (tmp_path / "KEEP2.PARQUET").write_text("x")
    (tmp_path / "drop.csv").write_text("x")
    (tmp_path / "sub").mkdir()
    res = fs_browser.list_dir(str(tmp_path), include_files=True, extensions=["parquet"])
    # Bare suffixes are accepted, matching is case-insensitive, and dirs are never
    # filtered out — navigation must survive any file filter.
    assert [e["name"] for e in res["entries"]] == ["sub", "keep.parquet", "KEEP2.PARQUET"]


def test_list_dir_hides_files_by_default(tmp_path):
    (tmp_path / "a.parquet").write_text("x")
    (tmp_path / "sub").mkdir()
    assert [e["name"] for e in fs_browser.list_dir(str(tmp_path))["entries"]] == ["sub"]


def test_validate_file_semantics(tmp_path):
    f = tmp_path / "db.duckdb"
    f.write_text("x")
    assert fs_browser.validate_file(str(f)) == {"ok": True, "path": str(f.resolve())}
    assert fs_browser.validate_file(str(f), [".duckdb"])["ok"] is True
    assert fs_browser.validate_file(str(f), [".parquet"])["reason"] == "wrong_extension"
    assert fs_browser.validate_file(str(tmp_path))["reason"] == "not_a_file"
    assert fs_browser.validate_file(str(tmp_path / "nope"))["reason"] == "not_found"
    assert fs_browser.validate_file("")["reason"] == "empty"


def test_validate_file_enforces_roots(monkeypatch, tmp_path):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside.duckdb"
    outside.write_text("x")
    _set_roots(monkeypatch, str(allowed))
    assert fs_browser.validate_file(str(outside))["reason"] == "outside_roots"


def test_validate_readable_dir_accepts_read_only(tmp_path):
    # The Parquet-folder case: read-only is fine, unlike a project binding.
    d = tmp_path / "ro"
    d.mkdir()
    os.chmod(d, 0o500)
    try:
        assert fs_browser.validate_readable_dir(str(d))["ok"] is True
        if os.geteuid() != 0:
            assert fs_browser.validate_dir(str(d))["reason"] == "not_writable"
    finally:
        os.chmod(d, 0o700)


# --- The database `serverPath` boundary --------------------------------------


def test_validate_source_path_enforces_roots(monkeypatch, tmp_path):
    # Persisted by a plain create/PATCH, so the boundary must hold here too.
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    (allowed / "in.duckdb").write_text("x")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "out.duckdb").write_text("x")
    _set_roots(monkeypatch, str(allowed))

    fs_browser.validate_source_path(str(allowed / "in.duckdb"))  # file: ok
    fs_browser.validate_source_path(str(allowed))  # Parquet folder: ok
    fs_browser.validate_source_path("")  # empty clears the pointer

    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.validate_source_path(str(outside / "out.duckdb"))
    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.validate_source_path(str(allowed / "absent.duckdb"))


def test_validate_source_path_rejects_traversal_and_symlink_escape(monkeypatch, tmp_path):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    secret = tmp_path / "secret.duckdb"
    secret.write_text("x")
    _set_roots(monkeypatch, str(allowed))

    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.validate_source_path(str(allowed / ".." / "secret.duckdb"))

    # A symlink inside the root pointing out of it resolves to its target first.
    link = allowed / "escape.duckdb"
    link.symlink_to(secret)
    with pytest.raises(fs_browser.FsBrowseError):
        fs_browser.validate_source_path(str(link))


def test_validate_source_path_ignores_code_execution_flag(monkeypatch, tmp_path):
    # Deliberately unlike validate_binding_path: attaching a database read-only is
    # not code execution, so turning the IDE off must not stop a deployment from
    # pointing Linkr at its own data.
    from app.config import settings

    f = tmp_path / "db.duckdb"
    f.write_text("x")
    _set_roots(monkeypatch, str(tmp_path))
    monkeypatch.setattr(settings, "enable_code_execution", False)
    fs_browser.validate_source_path(str(f))
