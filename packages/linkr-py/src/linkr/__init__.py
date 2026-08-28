"""Reach the current Linkr project from a script running in its IDE.

    import linkr

    linkr.datasets_dir()            # where datasets live
    linkr.databases()               # what this project can query
    with linkr.connect("MIMIC-IV") as con:
        df = con.execute("SELECT * FROM person LIMIT 10").df()

Paths come from the environment the kernel was started with, never from the
working directory; databases are resolved server-side against the acting user's
own permissions. See the module docstrings for why each is done that way.
"""

from ._api import LinkrError
from ._databases import connect, databases
from ._paths import datasets_dir, ide_dir, project_dir, scripts_dir

__all__ = [
    "LinkrError",
    "connect",
    "databases",
    "datasets_dir",
    "ide_dir",
    "project_dir",
    "scripts_dir",
]
