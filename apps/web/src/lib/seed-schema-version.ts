/**
 * Seed baseline schema version — the single shared contract between the (Node) hash plugin
 * `vite-plugin-seed-hashes.ts` and the (browser) change detector `seed-change-detector.ts`.
 *
 * Kept in its own dependency-free module so the browser side can import it as a value
 * without pulling in the plugin's Node-only deps (e.g. `crypto`).
 *
 * Bump this when the shape of `seed-hashes.json` / the stored baseline changes; an
 * older-or-absent value triggers a silent baseline reset (no spurious "everything changed").
 */
// 3: workspaces carry `workspaceIdentity`, without which a replaced default workspace
// reads as an edited one. Every baseline predates the field, so they reset rather than
// diff against an identity they cannot have.
export const SEED_HASHES_SCHEMA_VERSION = 3
