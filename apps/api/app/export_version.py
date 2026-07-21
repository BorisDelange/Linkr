"""Export-format version stamped into exported entities (e.g. project.json's
``appVersion``).

This is NOT the server/deployment version (that is ``config.app_version``, shown
in logs, /health and the OpenAPI title). It is the *content* version written into
exports, and it MUST equal the frontend's single source of truth
(apps/web/src/lib/version.ts ``APP_VERSION``): a front-only client and a server
client versioning the same repo both write this string, so any drift would
fabricate a false git diff. The project-export golden tests pin it, so a drift
fails CI rather than shipping silently.
"""

EXPORT_APP_VERSION = "2.1.2"
