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
