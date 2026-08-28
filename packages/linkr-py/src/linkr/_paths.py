"""Where this project's files live.

A Linkr project has three server directories that are bound independently and can
each be re-pointed: the IDE working dir, the code sub-tree that gets exported, and
the datasets dir. Out of the box the first two are the same folder, which is
exactly why deriving one from another (``"../datasets"``, ``os.getcwd()``) works
until someone re-points a binding and then silently reads the wrong place. The
kernel exports all four as environment variables; these functions read them, and
nothing else.

Outside a Linkr session — a plain ``python`` run on a laptop — none of the
variables are set. Rather than guess, every accessor falls back to the working
directory and warns once, so a script runs in both places but never quietly
writes somewhere unintended.
"""

import os
import warnings
from pathlib import Path

_warned: set[str] = set()


def _env_path(var: str) -> Path:
    value = os.environ.get(var, "")
    if value:
        return Path(value)
    if var not in _warned:
        _warned.add(var)
        warnings.warn(
            f"{var} is not set: not running inside a Linkr IDE session. "
            f"Falling back to the working directory ({os.getcwd()}).",
            RuntimeWarning,
            stacklevel=3,
        )
    return Path.cwd()


def project_dir() -> Path:
    return _env_path("LINKR_PROJECT")


def scripts_dir() -> Path:
    return _env_path("LINKR_SCRIPTS")


def datasets_dir() -> Path:
    return _env_path("LINKR_DATASETS")


def ide_dir() -> Path:
    return _env_path("LINKR_IDE")
