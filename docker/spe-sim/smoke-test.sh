#!/usr/bin/env bash
# Checks a running SPE simulation end to end: the gateway serves the app under its
# prefix, the WebSocket handshake gets through (or is refused, when the gateway is
# set to drop it), the SPE has no internet route, and packages come through the
# mirror. Run from the repo root once `docker compose … up` is serving:
#
#   docker/spe-sim/smoke-test.sh
#
# GATEWAY_WEBSOCKETS=off in the environment flips the expectation of the
# WebSocket check, to confirm the simulation does reproduce a blocking proxy.
set -uo pipefail

compose=(docker compose -f "$(dirname "$0")/docker-compose.yml")
# `exec` never reads it, but compose refuses the file while it is unset.
export LINKR_SECRET_KEY="${LINKR_SECRET_KEY:-unused-by-exec}"
base="https://localhost:${SPE_GATEWAY_PORT:-8443}"
spe="$base/docker-8743"
failures=0

check() {
  local label=$1; shift
  if "$@"; then echo "  ok    $label"; else echo "  FAIL  $label"; failures=$((failures + 1)); fi
}

in_api() { "${compose[@]}" exec -T api-8743 python3 -c "$1" >/dev/null 2>&1; }

gateway_up() { curl -ksf -o /dev/null "$base/"; }

redirect_keeps_port() {
  [ "$(curl -ks -o /dev/null -w '%{redirect_url}' "$spe")" = "$spe/" ]
}

app_served() {
  local html asset
  html=$(curl -ksf "$spe/") || return 1
  asset=$(grep -o 'src="/docker-8743/assets/[^"]*\.js"' <<<"$html" | head -1 | cut -d'"' -f2)
  [ -n "$asset" ] || return 1
  curl -ksf -o /dev/null -w '%{content_type}' "$base$asset" | grep -q javascript
}

# Checks the type too: a container that cannot route the path answers index.html, with a 200.
api_healthy() { curl -ksf -o /dev/null -w '%{content_type}' "$spe/api/v1/health" | grep -q json; }

# Linkr closes right after the 101 (the token is fake), and curl reports that as an
# error: keep the status line, not curl's exit code.
websocket_upgrades() {
  local status
  status=$(curl -ks -i -N --http1.1 --max-time 5 \
    -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
    "$spe/api/v1/notifications/ws?token=x" 2>/dev/null | head -1)
  [[ $status == *" 101 "* ]]
}

websocket_refused() { ! websocket_upgrades; }

# Succeeds only by running in the container and failing to connect: an `exec`
# that could not run at all must not pass for "offline".
spe_offline() {
  in_api "
import sys, urllib.request as u
try:
    u.urlopen('https://pypi.org/simple/', timeout=5)
except OSError:
    sys.exit(0)
sys.exit(1)"
}

mirror_serves_pypi() {
  in_api "
import urllib.request as u
page = u.urlopen('http://mirror/repository/pypi/simple/six/', timeout=30).read().decode()
assert '/repository/pypi/files/' in page and 'files.pythonhosted.org' not in page
link = page.split('href=\"')[1].split('\"')[0]
assert u.urlopen(link, timeout=60).status == 200"
}

# R's user agent is what makes the repository answer with a binary, which it
# serves by redirecting to a CDN: the mirror must follow that itself.
mirror_serves_cran() {
  in_api "
import urllib.request as u
repo = 'http://mirror/repository/cran/__linux__/noble/latest/src/contrib/'
index = u.urlopen(repo + 'PACKAGES', timeout=60).read().decode()
version = index.split('Package: glue\\n')[1].split('Version: ')[1].split('\\n')[0]
req = u.Request(repo + 'glue_' + version + '.tar.gz', headers={'User-Agent': 'R/4.5.1 R (4.5.1 aarch64-unknown-linux-gnu aarch64 linux-gnu)'})
assert len(u.urlopen(req, timeout=60).read()) > 1000"
}

datamart_reachable() {
  in_api "import socket; socket.create_connection(('datamart-postgres', 5432), timeout=5)"
}

echo "SPE simulation — $spe"
check "gateway answers" gateway_up
check "/docker-8743 redirects to /docker-8743/ on the same port" redirect_keeps_port
check "app page and its JS assets load under the prefix" app_served
check "API health through the gateway" api_healthy
if [ "${GATEWAY_WEBSOCKETS:-on}" = "off" ]; then
  check "WebSocket handshake refused (gateway set to drop it)" websocket_refused
else
  check "WebSocket handshake upgraded (101)" websocket_upgrades
fi
check "SPE has no internet route" spe_offline
check "PyPI through the mirror, file links rewritten" mirror_serves_pypi
check "CRAN through the mirror" mirror_serves_cran
if "${compose[@]}" ps --services --status running | grep -qx datamart-postgres; then
  check "datamart-postgres reachable from the SPE" datamart_reachable
fi

echo
[ "$failures" -eq 0 ] && echo "All checks passed." || echo "$failures check(s) failed."
exit $((failures > 0))
