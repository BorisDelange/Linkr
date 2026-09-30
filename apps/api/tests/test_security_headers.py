"""API responses are data, never pages (security plan D): nosniff, no framing,
no referrer, and a CSP that runs nothing if one is opened directly."""

API = "/api/v1"


async def test_api_responses_carry_the_security_headers(client):
    for r in (await client.get(f"{API}/health"), await client.get(f"{API}/projects")):
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["x-frame-options"] == "DENY"
        assert r.headers["referrer-policy"] == "no-referrer"
        assert "sandbox" in r.headers["content-security-policy"]
        assert "default-src 'none'" in r.headers["content-security-policy"]


async def test_the_interactive_docs_are_left_alone(client):
    r = await client.get("/docs")
    assert "content-security-policy" not in r.headers
