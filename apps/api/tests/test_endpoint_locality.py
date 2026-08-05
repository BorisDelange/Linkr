import pytest

from app.services.llm.endpoint_locality import is_local_endpoint


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:11434/v1",
        "http://LOCALHOST:11434/v1",  # case-insensitive
        "http://127.0.0.1:11434/v1",
        "http://127.1.2.3:8080/v1",  # whole 127/8 is loopback
        "http://[::1]:11434/v1",
        "https://localhost/v1",
        "localhost:11434",  # bare host:port, no scheme
        "http://192.168.1.50:11434/v1",  # RFC1918
        "http://10.0.0.7:8000/v1",
        "http://172.16.31.4:8000/v1",
        "http://169.254.10.10:8000/v1",  # link-local
        "http://[fd00::1]:11434/v1",  # RFC4193 unique-local
        "http://ollama:11434/v1",  # bare hostname (docker service)
        "http://gpu-box.internal:8000/v1",
        "http://llm.lan/v1",
        "http://server.local:11434/v1",
        "http://host.home.arpa/v1",
        "http://0.0.0.0:11434/v1",  # unspecified = binds locally
    ],
)
def test_local_endpoints(url):
    assert is_local_endpoint(url) is True


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com/v1",
        "https://api.anthropic.com/v1",
        "https://api.mistral.ai/v1",
        "https://generativelanguage.googleapis.com/v1",
        "http://8.8.8.8:11434/v1",  # public IP
        "http://[2001:4860:4860::8888]/v1",  # public IPv6
        "https://ollama.example.com/v1",  # internal-looking name, public TLD
        "https://my-llm.fly.dev/v1",
        # 172.32 is outside the 172.16/12 private block — a classic off-by-one.
        "http://172.32.0.1:8000/v1",
        # Public host whose PATH mentions localhost must not fool the check.
        "https://evil.example.com/localhost/v1",
        # Userinfo trick: the real host is evil.com, not localhost.
        "http://localhost@evil.com/v1",
    ],
)
def test_remote_endpoints(url):
    assert is_local_endpoint(url) is False


@pytest.mark.parametrize("url", ["", "   ", None, "not a url", "http://", "://x"])
def test_unusable_input_is_remote(url):
    """Unparseable input must never take the permissive path."""
    assert is_local_endpoint(url) is False
