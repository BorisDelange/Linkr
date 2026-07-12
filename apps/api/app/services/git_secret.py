"""Encrypted git access-token handling, shared by project & workspace services.

The frontend sends the git link as `git_remote_config = {url, branch, authToken?}`.
The token must not be persisted in that JSON (it's returned by the API); instead
it's pulled out, encrypted with Fernet, and stored in a dedicated
`git_remote_secret` column — mirroring data_source_service's secret handling.
"""

from app.core import crypto


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
    """Mutate `changes` in place so a git_remote_config update stores the token
    encrypted on `entity.git_remote_secret` and keeps it out of the JSON column.

    Absence of a token in the payload leaves the stored secret untouched (editing
    the branch/url won't wipe the credential); an explicit empty config (unlink)
    clears it.
    """
    if "git_remote_config" not in changes:
        return
    config, token = split_config(changes["git_remote_config"])
    if config is None or config == {}:
        entity.git_remote_secret = None
    elif token is not None:
        entity.git_remote_secret = crypto.encrypt(token)
    changes["git_remote_config"] = config


def token_for(entity) -> str | None:
    """Decrypt the stored git token for a clone/push (server-side only)."""
    secret = getattr(entity, "git_remote_secret", None)
    return crypto.decrypt(secret) if secret else None
