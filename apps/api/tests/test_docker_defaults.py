"""Deployment defaults that keep a user's code from owning the host
(docs/design/spe-security.md §1): the API never serves as root, and its port is
published on loopback only, so nothing reaches it around nginx."""

import os
import re
import stat
import subprocess
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


@pytest.mark.parametrize("name", COMPOSE_FILES)
def test_web_port_on_loopback_unless_chosen(name):
    compose = (DOCKER / name).read_text()
    published = re.findall(r'^\s*-\s*"([^"]*:80)"', compose, re.M)
    assert published == ["${LINKR_WEB_BIND:-127.0.0.1}:3000:80"]


def test_nginx_limits_sign_in_bodies():
    conf = (DOCKER / "nginx.conf").read_text()
    block = re.search(r"location ~ \^/api/v1/\(auth\|setup\)/ \{(.*?)\n    \}", conf, re.S)
    assert block and "client_max_body_size 1m;" in block.group(1)
    assert "proxy_pass http://api:8000;" in block.group(1)


def _stub(folder: Path, name: str, body: str) -> None:
    path = folder / name
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def test_root_part_of_the_entrypoint_stays_out_of_the_data_volume(tmp_path):
    """Kernels write the data volume: as root, the script touches the volume's own
    root and nothing inside it, and it drops root for good."""
    log = tmp_path / "calls"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    record = f'echo "$(basename "$0") $*" >> "{log}"'
    _stub(bin_dir, "id", "echo 0")
    _stub(bin_dir, "stat", "echo root")
    for name in ("mkdir", "chown", "ln", "setpriv"):
        _stub(bin_dir, name, record)
    data_dir = tmp_path / "data"
    subprocess.run(
        ["/bin/sh", str(DOCKER / "api-entrypoint.sh")],
        env={**os.environ, "PATH": f"{bin_dir}:/usr/bin:/bin", "LINKR_DATA_DIR": str(data_dir)},
        check=True,
    )
    calls = log.read_text().splitlines()
    for call in calls:
        if call.startswith(("mkdir", "chown")):
            assert str(data_dir / "_duckdb_tmp") not in call
    chown = next(c for c in calls if c.startswith("chown"))
    assert "-h" in chown.split()[1] or "-Rh" in chown
    assert any(c.startswith("setpriv") and "--no-new-privs" in c for c in calls)


def test_unprivileged_part_of_the_entrypoint_makes_the_spill_folder(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _stub(bin_dir, "id", "echo 1000")
    for name in ("alembic", "uvicorn"):
        _stub(bin_dir, name, "exit 0")
    data_dir = tmp_path / "data"
    subprocess.run(
        ["/bin/sh", str(DOCKER / "api-entrypoint.sh")],
        env={**os.environ, "PATH": f"{bin_dir}:/usr/bin:/bin", "LINKR_DATA_DIR": str(data_dir), "HOME": str(tmp_path)},
        check=True,
    )
    assert (data_dir / "_duckdb_tmp").is_dir()
