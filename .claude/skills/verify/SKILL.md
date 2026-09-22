---
name: verify
description: Build and drive the Linkr web app in a real browser to observe a change working — client-only (WASM) boot, seeding, DuckDB mounting, warehouse pages. Use when verifying a frontend change at its real surface rather than through tests.
---

# Verifying Linkr in a real browser

No Playwright in the repo. Drive the installed Chrome over the DevTools
Protocol with a plain WebSocket — node 23 has a global `WebSocket`, so no
install is needed.

## Build and serve

Client-only (WASM) mode is the interesting one: it exercises the seed, the
boot splash and DuckDB-WASM.

```bash
npm run build:client                       # from repo root
cd apps/web && npx vite preview --port 4317 --strictPort
```

`npm run dev:client` also works, but **dev emits no `boot-size.json`** (it is
written by a `generateBundle` hook), so anything about the boot splash's
progress bar must be verified against a real build.

The 27 MB seed under `apps/web/public/data/seed/` must be present, else there
is no demo content to load (`npm run data:fetch` fetches it; it is gitignored).

## Launch Chrome

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 --user-data-dir=/tmp/prof \
  --no-first-run --no-default-browser-check --headless=new \
  --window-size=1440,900 about:blank
```

A **fresh `--user-data-dir` per run** is what makes a visit a genuine first
run. To re-test a first run without relaunching, clear both:

```js
await S('Network.clearBrowserCache')
await S('Storage.clearDataForOrigin', { origin: 'http://localhost:4317', storageTypes: 'all' })
```

Stats live in IndexedDB (`data_sources.stats`), so a stale profile will show
the *previous* build's numbers and look like a fix that did not work.

## Routes

Deep links need the workspace id, and the seeded one is **`seed-default`**
(not `demo-workspace`, which is the folder name):

- `/workspaces/seed-default/warehouse/databases`
- `/workspaces/seed-default/projects/<projectUid>/warehouse/concepts`

Seeded project uids: `icu-activity-dashboard`, `ecrf-data-example`,
`icu-mortality-prediction`. `/projects/*` redirects to `/workspaces` — a
project page is always nested under its workspace.

Navigating **straight** to a warehouse page (rather than via Home) is what
exercises the mount-race guards in `lib/duckdb/engine.ts`.

## Reading app state

Screenshots plus `document.body.innerText` cover most of it; for anything
about databases, read IndexedDB directly:

```js
Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `
  (async()=>{const req=indexedDB.open('linkr');const db=await new Promise(r=>{req.onsuccess=()=>r(req.result)});
   return await new Promise(r=>{const tx=db.transaction('data_sources','readonly');
     const g=tx.objectStore('data_sources').getAll();g.onsuccess=()=>r(g.result)})})()` })
```

Subscribe to `Runtime.consoleAPICalled` and `Runtime.exceptionThrown` before
navigating — several of these bugs only ever announced themselves there.

## Gotchas

- A cold boot takes ~20-25s to finish seeding. Poll, do not fix a sleep.
- Throttle (`Network.emulateNetworkConditions`, ~2 Mbps) to see the inline
  splash at all; on localhost it is gone within 500ms.
- macOS has no `timeout(1)`.
- Backgrounded node scripts lose stdout here — have the script **write its
  results to a file** and poll for that file.
- `vite preview` serves gzip but sends no `Content-Length`, so a progress
  bar cannot read the total from the response; it comes from
  `boot-size.json`.
