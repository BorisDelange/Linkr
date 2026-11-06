"""An instance does not boot in production with a key anyone can guess."""

import pytest

from app import main
from app.config import settings


@pytest.mark.parametrize("key", ["change-me", "CHANGE-ME", "dev-secret-change-in-production", "short", ""])
def test_a_known_or_short_signing_key_is_weak(key):
    assert main.weak_secret_key(key)


def test_a_generated_signing_key_is_not():
    assert not main.weak_secret_key("suitably-long-random-looking-value-0123456789")


async def test_the_app_refuses_to_start_on_a_weak_key(monkeypatch):
    monkeypatch.setattr(settings, "secret_key", "change-me")
    monkeypatch.setattr(settings, "debug", False)
    with pytest.raises(RuntimeError, match="LINKR_SECRET_KEY"):
        async with main.lifespan(main.app):
            pass
