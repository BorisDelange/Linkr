# `linkr` — Python client library

Reach the current Linkr project from a script running in its IDE.

```python
import linkr

linkr.project_dir(); linkr.scripts_dir(); linkr.datasets_dir()
linkr.databases()

with linkr.connect("MIMIC-IV") as con:
    df = con.execute("SELECT * FROM person LIMIT 10").df()
```

The R equivalent is `packages/linkr-r` (`linkr_connect()`, `linkr_databases()`,
…): same model, each language's own naming convention.

Run the tests with `pytest tests` from this directory.
