"""The environment every user-reachable child process starts from: kernels, the
PTY terminal and the package provisioners (whose installs run package code).

Built from an allowlist, never from `os.environ` minus a few names: the API's own
environment holds LINKR_SECRET_KEY (forges any JWT), LINKR_ENCRYPTION_KEY (opens
every stored password), the database URL and git tokens, and a child runs code
its user wrote. The LINKR_* bridge a kernel needs (project_fs.runtime_env) is
added by the caller on top, never inherited."""

import os

_NAMES = frozenset({
    "PATH", "HOME", "USER", "LOGNAME", "SHELL",
    "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP",
    "LD_LIBRARY_PATH",
    "PYTHONPATH", "PYTHONIOENCODING", "PYTHONUTF8", "PYTHONUNBUFFERED",
    "MPLBACKEND", "MPLCONFIGDIR",
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
})
_PREFIXES = ("LC_", "R_", "RENV_", "XDG_")

# Package installs reach an institution mirror, maybe through a proxy; kernels
# have no business with the proxy credentials or the mirror's settings.
_PROVISION_NAMES = frozenset({
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
})
_PROVISION_PREFIXES = ("UV_", "PIP_")

# Named here so a later widening of the allowlist (say a "LINKR_" prefix) still
# cannot let them through.
SECRET_NAMES = frozenset({
    "LINKR_SECRET_KEY", "LINKR_ENCRYPTION_KEY", "LINKR_ENCRYPTION_OLD_KEYS", "LINKR_DATABASE_URL",
})


def child_env(extra: dict[str, str] | None = None, *, provision: bool = False) -> dict[str, str]:
    names = _NAMES | _PROVISION_NAMES if provision else _NAMES
    prefixes = _PREFIXES + _PROVISION_PREFIXES if provision else _PREFIXES
    env = {
        k: v for k, v in os.environ.items()
        if (k in names or k.startswith(prefixes)) and k not in SECRET_NAMES
    }
    if extra:
        env.update(extra)
    return env
