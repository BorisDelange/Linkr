test_that("an external database's search path lists every data schema, default first", {
  # A preset naming a second schema (`vocab.concept`) read "schema does not
  # exist" while the default schema alone was on the path.
  skip_if_not_installed("duckdb")
  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  DBI::dbExecute(con, "ATTACH ':memory:' AS ext")
  for (schema in c("CORE", "VOCAB", "mysql")) {
    DBI::dbExecute(con, sprintf('CREATE SCHEMA ext."%s"', schema))
  }
  DBI::dbExecute(con, 'CREATE TABLE ext."VOCAB".concept AS SELECT 2 AS id')
  path <- .linkr_external_search_path(con, "core")
  expect_true(startsWith(path, "memory,ext.CORE,"))
  expect_false(grepl("mysql", path))
  DBI::dbExecute(con, sprintf("SET search_path = %s", .linkr_quote(con, path)))
  expect_equal(DBI::dbGetQuery(con, "SELECT id FROM vocab.concept")$id, 2)
})
