---
name: release
description: Cut a Linkr release — refresh the default data, run every test tier, bump the export-format version (asking patch / minor / major), regenerate the export goldens, pin the Docker Hub images, tag, bring main up to the release and push, then return to the branch you started on. Use when the user asks for a release, a new version, "passer à la version suivante", or to tag vX.Y.Z.
argument-hint: "[patch | minor | major | X.Y.Z]"
---

# Release Linkr

The user asking for a release is what authorizes the version change: CLAUDE.md
otherwise forbids touching a version number. Run the steps in order. **Stop at the
first failure**, report it, and change nothing further. A half-done release (a
tag without its push, main moved but not the tag) is worse than none.

Never start a dev server. Never push Docker images: CI builds them from the tag.

## 0. Preflight

```bash
git branch --show-current          # remember it: START, the branch to return to
git status --short                 # must be clean: a release ships what is committed
git fetch origin --tags
cat VERSION; git tag --sort=-creatordate | head -3
git log --oneline "$(git describe --tags --abbrev=0)"..HEAD | wc -l   # something to release?
```

If the tree is dirty, ask whether to commit or stash. Do not decide alone.
`origin/main` must be an ancestor of START (`git merge-base --is-ancestor origin/main HEAD`).
If it is not, someone pushed to main: merge `origin/main` into START first and
tell the user.

## 1. Ask the bump

Unless the argument already says, ask once with AskUserQuestion: **patch**,
**minor** or **major**. Show the version each choice gives, and recommend
**patch** unless the export format broke compatibility or a large feature landed.
Read the commits since the last tag to support the recommendation.

The new version must be ≥ every entry of `MIN_APP_VERSION` in
`packages/linkr-format/src/app-version.ts`. An entry above the current
`VERSION` means a format change already promised to "the next release". If the
chosen bump stays below it, say so and ask again.

## 2. Dependency fixes

Run the `dependabot-triage` skill and apply only its **non-breaking** fixes,
each one targeted (`npm update <pkg>`, `uv lock --upgrade-package <pkg>` in
`apps/api`), never a blanket update. The images install from the lockfiles, so
a fix landed after the tag waits for the next release. Commit them on START
(`Dependencies: …`). If there is nothing to fix, say so and move on.

## 3. Refresh the default data

```bash
npm run data:fetch
```

Every cached clone of `demo-workspace` and its linked repos must log `updated`
or `cloning`, never `cached` (that would mean an offline run, and stale data).
Check that every database under `apps/web/public/data/seed/default/databases/`
that should carry data has its Parquet files, and that none is a git-lfs pointer:

```bash
du -sh apps/web/public/data/seed/default/databases/*
find apps/web/public/data/seed -name '*.parquet' -size -1k
```

The seed is gitignored, so there is nothing to commit. This step makes the e2e
tier test against the data the release will ship (CI re-fetches it).

## 4. Run every tier

Run the `run-tests` skill with **`full`**: quick, e2e, the matrix with `--spe`,
and every SPE scenario with `--e2e`. Report the timings and results. Any
failure stops the release, even one that looks unrelated or flaky. Show it to
the user and let them decide.

## 5. Bump

With `NEW` the chosen version and `OLD` the current one:

1. `echo NEW > VERSION`. Write it without the `v` and keep the trailing newline,
   as the file already has.
2. Regenerate the export goldens that pin it, from `apps/web`:
   ```bash
   GOLDEN_UPDATE=1 npx vitest run export-golden
   ```
   Then `git diff --stat`: only `appVersion` (and `minAppVersion` where it
   follows `MIN_APP_VERSION`) lines may change, in about 21 `entity.json` /
   `git-links.json` files. Anything else means the format moved without anyone
   noticing. Stop and show it.
3. Check the twins agree: `npx vitest run export-golden` (web) and
   `.venv/bin/python -m pytest -q -p no:cacheprovider tests/test_entity_export_assemble.py tests/test_project_export_assemble.py tests/test_mapping_project_export_assemble.py`
   (in `apps/api`). These are the Python halves of the same goldens.
4. `docker/docker-compose.hub.yml`: set the three image lines to `api-NEW`,
   `web-NEW` and `mcp-NEW`. The tag pipeline refuses to publish if any of them
   disagrees with the tag.
5. `grep -rn "OLD" --include='*.md' docker/ README.md` shows any install
   instructions that name the old tag. Update them only if they pin it on purpose.

Leave `apps/api/app/config.py` `app_version` and `pyproject.toml` alone: the
server version is a separate number, bumped only when the user asks.

## 6. Commit and tag

On START:

```bash
git add VERSION docker/docker-compose.hub.yml apps/web/src/lib/__fixtures__ apps/web/src/lib/concept-mapping/__fixtures__ apps/api/tests
git commit -m "Release: vNEW" -m "<body>"
git tag -a vNEW -m "Export format NEW"
```

Body, as in `v2.4.4`: what the bump touches (VERSION, the goldens, the three
hub lines), which kinds now stamp a `minAppVersion` this release introduces and
what an older app would have misread, and that the server version is left alone.
Stage by path, never `git add -A` (other sessions may share the tree).

## 7. Bring main up and push

```bash
git push origin START                               # pre-push hook runs; let it
```

Then move `main` to the release:

- START **is** `main`: nothing to merge.
- `main` is not checked out anywhere (`git worktree list`):
  `git fetch . START:main` fast-forwards it without a checkout. If it refuses
  (main diverged), fall back to `git checkout main && git merge --no-ff START`,
  then `git checkout START`.
- `main` is checked out in another worktree: git will refuse. Give the user the
  `git -C <that worktree> merge --ff-only START` command, and push only once
  they have run it.

```bash
git push origin main
git push origin vNEW      # last: the tag is what starts the image build
```

## 8. Return and report

`git checkout START` if you left it, then `git branch --show-current` to prove
it. Report:

- the version, the tag and the main commit;
- the test results per tier, with times;
- the dependency fixes applied, or "none";
- the CI pipeline to watch (the tag job on framagit). Once it is green, the
  images `interhop/linkr:{api,web,mcp}-NEW` are on Docker Hub;
- any user-visible change that likely needs a page in `linkr-website`
  (`update-website-docs` skill).
