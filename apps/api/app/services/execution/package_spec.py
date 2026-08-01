"""Validate user-supplied package specs before they reach `uv`/`renv`.

Package names/versions arrive from the API (add/remove/upgrade) and are fed to
package managers — for R via ``Rscript -e`` source, where an unescaped value is a
code-injection (RCE) vector. Rather than escape per-target, we reject anything
outside a strict allowlist up front: real PyPI/CRAN package refs only contain
``[A-Za-z0-9._-]`` in the name and an optional ``==``/``>=``/… version of the same
class. This runs at the API boundary (schema validator + route params) AND in the
provisioners (defence in depth), so no code path can smuggle a shell/R metachar
(``"``, ``'``, ``;``, ``)``, ``#``, backtick, newline) through.
"""

import re

# name[operator version] — e.g. "pandas", "numpy==1.26", "dplyr@1.1.4", ">=1.2".
# Name + version are restricted to the characters real PyPI/CRAN refs use, so a
# metacharacter that could break out of an R string / shell word is rejected.
_OPERATORS = ("==", ">=", "<=", "~=", "!=", ">", "<", "@")
# Must START with an alphanumeric — a leading dash would be parsed as a CLI flag
# by uv (`-rf` etc.); real package names never start with `-`/`.`.
_PART_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class InvalidPackageSpec(ValueError):
    """A package spec contains characters outside the safe allowlist."""


def _split_spec(spec: str) -> tuple[str, str]:
    """Return (name, version) splitting on the first operator; version '' if none."""
    for op in _OPERATORS:
        idx = spec.find(op)
        if idx != -1:
            return spec[:idx], spec[idx + len(op):]
    return spec, ""


def validate_package_spec(spec: str) -> str:
    """Return the spec unchanged if it's a safe ``name[==version]`` ref, else raise
    ``InvalidPackageSpec``. Both the package name and the version (if present) must
    match ``[A-Za-z0-9._-]+``; empty parts are rejected."""
    stripped = spec.strip()
    if not stripped:
        raise InvalidPackageSpec("Empty package spec")
    name, version = _split_spec(stripped)
    if not _PART_RE.match(name.strip()):
        raise InvalidPackageSpec(f"Invalid package name: {spec!r}")
    if version and not _PART_RE.match(version.strip()):
        raise InvalidPackageSpec(f"Invalid package version: {spec!r}")
    return stripped


def validate_package_specs(specs: list[str]) -> list[str]:
    """Validate a list of specs; raise on the first bad one."""
    return [validate_package_spec(s) for s in specs]
