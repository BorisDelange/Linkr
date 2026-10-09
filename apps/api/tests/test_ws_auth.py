"""ws_auth: a browser's session JWT may ride in `?token=`; a personal API token
only in the Authorization header, since access logs record the query string."""

from app.core import ws_auth

API = "/api/v1"


class _FakeSocket:
    def __init__(self, query: dict | None = None, headers: dict | None = None):
        self.query_params = query or {}
        self.headers = headers or {}
        self.accepted = False
        self.closed_with: int | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int) -> None:
        assert self.accepted, "closed during the handshake: the browser would read 1006"
        self.closed_with = code


async def _tokens(client) -> tuple[str, str]:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    jwt = (await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})).json()["access_token"]
    key = (await client.post(f"{API}/auth/api-tokens", headers={"Authorization": f"Bearer {jwt}"}, json={"name": "mcp"})).json()["token"]
    return jwt, key


async def test_session_jwt_in_the_query_string_or_the_header(client):
    jwt, _ = await _tokens(client)
    for socket in (_FakeSocket(query={"token": jwt}), _FakeSocket(headers={"authorization": f"Bearer {jwt}"})):
        user = await ws_auth.authenticate_ws(socket)
        assert user is not None and user.username == "admin" and socket.closed_with is None


async def test_api_token_only_in_the_header(client):
    _, key = await _tokens(client)
    socket = _FakeSocket(headers={"authorization": f"Bearer {key}"})
    assert (await ws_auth.authenticate_ws(socket)).username == "admin"

    socket = _FakeSocket(query={"token": key})
    assert await ws_auth.authenticate_ws(socket) is None
    assert socket.closed_with == ws_auth.WS_AUTH_FAILED


async def test_no_or_bad_token_is_refused(client):
    await _tokens(client)
    for socket in (_FakeSocket(), _FakeSocket(query={"token": "nope"}), _FakeSocket(headers={"authorization": "Bearer lnk_nope"})):
        assert await ws_auth.authenticate_ws(socket) is None
        assert socket.closed_with == ws_auth.WS_AUTH_FAILED
