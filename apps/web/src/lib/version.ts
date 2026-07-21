/** The Linkr export-format app version. Single source of truth is the repo-root
 *  VERSION file, injected at build time by vite.config.ts (`define: __APP_VERSION__`,
 *  typed in types/globals.d.ts). The backend reads the SAME file (apps/api/app/
 *  export_version.py) so front-only and server exports stamp project.json with an
 *  identical `appVersion` — a drift would fabricate false git diffs. */
export const APP_VERSION = __APP_VERSION__
