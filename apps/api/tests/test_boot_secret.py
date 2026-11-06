"""An instance does not boot on the shipped default key, and is warned about any other weak one."""

import pytest

from app import main
from app.config import settings


@pytest.mark.parametrize("key", ["change-me", "CHANGE-ME", "dev-secret-change-in-production", "short", ""])
def test_a_known_or_short_signing_key_is_weak(key):
    assert main.weak_secret_key(key)


def test_a_generated_signing_key_is_not():
    assert not main.weak_secret_key("suitably-long-random-looking-value-0123456789")


async def test_the_app_refuses_to_start_on_the_shipped_default(monkeypatch):
    monkeypatch.setattr(settings, "secret_key", "dev-secret-change-in-production")
    monkeypatch.setattr(settings, "debug", False)
    with pytest.raises(RuntimeError, match="LINKR_SECRET_KEY"):
        async with main.lifespan(main.app):
            pass


@pytest.mark.parametrize("key", ["change-me", "a-key-of-15-char"])
async def test_an_instance_running_on_another_weak_key_still_starts_and_is_warned(monkeypatch, key):
    class Reached(Exception):
        pass

    def stop_after_the_check():
        raise Reached

    warned = []
    monkeypatch.setattr(settings, "secret_key", key)
    monkeypatch.setattr(settings, "debug", False)
    monkeypatch.setattr(main.trusted_header, "configuration_error", stop_after_the_check)
    monkeypatch.setattr(main.logger, "warning", lambda event, **_: warned.append(event))
    with pytest.raises(Reached):
        async with main.lifespan(main.app):
            pass
    assert "weak_secret_key" in warned
