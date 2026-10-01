test_that("a schema-qualified Parquet table opens as a view in its schema", {
  # The server names a module (or DDL-placed) table `hosp.admissions`; a view
  # literally called "hosp.admissions" answered neither `hosp.admissions` nor
  # the bare `admissions`.
  skip_if_not_installed("duckdb")
  dir <- tempfile()
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  seed <- DBI::dbConnect(duckdb::duckdb())
  for (name in c("admissions", "patients")) {
    DBI::dbExecute(seed, sprintf(
      "COPY (SELECT 1 AS id) TO '%s' (FORMAT parquet)",
      file.path(dir, paste0(name, ".parquet"))
    ))
  }
  DBI::dbDisconnect(seed, shutdown = TRUE)
  con <- .linkr_open_parquet(list(
    list(table = "hosp.admissions", paths = file.path(dir, "admissions.parquet")),
    list(table = "patients", paths = file.path(dir, "patients.parquet"))
  ))
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  expect_equal(DBI::dbGetQuery(con, "SELECT id FROM hosp.admissions")$id, 1)
  expect_equal(DBI::dbGetQuery(con, "SELECT id FROM admissions")$id, 1)
  expect_equal(DBI::dbGetQuery(con, "SELECT id FROM patients")$id, 1)
})
