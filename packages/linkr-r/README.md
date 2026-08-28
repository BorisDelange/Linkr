# `linkr` — R client library

Reach the current Linkr project from a script running in its IDE.

```r
library(linkr)
library(DBI)

linkr_project_dir(); linkr_scripts_dir(); linkr_datasets_dir()
linkr_databases()

con <- linkr_connect("MIMIC-IV")
dbGetQuery(con, "SELECT * FROM person LIMIT 10")
dbDisconnect(con, shutdown = TRUE)
```

The Python equivalent is `packages/linkr-py` (`linkr.connect()`,
`linkr.databases()`, …): same model, each language's own naming convention.

Run the tests with
`Rscript -e 'pkgload::load_all("."); testthat::test_dir("tests/testthat")'`.
