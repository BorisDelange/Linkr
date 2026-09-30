"""Response headers for the API.

An API response is data for the app's own code, never a page to render: if one
is opened directly (an HTML attachment, a JSON body sniffed as HTML), it must
not run script, be framed, or leak the URL it came from. Only `/api/`: the
interactive docs are pages and load their own assets. The web app's own headers
are nginx's (docker/nginx.conf).
"""

_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'; sandbox"),
]


class SecurityHeadersMiddleware:
    """Pure ASGI, so streamed and file responses get the headers too."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return

        async def with_headers(message):
            if message["type"] == "http.response.start":
                present = {name.lower() for name, _ in message.get("headers", [])}
                message.setdefault("headers", [])
                message["headers"] = list(message["headers"]) + [
                    (name, value) for name, value in _HEADERS if name not in present
                ]
            await send(message)

        await self.app(scope, receive, with_headers)
