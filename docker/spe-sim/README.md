# SPE simulation

A local stand-in for the Secure Processing Environment (SPE) Linkr is deployed in at
hospitals (see [docs/deployment-context.md](../../docs/deployment-context.md)). It
models what most SPEs have in common, not one institution's setup:

| At a hospital | Here |
|---|---|
| Per-project container, cut off from the internet | `web-8743` + `api-8743` on the `spe-8743` network, `internal: true` |
| Reached through a gateway under a path prefix | `gateway`: TLS on `https://localhost:8443`, `/docker-8743/` → container `docker-8743` |
| A port opened between the SPE and one other machine | a small internal network holding just those two (`open-8743-mirror`, `open-8743-datamart`) |
| Package mirror (Nexus, Artifactory) | `mirror`: Nexus-style URLs, the only container with internet access |
| The project datamart | `datamart-postgres`, and `datamart-oracle` / `datamart-sqlserver` for connector work |
| Nothing preinstalled in project environments | Python/R project environments start empty and install through the mirror |

## Run

From the repo root (Docker Desktop running):

```bash
export LINKR_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")
docker compose -f docker/spe-sim/docker-compose.yml up --build
```

Open <https://localhost:8443/docker-8743/> and accept the self-signed certificate. `Ctrl+C` stops it; `down -v` also wipes the data.

Add the datamarts you need with profiles:

```bash
docker compose -f docker/spe-sim/docker-compose.yml \
  --profile datamart --profile oracle --profile sqlserver up --build
```

| Database | Host (from Linkr) | Port | Database / service | Login |
|---|---|---|---|---|
| PostgreSQL | `datamart-postgres` | 5432 | `datamart` | `linkr_reader` |
| Oracle Free | `datamart-oracle` | 1521 | service `FREEPDB1` | `linkr_reader` |
| SQL Server 2022 | `datamart-sqlserver` | 1433 | `master` | `sa` |

Password: `$DATAMART_PASSWORD`, default `SpeSim_2026!`. They start empty.

Datamart files (a Parquet export, a DuckDB file) go in `docker/spe-sim/datamart/`, or the
folder `SPE_DATAMART_DIR` names. The SPE sees it read-only at `/datamart`: add it in Linkr
as a database on the server, path `/datamart/<folder>`.

For a large OMOP datamart without real data, `make-datamart.py` generates a synthetic one
there (gitignored, like everything in `datamart/`):

```bash
python3 docker/spe-sim/make-datamart.py              # 20 M rows, ~270 MB, seconds per query
python3 docker/spe-sim/make-datamart.py 240000000    # 240 M rows, ~3.3 GB, minutes per query
```

## Test

Once it is serving, from the repo root:

```bash
docker/spe-sim/smoke-test.sh
```

It checks the gateway, the app and its assets under the prefix, the API, the WebSocket
handshake, that the SPE has no internet route, and that PyPI and CRAN come through the
mirror (and the Postgres datamart, when its profile is up).

Then by hand, in the app:

1. Create the first account, open a project, and run `print(1)` in the IDE terminal:
   the terminal is a WebSocket.
2. Build the project's Python environment with one package (e.g. `six`) and its R
   environment with one package (e.g. `glue`): both must install through the mirror.
3. With `--profile datamart`: add a PostgreSQL database (host `datamart-postgres`, see
   the table above) and open it.
4. Restart the gateway with `GATEWAY_WEBSOCKETS=off` (below): the terminal must fail with
   a message that names the proxy, and `GATEWAY_WEBSOCKETS=off docker/spe-sim/smoke-test.sh`
   must pass.

## Reproduce a misconfigured gateway

The gateway reads its behaviour from the environment, so the proxy variants found
across SPEs are one variable away:

| Variable | Default | Set it to reproduce |
|---|---|---|
| `GATEWAY_WEBSOCKETS` | `on` | `off`: no `Upgrade` header forwarded. Terminal, ETL live log and notifications fail (browser: close code 1006) |
| `GATEWAY_IDLE_TIMEOUT` | `3600s` | `60s`: a quiet terminal or a long query is cut after a minute |
| `GATEWAY_MAX_BODY` | `512m` | `1m` (nginx's default): uploads over 1 MB fail with 413 |
| `GATEWAY_STRIP_PREFIX` | `on` | `off`: the container receives `/docker-8743/…` instead of `/…`. The web image accepts both forms |

```bash
GATEWAY_WEBSOCKETS=off docker compose -f docker/spe-sim/docker-compose.yml up -d gateway
```

Check that a WebSocket handshake gets through (expect `101 Switching Protocols`; Linkr
then closes with 4401 because the token is fake, which is fine):

```bash
curl -k -i -N --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://localhost:8443/docker-8743/api/v1/notifications/ws?token=x"
```

## The mirror

Same URL layout as Nexus proxy repositories, so the settings are the ones an
administrator writes against a real one:

- PyPI: `http://mirror/repository/pypi/simple` (`LINKR_PIP_INDEX_URL`)
- CRAN: `http://mirror/repository/cran/__linux__/noble/latest` for Ubuntu binaries, or
  `…/cran/latest` for sources (`LINKR_R_REPOS`)

The mirror's `@follow_redirect` location proxies whatever `Location` the upstream
answers, with no allowlist — fine for a simulator whose only upstreams are PyPI and
Posit, not a template for a real mirror.

To test a fully offline SPE (no mirror at all): `docker compose … stop mirror`.

## Add a second SPE

Copy the `web-8743` / `api-8743` pair with the new id, add its `spe-<id>` network
(`internal: true`) and volume, put the id in the gateway's `SPE_IDS`, and attach the
gateway to the new network. Two SPEs on separate networks cannot see each other, as at a
hospital.

## Limits

- A Docker network opens every port between its members; a hospital firewall opens one.
  Precision is per machine pair, not per port.
- No SSO at the gateway. The trusted-header sign-in (`LINKR_TRUSTED_HEADER`) would need
  the gateway to inject the identity header and proxy secret.
- Images are built on the host, which has internet access. The SPE side is offline only
  at run time.
