# forge-sim — a local GitLab for testing merge requests

A throwaway GitLab CE on `http://localhost:8929`, so the versioning flows that
need a forge (merge requests, plan §6/§9.4 in
`docs/planning/collaborative-versioning-plan.md`) are tested without any real
account. Nothing leaves the machine. Needs ~4 GB of RAM while it runs.

```bash
docker compose -p linkr-forge-sim up -d     # first boot: a few minutes
./seed.sh                                   # users alice + bob, group sandbox, a token each
```

Tokens land in `.tokens/alice` and `.tokens/bob` (gitignored). The passwords are
random and never used: everything goes through the tokens. Root's API token is
`forge-sim-root-token-00001` — fine for a container bound to 127.0.0.1 and
thrown away, never for anything else.

Point Linkr at it: start the API with `LINKR_GIT_ALLOWED_HOSTS=localhost:8929`
(the remote is plain http on a loopback address, which is refused otherwise),
then use `http://localhost:8929/sandbox/<repo>.git` as a remote with alice's or
bob's token.

```bash
docker compose -p linkr-forge-sim down       # stop, keep the data
docker compose -p linkr-forge-sim down -v    # stop and wipe everything
```
