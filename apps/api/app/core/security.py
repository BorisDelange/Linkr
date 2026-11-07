import asyncio
import gzip
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from functools import cache
from pathlib import Path

from jose import jwt
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


# A bcrypt call holds a CPU for a quarter of a second: it runs off the event loop,
# on a pool of its own, so a burst of logins neither stalls other requests nor
# takes the threads the rest of the server runs its blocking work on.
_hashing = ThreadPoolExecutor(max_workers=2, thread_name_prefix="password-hash")


async def _off_loop(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(_hashing, fn, *args)


@cache
def _no_account_hash() -> str:
    return pwd_context.hash("no account has this password")


def _verify(plain_password: str, hashed_password: str | None) -> bool:
    if hashed_password is None:
        pwd_context.verify(plain_password, _no_account_hash())
        return False
    return pwd_context.verify(plain_password, hashed_password)


async def verify_password_async(plain_password: str, hashed_password: str | None) -> bool:
    """verify_password off the event loop. A missing hash (no such account, or
    none set) costs as much as a wrong password, so the time a refusal takes
    does not tell which usernames exist."""
    return await _off_loop(_verify, plain_password, hashed_password)


# bcrypt hashes only the first 72 bytes: anything past them would be accepted
# and silently ignored.
PASSWORD_MAX_BYTES = 72
_COMMON_PASSWORDS = Path(__file__).parent / "data" / "common-passwords.txt.gz"


@cache
def _common_passwords() -> frozenset[str]:
    with gzip.open(_COMMON_PASSWORDS, "rt", encoding="utf-8") as f:
        return frozenset(line.rstrip("\n") for line in f)


def password_policy_error(password: str, username: str) -> dict | None:
    """Why `password` may not be set for `username` — `{code, message}`, the
    detail of the 422 the caller raises, which the front translates by `code` —
    or None when it may."""
    min_length = settings.password_min_length
    if len(password) < min_length:
        return {"code": "password_too_short", "minLength": min_length,
                "message": f"The password must be at least {min_length} characters."}
    if len(password.encode()) > PASSWORD_MAX_BYTES:
        return {"code": "password_too_long", "maxBytes": PASSWORD_MAX_BYTES,
                "message": f"The password must be at most {PASSWORD_MAX_BYTES} bytes."}
    if password.strip().lower() == username.strip().lower():
        return {"code": "password_is_username", "message": "The password must not be the username."}
    if password.lower() in _common_passwords():
        return {"code": "password_common", "message": "This password is among the most commonly used ones."}
    return None


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


async def hash_password_async(password: str) -> str:
    return await _off_loop(hash_password, password)


def _store_password(user, password_hash: str) -> None:
    user.password_hash = password_hash
    user.password_changed_at = datetime.now(timezone.utc)


def set_password(user, password: str) -> None:
    """Hash `password` onto `user` and end the sessions issued before it."""
    _store_password(user, hash_password(password))


async def set_password_async(user, password: str) -> None:
    """set_password, hashing off the event loop. Also stamped on a new account:
    no session token older than the account itself is ever accepted for it."""
    _store_password(user, await hash_password_async(password))


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _epoch_us(moment: datetime) -> int:
    return (moment - _EPOCH) // timedelta(microseconds=1)


def _issued_at(now: datetime) -> dict:
    """`iat` has whole-second resolution; `iat_us` carries the microseconds a
    password change must be compared against."""
    return {"iat": now, "iat_us": _epoch_us(now)}


def password_stamp(user) -> int:
    """The password state a session is issued from: the microsecond of the last
    change, 0 for none. Read from the same row the credential was checked against."""
    changed = user.password_changed_at
    if changed is None:
        return 0
    if changed.tzinfo is None:
        changed = changed.replace(tzinfo=timezone.utc)
    return _epoch_us(changed)


def predates_password_change(payload: dict, user) -> bool:
    """Whether a session token was issued before `user` last set a password.

    A token carries the password state it was issued from (`pwd`), compared for
    equality: one issued from a row read before a change refuses once the change
    commits, however late it was minted. A token without it (minted before it
    existed) is compared by `iat_us`, or by `iat` with the change floored to the
    second: the tokens handed out right after the change, in the same second,
    must stay valid."""
    stamp = payload.get("pwd")
    if isinstance(stamp, int):
        return stamp != password_stamp(user)
    changed = user.password_changed_at
    if changed is None:
        return False
    if changed.tzinfo is None:
        changed = changed.replace(tzinfo=timezone.utc)
    issued_us = payload.get("iat_us")
    if isinstance(issued_us, int):
        return issued_us < _epoch_us(changed)
    return int(payload.get("iat", 0)) < int(changed.timestamp())


def _session_token(kind: str, user_id: int, username: str, role: str, lifetime: timedelta, stamp: int | None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "type": kind,
        **_issued_at(now),
        "exp": now + lifetime,
    }
    if stamp is not None:
        payload["pwd"] = stamp
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def create_access_token(user_id: int, username: str, role: str, stamp: int | None = None) -> str:
    return _session_token(
        "access", user_id, username, role, timedelta(minutes=settings.access_token_expire_minutes), stamp,
    )


def create_refresh_token(user_id: int, username: str, role: str, stamp: int | None = None) -> str:
    return _session_token(
        "refresh", user_id, username, role, timedelta(days=settings.refresh_token_expire_days), stamp,
    )


def create_kernel_token(user_id: int, username: str, role: str, project_uid: str, *, via: str) -> str:
    """Mint the token injected into a kernel/terminal as ``LINKR_TOKEN``, for the
    client libraries (``linkr::databases()``).

    Deliberately NOT an access token. Anything the user runs in that project can
    read this value out of the environment, so it is narrowed on three axes an
    access token is not:

      * ``type="kernel"`` — ``get_current_user`` accepts only ``type="access"``,
        so this cannot call the general API (no password change, no user admin,
        no minting a longer-lived token from it).
      * ``project`` — bound to the one project whose kernel it was injected into,
        checked on every request, so it cannot read a project the script does not
        run in.
      * ``exp`` — kernel_token_expire_minutes, not 24 hours.
      * ``via`` — how the caller that started the kernel authenticated. Only a
        ``"web"`` one may fetch database recipes: a kernel started by an API key
        runs an agent's code, which must not get the decrypted password.

    It carries the acting user's identity, so the permission checks behind the
    endpoints it may reach resolve to exactly what that user could already do in
    the UI: it never widens reach, it only spares the script a hardcoded path.
    """
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "project": project_uid,
        "via": via,
        "type": "kernel",
        **_issued_at(now),
        "exp": now + timedelta(minutes=settings.kernel_token_expire_minutes),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_token(token: str) -> dict:
    """Decode and validate a JWT token. Raises JWTError on failure."""
    return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
