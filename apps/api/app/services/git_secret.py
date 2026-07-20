"""Strip the git access token out of an incoming git_remote_config.

The frontend sends the git link as `git_remote_config = {url, branch, authToken?}`.
The token must never be persisted in that JSON (it's returned by the API). It is
stored separately, per (user, host), by git_credential_service — so this module
only splits the token off the config; the caller stores it against the user.
"""


def split_config(config: dict | None) -> tuple[dict | None, str | None]:
    """Return (config_without_token, plaintext_token) from an incoming payload.

    `authToken` (camelCase, as the frontend sends) is removed from the config and
    returned separately. An empty token means "no token in this payload".
    """
    if not config:
        return config, None
    token = config.get("authToken") or None
    stripped = {k: v for k, v in config.items() if k != "authToken"}
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
