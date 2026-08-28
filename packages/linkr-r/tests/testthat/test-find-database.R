fixture <- list(
  list(id = "a1b2", name = "MIMIC-IV", engine = "postgresql", dialect = "duckdb",
       kind = "external", connectable = TRUE),
  list(id = "c3d4", name = "Datamart", engine = "duckdb", dialect = "duckdb",
       kind = "managed", connectable = TRUE),
  list(id = "e5f6", name = "Datamart", engine = "duckdb", dialect = "duckdb",
       kind = "managed", connectable = FALSE)
)

test_that("a database resolves by name", {
  expect_equal(.linkr_find_database(fixture, "MIMIC-IV")$id, "a1b2")
})

test_that("a database resolves by id", {
  expect_equal(.linkr_find_database(fixture, "c3d4")$name, "Datamart")
})

test_that("an id wins over a name, so an exact id is never ambiguous", {
  # Two sources share the name "Datamart"; asking by id must still work.
  expect_equal(.linkr_find_database(fixture, "e5f6")$id, "e5f6")
})

test_that("an ambiguous name is an error naming the ids to choose from", {
  expect_error(.linkr_find_database(fixture, "Datamart"), "Several databases")
  expect_error(.linkr_find_database(fixture, "Datamart"), "c3d4")
})

test_that("an unknown name lists what is available", {
  expect_error(.linkr_find_database(fixture, "nope"), "No database named")
  expect_error(.linkr_find_database(fixture, "nope"), "MIMIC-IV")
})

test_that("an empty project reports no databases rather than failing oddly", {
  expect_error(.linkr_find_database(list(), "anything"), "\\(none\\)")
})
