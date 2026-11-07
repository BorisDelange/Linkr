"""Strip the git access token out of an incoming git_remote_config.

The frontend sends the git link as `git_remote_config = {url, branch, authToken?}`.
The token must never be persisted in that JSON (it's returned by the API), nor in
its URL, which every reader and export of the entity sees. It is stored separately,
per (user, host), by git_credential_service — so this module only splits the token
off the config; the caller stores it against the user.
"""

import re
from urllib.parse import unquote, urlsplit, urlunsplit

from app.core.redact import redact_secrets

# `user@host:path`, git's scp-like ssh form: the user is an ssh login, no secret.
_SCP_REMOTE = re.compile(r"[\w.-]+@[^/]+:")


def split_url(url: str) -> tuple[str, str | None]:
    """(`url` without credentials, the password it held). An http(s) remote loses
    its whole userinfo (a token may be the name alone), any remote its query and
    fragment; an ssh user names no secret and stays. A form with no scheme that
    carries a userinfo or a query is read as the https remote git would reach
    (`oauth2:TOKEN@host/r` → `https://host/r`); `git@host:repo` stays as written."""
    if "://" not in url and not _SCP_REMOTE.match(url):
        clean, password = split_url(f"https://{url}")
        if clean != f"https://{url}":
            return clean, password
        return url, None
    try:
        parts = urlsplit(url)
        host = parts.hostname and parts.netloc.rsplit("@", 1)[-1]
        username, password = parts.username, parts.password
    except ValueError:
        return redact_secrets(url), None
    if not parts.scheme or not host:
        return url, None
    keeps_user = parts.scheme not in ("http", "https") and username
    netloc = f"{username}@{host}" if keeps_user else host
    clean = urlunsplit(parts._replace(netloc=netloc, query="", fragment=""))
    return clean, unquote(password) if password else None


def split_config(config: dict | None) -> tuple[dict | None, str | None]:
    """Return (config_without_token, plaintext_token) from an incoming payload.

    `authToken` (camelCase, as the frontend sends) is removed from the config and
    returned separately, or failing it the password its URL held. An empty token
    means "no token in this payload".
    """
    if not config:
        return config, None
    token = config.get("authToken") or None
    stripped = {k: v for k, v in config.items() if k != "authToken"}
    if isinstance(stripped.get("url"), str):
        stripped["url"], from_url = split_url(stripped["url"])
        token = token or from_url
    return stripped, token


def apply_to_entity(entity, changes: dict) -> None:
    """Strip any `authToken` from a git_remote_config update before it's persisted.

    The token is stored per (user, host) by git_credential_service, never on the
    entity — so here we only ensure it can't leak into the entity's JSON column.
    `changes["git_remote_config"]` is rewritten in place to the token-less config;
    `entity` is accepted for call-site symmetry but no longer mutated.
    """
    if "git_remote_config" not in changes:
        return
    config, _token = split_config(changes["git_remote_config"])
    changes["git_remote_config"] = config
