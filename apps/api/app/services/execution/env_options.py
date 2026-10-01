"""Install options for a project's environment — the repo/index/method/SSL
settings passed to renv/uv when resolving and installing packages.

Two layers, resolved most-specific-first:
  1. per-env override — ``environments/<lang>/options.json`` (versioned in git, so
     it travels with the project);
  2. workspace default — ``Workspace.default_env_options`` (inherited by every
     project in the workspace);
  3. server config — ``settings.r_repos`` / ``settings.pip_index_url`` (the
     deployment-wide fallback).

Only non-empty values override; a blank field falls through to the next layer.

Shape (camelCase, matching the frontend):
  R:      {"repos": "https://…", "method": "curl"}
  Python: {"indexUrl": "https://…", "trustedHost": "host"}
"""

import json
import re
from pathlib import Path
from urllib.parse import urlsplit

from app.config import settings
from app.services import project_fs

# Only these keys are honoured per language — anything else in a stored options
# blob is ignored (defence against a hand-edited options.json smuggling values).
_ALLOWED = {
    "r": ("repos", "method"),
    "python": ("indexUrl", "trustedHost"),
}
# renv's download.file.method allowlist — reject anything else so the value can't
# smuggle R code when it reaches Rscript.
_R_METHODS = {"auto", "libcurl", "curl", "wget", "internal", "wininet"}
# A repo/index URL reaches `Rscript -e` source (old.packages/install.packages) and uv
# argv, so constrain it here rather than relying on quote-stripping at each
# interpolation site: http(s) only, and no quote/backslash/whitespace/control char
# that could terminate the R string literal it lands in.
_URL_KEYS = ("repos", "indexUrl")
_URL_RE = re.compile(r"^https?://[^\s'\"\\`;]+$")


def _options_path(project_uid: str, language: str) -> Path:
    return project_fs.env_spec_dir(project_uid, language) / "options.json"


def read_env_override(project_uid: str, language: str) -> dict:
    """The per-env options.json (empty dict if none)."""
    path = _options_path(project_uid, language)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return {}
    return _sanitize(language, data)


def write_env_override(project_uid: str, language: str, options: dict) -> None:
    """Persist the per-env override (versioned in git). Empty values are dropped so
    the file only records real overrides."""
    clean = {k: v for k, v in _sanitize(language, options).items() if v}
    path = _options_path(project_uid, language)
    path.parent.mkdir(parents=True, exist_ok=True)
    if clean:
        path.write_text(json.dumps(clean, indent=2, sort_keys=True) + "\n")
    elif path.exists():
        # No overrides left → remove the file rather than leave an empty {}.
        path.unlink()


def resolve(language: str, workspace_default: dict | None, env_override: dict) -> dict:
    """Merge server config → workspace default → env override (most specific wins),
    keeping only non-empty values. Returns the effective options for `language`."""
    server = _server_defaults(language)
    ws = _sanitize(language, (workspace_default or {}).get(language) or {})
    override = _confine_override(_sanitize(language, env_override), (server, ws))
    merged = dict(server)
    for layer in (ws, override):
        for k, v in layer.items():
            if v:
                merged[k] = v
    return merged


def _server_defaults(language: str) -> dict:
    if language == "r":
        return {"repos": settings.r_repos}
    return {"indexUrl": settings.pip_index_url}


def _sanitize(language: str, data: dict) -> dict:
    """Keep only allowed keys with string values; validate the R method and any
    repo/index URL. An invalid value is DROPPED (the next layer — ultimately the
    server config — supplies a known-good default) rather than passed through."""
    allowed = _ALLOWED.get(language, ())
    out: dict = {}
    for key in allowed:
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            out[key] = val.strip()
    if language == "r" and out.get("method") and out["method"] not in _R_METHODS:
        # An unknown method would reach Rscript source — drop it, don't smuggle it.
        out.pop("method", None)
    for key in _URL_KEYS:
        if out.get(key) and not _URL_RE.match(out[key]):
            out.pop(key, None)
    return out


def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def _is_plain_http(url: str) -> bool:
    return url.lower().startswith("http://")


def _confine_override(override: dict, upper_layers: tuple[dict, ...]) -> dict:
    """Plain http and trustedHost (TLS checks off) are for an internal mirror the
    administrator (server config) or a workspace owner (workspace default) chose.
    A project's options.json — edited by any editor, and imported with the project
    from git — cannot send package downloads, code the server will run, over an
    unauthenticated channel to a host of its own choosing, nor downgrade a mirror
    an upper layer reaches over https: plain http only to a host an upper layer
    itself uses over http, trustedHost only as an upper layer set it."""
    http_hosts = {
        _host(v) for layer in upper_layers for k, v in layer.items() if k in _URL_KEYS and _is_plain_http(v)
    }
    trusted = {layer["trustedHost"].lower() for layer in upper_layers if layer.get("trustedHost")}
    out = dict(override)
    for key in _URL_KEYS:
        if _is_plain_http(out.get(key, "")) and _host(out[key]) not in http_hosts:
            out.pop(key, None)
    if out.get("trustedHost") and out["trustedHost"].strip().lower() not in trusted:
        out.pop("trustedHost", None)
    return out
