"""Where things live in an exported entity tree — the Python side.

Hand-kept twin of ``packages/linkr-format/src/layout.ts``. The front and this
module must name the same files: the export golden tests compare the two trees
byte for byte, so a drift here is a red build rather than a silent divergence.
Change one, change the other in the same commit.
"""

# The one manifest name every entity export uses. Readers stay tolerant of the
# per-kind names that preceded it (project.json, _pipeline.json, …) so already
# published repos keep importing; writers only ever emit this.
ENTITY_MANIFEST = "entity.json"

# The folder an entity's user-authored file tree lives in. A pipeline's
# `mapping/` is NOT part of this: it holds machine-generated vocabulary CSVs the
# ETL scripts read by path, and stays a sibling at the root.
SCRIPTS_DIR = "scripts"

# A pipeline's machine-managed vocabulary folder (MAPPING_DIR in the app). The
# generated script reads `mapping/<name>.csv` by that exact path and the
# readiness check looks for the folder at the pipeline root, so it does NOT move
# under SCRIPTS_DIR with the user's own files.
MAPPING_DIR = "mapping"


def script_export_path(path: str) -> str:
    """Where a pipeline file lands in the export tree: under ``scripts/`` unless
    it belongs to the machine-managed ``mapping/`` folder."""
    if path == MAPPING_DIR or path.startswith(f"{MAPPING_DIR}/"):
        return path
    return f"{SCRIPTS_DIR}/{path}"


def with_entity_type(meta: dict, entity_type: str) -> dict:
    """Insert ``type`` right after the identity keys, mirroring ``withEntityType``
    in entity-io.ts. Position is load-bearing: the golden tests compare bytes."""
    out: dict = {}
    if "id" in meta:
        out["id"] = meta["id"]
    if "entityId" in meta:
        out["entityId"] = meta["entityId"]
    out["type"] = entity_type
    for key, value in meta.items():
        if key not in ("id", "entityId"):
            out[key] = value
    return out

# Sidecars: machine-written files describing the files beside them. Never a
# manifest — that distinction is what the leading `_` is for.
SIDECAR_TREE = "_tree.json"
SIDECAR_ATTACHMENT_META = "_meta.json"

# Files that are content, not metadata, and are read by name.
CONTENT_SCHEMA_DDL = "schema.ddl"
CONTENT_DQ_CHECKS = "checks.json"
CONTENT_PLUGIN_MANIFEST = "plugin.json"
CONTENT_SOURCE_CONCEPTS = "source-concepts.csv"

# Files describing the export as a whole rather than one folder's contents.
ROOT_ORGANIZATION = "organization.json"
ROOT_GIT_LINKS = "git-links.json"
ROOT_README = "README.md"
ROOT_LICENSE = "LICENSE.md"

# `entity.json`'s own declaration of what it is. Kind detection used to be a
# filename lookup, which cannot survive one shared manifest name. The vocabulary
# is deliberately the catalog entry schema's `type`, so the two never need
# translating.
TYPE_PROJECT = "project"
TYPE_WORKSPACE = "workspace"
TYPE_MAPPING_PROJECT = "mapping-project"
TYPE_SQL_COLLECTION = "sql-collection"
TYPE_ETL_PIPELINE = "etl-pipeline"
TYPE_SCHEMA_PRESET = "schema-preset"
TYPE_DQ_RULE_SET = "dq-rule-set"
TYPE_DATA_CATALOG = "data-catalog"
TYPE_USER_PLUGIN = "user-plugin"
TYPE_DATABASE = "database"
