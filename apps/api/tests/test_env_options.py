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
    ws = {"python": {"indexUrl": "https://ws/simple", "trustedHost": "ws"}}
    out = env_options.resolve("python", ws, {"trustedHost": "ws"})
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


def test_plain_http_and_tls_off_only_for_a_mirror_the_server_or_workspace_chose(monkeypatch):
    # Package downloads are code the server runs: a project override may not
    # route them over plain http, or with TLS checks off, to a host of its choice.
    from app.config import settings

    monkeypatch.setattr(settings, "pip_index_url", "http://mirror.chu.local/simple")
    monkeypatch.setattr(settings, "r_repos", "https://cran.chu.local")
    ws = {"python": {"indexUrl": "https://ws-mirror.local/simple"}}
    py = lambda override: env_options.resolve("python", ws, override)  # noqa: E731

    assert py({"indexUrl": "http://mirror.chu.local/other"})["indexUrl"] == "http://mirror.chu.local/other"
    assert py({"indexUrl": "http://evil.example/simple"})["indexUrl"] == "https://ws-mirror.local/simple"
    assert py({"indexUrl": "https://evil.example/simple"})["indexUrl"] == "https://ws-mirror.local/simple"
    assert "trustedHost" not in py({"trustedHost": "evil.example"})
    assert env_options.resolve("r", None, {"repos": "http://evil.example"})["repos"] == "https://cran.chu.local"
    # The workspace layer itself (an owner's choice) may use them.
    assert env_options.resolve("python", {"python": {"indexUrl": "http://ws.local/s", "trustedHost": "ws.local"}}, {}) == {
        "indexUrl": "http://ws.local/s", "trustedHost": "ws.local",
    }


def test_an_override_cannot_downgrade_a_mirror_the_upper_layers_reach_over_https(monkeypatch):
    monkeypatch.setattr(settings, "pip_index_url", "https://pypi.chu.local/simple")
    monkeypatch.setattr(settings, "r_repos", "https://cran.chu.local")
    ws = {"python": {"indexUrl": "https://ws-mirror.local/simple"}, "r": {"repos": "https://ws-cran.local"}}
    py = lambda override: env_options.resolve("python", ws, override)  # noqa: E731

    assert py({"indexUrl": "http://ws-mirror.local/simple"})["indexUrl"] == "https://ws-mirror.local/simple"
    assert py({"indexUrl": "http://pypi.chu.local/simple"})["indexUrl"] == "https://ws-mirror.local/simple"
    assert env_options.resolve("r", ws, {"repos": "http://cran.chu.local"})["repos"] == "https://ws-cran.local"
    assert "trustedHost" not in py({"trustedHost": "ws-mirror.local"})
    assert "trustedHost" not in py({"trustedHost": "pypi.chu.local"})


def test_an_override_may_repeat_what_an_upper_layer_set():
    ws = {"python": {"indexUrl": "http://ws.local/simple", "trustedHost": "ws.local"}}
    out = env_options.resolve("python", ws, {"indexUrl": "http://ws.local/other", "trustedHost": "WS.local"})
    assert out == {"indexUrl": "http://ws.local/other", "trustedHost": "WS.local"}


def test_once_the_deployment_names_a_mirror_a_project_index_stays_on_it(monkeypatch):
    monkeypatch.setattr(settings, "pip_index_url", "https://pypi.chu.local/simple")
    monkeypatch.setattr(settings, "r_repos", "https://cran.chu.local/latest")

    def py(ws, override):
        return env_options.resolve("python", ws, override)


    assert py(None, {"indexUrl": "https://elsewhere.example/simple"})["indexUrl"] == "https://pypi.chu.local/simple"
    assert py(None, {"indexUrl": "https://pypi.chu.local/other"})["indexUrl"] == "https://pypi.chu.local/other"
    ws = {"python": {"indexUrl": "https://ws.chu.local/simple"}}
    assert py(ws, {"indexUrl": "https://ws.chu.local/x"})["indexUrl"] == "https://ws.chu.local/x"
    assert py(ws, {"indexUrl": "https://elsewhere.example/simple"})["indexUrl"] == "https://ws.chu.local/simple"
    r = env_options.resolve("r", None, {"repos": "https://cran.chu.local/2024-01-01,https://elsewhere.example"})
    assert r["repos"] == "https://cran.chu.local/latest"
    assert env_options.resolve("r", None, {"repos": "https://cran.chu.local/2024-01-01"})["repos"] == (
        "https://cran.chu.local/2024-01-01"
    )


def test_with_the_public_default_a_project_may_pick_another_https_index(monkeypatch):
    monkeypatch.setattr(settings, "pip_index_url", type(settings).model_fields["pip_index_url"].default)
    out = env_options.resolve("python", None, {"indexUrl": "https://other.example/simple"})
    assert out["indexUrl"] == "https://other.example/simple"


def test_a_listed_repository_is_confined_url_by_url(monkeypatch):
    out = env_options.resolve("r", {"r": {"repos": "https://ws/cran"}}, {"repos": "https://ws/cran,http://other/cran"})
    assert out["repos"] == "https://ws/cran"

    out = env_options.resolve(
        "r", {"r": {"repos": "https://a/cran,http://b/cran"}}, {"repos": "https://c/cran,http://b/cran"},
    )
    assert out["repos"] == "https://c/cran,http://b/cran"


def test_credentials_are_masked_in_every_url_of_a_list():
    masked = env_options.mask_credentials({
        "repos": "https://a.example/cran,https://u:s3cret@b.example/cran,http://x:p@ss@c.example", "method": "curl",
    })
    assert masked == {"repos": "https://a.example/cran,https://***@b.example/cran,http://***@c.example", "method": "curl"}
    assert env_options.mask_credentials({"indexUrl": "https://a.example/simple"}) == {"indexUrl": "https://a.example/simple"}


def test_a_masked_url_sent_back_keeps_the_stored_credentials():
    stored = {"repos": "https://u:s3cret@b.example/cran"}
    assert env_options.keep_masked({"repos": "https://***@b.example/cran"}, stored) == stored
    assert env_options.keep_masked({"repos": "https://b.example/cran"}, stored) == {"repos": "https://b.example/cran"}
    assert env_options.keep_masked({"repos": "https://***@other.example/cran"}, stored) == {}


def test_a_mask_is_never_used_as_a_url():
    out = env_options.resolve("r", {"r": {"repos": "https://***@b.example/cran"}}, {"repos": "https://***@c.example/cran"})
    assert out["repos"] == settings.r_repos
