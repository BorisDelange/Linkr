"""Deployment defaults that keep a user's code from owning the host
(security-compliance-plan A1): the API never serves as root, and its port is
published on loopback only, so nothing reaches it around nginx."""

import re
from pathlib import Path

import pytest

DOCKER = Path(__file__).resolve().parents[3] / "docker"
COMPOSE_FILES = ["docker-compose.yml", "docker-compose.hub.yml"]


def test_entrypoint_drops_root_before_serving():
    script = (DOCKER / "api-entrypoint.sh").read_text()
    drop = script.index("setpriv --reuid=linkr")
    assert drop < script.index("alembic upgrade head") < script.index("exec uvicorn")
    assert "useradd" in (DOCKER / "Dockerfile.api").read_text()


@pytest.mark.parametrize("name", COMPOSE_FILES)
def test_api_port_on_loopback_and_data_out_of_root(name):
    compose = (DOCKER / name).read_text()
    published = re.findall(r'^\s*-\s*"([^"]*:8000)"', compose, re.M)
    assert published == ["127.0.0.1:8000:8000"]
    assert "/root/" not in compose
