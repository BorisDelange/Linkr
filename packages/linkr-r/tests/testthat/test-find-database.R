fixture <- list(
  list(id = "a1b2", alias = "mimic_iv", name = "MIMIC-IV",
       engine = "postgresql", dialect = "duckdb",
       kind = "external", connectable = TRUE),
  list(id = "c3d4", alias = "datamart", name = "Datamart", engine = "duckdb",
       dialect = "duckdb", kind = "managed", connectable = TRUE)
)

test_that("a database resolves by alias", {
  expect_equal(.linkr_find_database(fixture, "mimic_iv")$id, "a1b2")
})

test_that("the display name is not an address", {
  # Addressing by name would break the day someone renames the database, and a
  # name can be localized — there is no single "the" name to match on.
  expect_error(
    .linkr_find_database(fixture, "MIMIC-IV"), "No database with alias"
  )
})

test_that("the uuid is not an address", {
  # Stable, but unreadable in the code a reviewer has to read.
  expect_error(.linkr_find_database(fixture, "a1b2"), "No database with alias")
})

test_that("a duplicate alias is reported, not silently resolved", {
  # Nothing enforces alias uniqueness today. Returning whichever row came first
  # is how a script quietly reads the wrong database.
  dupes <- list(
    list(id = "c3d4", alias = "datamart", name = "A"),
    list(id = "e5f6", alias = "datamart", name = "B")
  )
  expect_error(
    .linkr_find_database(dupes, "datamart"), "Several databases share the alias"
  )
  expect_error(.linkr_find_database(dupes, "datamart"), "e5f6")
})

test_that("a row without an alias does not crash the lookup", {
  # An older server predating the field must produce a plain "not found", not
  # vapply's "values must be length 1".
  expect_error(
    .linkr_find_database(list(list(id = "x", name = "N")), "nope"),
    "No database with alias"
  )
})

test_that("an unknown alias lists what is available", {
  expect_error(.linkr_find_database(fixture, "nope"), "No database with alias")
  expect_error(.linkr_find_database(fixture, "nope"), "mimic_iv")
})

test_that("an empty project reports no databases rather than failing oddly", {
  expect_error(.linkr_find_database(list(), "anything"), "\\(none\\)")
})
