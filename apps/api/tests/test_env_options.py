"""Install-options resolution: server default ← workspace default ← env override."""

from app.config import settings
from app.services.execution import env_options


def test_resolve_r_layers_override_wins():
    ws = {"r": {"repos": "https://ws-mirror/cran", "method": "wget"}}
    override = {"repos": "https://env-mirror/cran"}
    out = env_options.resolve("r", ws, override)
    # Env override wins for repos; method falls through to the workspace default.
    assert out["repos"] == "https://env-mirror/cran"
    assert out["method"] == "wget"


def test_resolve_falls_back_to_server_default():
    out = env_options.resolve("r", None, {})
    assert out["repos"] == settings.r_repos
    assert "method" not in out  # no method anywhere → unset


def test_resolve_python_index_and_trusted_host():
    ws = {"python": {"indexUrl": "https://ws/simple"}}
    override = {"trustedHost": "ws"}
    out = env_options.resolve("python", ws, override)
    assert out["indexUrl"] == "https://ws/simple"
    assert out["trustedHost"] == "ws"


def test_blank_override_does_not_shadow_workspace():
    ws = {"r": {"repos": "https://ws/cran"}}
    out = env_options.resolve("r", ws, {"repos": "   "})
    assert out["repos"] == "https://ws/cran"


def test_sanitize_drops_unknown_r_method():
    # A method outside renv's allowlist must not reach Rscript source.
    out = env_options.resolve("r", None, {"method": "system('id')"})
    assert "method" not in out


def test_sanitize_ignores_unknown_keys():
    out = env_options.resolve("python", None, {"evil": "x", "indexUrl": "https://ok/simple"})
    assert out == {"indexUrl": "https://ok/simple"}


def test_write_and_read_env_override_roundtrip(tmp_path, monkeypatch):
    spec = tmp_path / "environments" / "r"
    monkeypatch.setattr(
        env_options.project_fs, "env_spec_dir", lambda project_uid, language: spec
    )
    env_options.write_env_override("proj-1", "r", {"repos": "https://m/cran", "method": "curl"})
    assert env_options.read_env_override("proj-1", "r") == {
        "repos": "https://m/cran",
        "method": "curl",
    }
    # Clearing all fields removes the file.
    env_options.write_env_override("proj-1", "r", {"repos": "", "method": ""})
    assert env_options.read_env_override("proj-1", "r") == {}
    assert not (spec / "options.json").exists()


def test_repos_and_index_url_must_be_clean_http_urls():
    """The repo/index URL reaches `Rscript -e` source and uv argv, so a value that
    could terminate the R string literal it lands in is dropped, not quote-stripped
    at the interpolation site."""
    for bad in (
        "https://cran.r-project.org'); system('id'); ('",
        "https://x\\",
        'https://x"y',
        "https://has space/cran",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://x`id`",
        "https://x;id",
    ):
        assert "repos" not in env_options._sanitize("r", {"repos": bad}), bad
        assert "indexUrl" not in env_options._sanitize("python", {"indexUrl": bad}), bad

    ok = "https://packagemanager.posit.co/cran/latest"
    assert env_options._sanitize("r", {"repos": ok})["repos"] == ok
    assert env_options._sanitize("python", {"indexUrl": ok})["indexUrl"] == ok
