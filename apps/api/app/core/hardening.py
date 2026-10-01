"""Process-level hardening of the API against code running as the same OS user.

Kernels run as the API's user (docs/design/spe-security.md §1), so without this a
kernel could read the API's environment — LINKR_SECRET_KEY, LINKR_ENCRYPTION_KEY,
the trusted-proxy secret — from /proc/<api pid>/environ, or attach a debugger."""

import ctypes
import ctypes.util
import sys

import structlog

logger = structlog.get_logger()

PR_SET_DUMPABLE = 4
PR_GET_DUMPABLE = 3


def _libc():
    return ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)


def forbid_same_user_inspection() -> bool:
    """Make this process non-dumpable (Linux), which hands its /proc entries to
    root and refuses ptrace from same-user processes. Children reset the flag on
    exec, so kernels are unaffected. Never fails the boot; False when not applied."""
    if not sys.platform.startswith("linux"):
        return False
    try:
        if _libc().prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE) failed")
    except (OSError, AttributeError) as exc:
        logger.warning("non_dumpable_failed", error=str(exc))
        return False
    return True


def is_dumpable() -> bool | None:
    if not sys.platform.startswith("linux"):
        return None
    return bool(_libc().prctl(PR_GET_DUMPABLE, 0, 0, 0, 0))
