"""Documentation that travels as FILES rather than entity metadata: README.md
(+ per-language siblings), LICENSE.md, and the README attachments.

Byte-faithful port of the ``writeReadmeFiles`` / ``writeLicenseFile`` /
``licenseMeta`` / ``stripEntityDocs`` helpers in apps/web/src/lib/entity-io.ts —
every documentable entity (workspace, project, mapping project, SQL collection,
ETL pipeline, DQ rule set, data catalog, schema preset, user plugin) exports the
same shape, so the golden twin tests compare TS and Python output byte for byte.

PURE module: it takes already-loaded camelCase dicts and returns ``{path: bytes}``.
The attachment blobs need a DB + blob-store read, so they are assembled by the
callers (project_export_assemble / workspace_export_assemble).
"""

from typing import Any


def to_localized(value: Any) -> dict:
    """Port of ``toLocalized``: dict stays, a non-empty string becomes
    ``{'en': value}``, empty/None becomes ``{}``."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        return {"en": value}
    return {}


def readme_files(prefix: str, readme: Any) -> dict[str, bytes]:
    """Port of ``writeReadmeFiles``: ``README.md`` for the primary language (en,
    else the first), ``README.<lang>.md`` for the rest, written at ``<prefix>``."""
    if not readme:
        return {}
    by_lang = to_localized(readme)
    langs = [lang for lang in by_lang if by_lang[lang]]
    if not langs:
        return {}
    primary = "en" if "en" in langs else langs[0]
    out: dict[str, bytes] = {}
    for lang in langs:
        suffix = "" if lang == primary else f".{lang}"
        out[f"{prefix}README{suffix}.md"] = str(by_lang[lang]).encode("utf-8")
    return out


def license_file(prefix: str, license: Any) -> dict[str, bytes]:
    """Port of ``writeLicenseFile``: the licence TEXT becomes ``LICENSE.md`` (the
    name both GitHub and GitLab detect); which licence it is stays in the entity
    JSON (see ``license_meta``) so the id round-trips without parsing legalese."""
    if not isinstance(license, dict) or not license.get("text"):
        return {}
    return {f"{prefix}LICENSE.md": str(license["text"]).encode("utf-8")}


def license_meta(license: Any) -> dict | None:
    """Port of ``licenseMeta``: the JSON-safe licence — the text is stripped, it
    travels as LICENSE.md."""
    if not isinstance(license, dict) or not license:
        return None
    if license.get("name"):
        return {"id": license.get("id"), "name": license["name"]}
    return {"id": license.get("id")}


def primary_readme_lang(readme: Any) -> str | None:
    """Port of ``primaryReadmeLang``: the language written to the suffix-free
    ``README.md`` — English when present, else the first non-empty one."""
    if not readme:
        return None
    by_lang = to_localized(readme)
    langs = [lang for lang in by_lang if by_lang[lang]]
    if not langs:
        return None
    return "en" if "en" in langs else langs[0]


def readme_lang_meta(readme: Any) -> str | None:
    """Port of ``readmeLangMeta``: the marker naming the language of the
    suffix-free README.md, omitted when it is English (so the common export stays
    byte-identical to what it was before the marker existed)."""
    primary = primary_readme_lang(readme)
    return primary if primary and primary != "en" else None


def strip_entity_docs(meta: dict) -> dict:
    """Port of ``stripEntityDocs``: drop ``readme`` (it becomes README.md) and
    reduce ``license`` to its identity (the text becomes LICENSE.md). An absent
    licence drops the key entirely — the client's JSON.stringify omits undefined,
    so emitting a null here would break byte-parity.

    ``readmeLang`` is added when the suffix-free README.md is not English, so the
    import knows which language it holds (a French-only readme used to come back
    as English). Key ORDER matters for byte-parity: the client spreads `license`
    then `readmeLang`, so they are appended here in the same order."""
    out = {k: v for k, v in meta.items() if k not in ("readme", "license")}
    licence = license_meta(meta.get("license"))
    if licence is not None:
        out["license"] = licence
    lang = readme_lang_meta(meta.get("readme"))
    if lang is not None:
        out["readmeLang"] = lang
    return out


def entity_doc_files(prefix: str, entity: dict) -> dict[str, bytes]:
    """Port of ``writeEntityDocs`` minus the attachments (which need a DB read):
    README.md (+ per-language siblings) then LICENSE.md."""
    out = readme_files(prefix, entity.get("readme"))
    out.update(license_file(prefix, entity.get("license")))
    return out
