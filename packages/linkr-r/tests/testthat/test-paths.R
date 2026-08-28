test_that("each path comes from its own variable, not from a sibling", {
  withr_vars <- c(
    LINKR_PROJECT = "/srv/proj", LINKR_SCRIPTS = "/srv/code",
    LINKR_DATASETS = "/mnt/big/data", LINKR_IDE = "/srv/home"
  )
  old <- Sys.getenv(names(withr_vars), unset = NA)
  do.call(Sys.setenv, as.list(withr_vars))
  on.exit({
    set <- old[!is.na(old)]
    if (length(set)) do.call(Sys.setenv, as.list(set))
    unset <- names(old)[is.na(old)]
    if (length(unset)) Sys.unsetenv(unset)
  })

  # The bindings are independent: datasets living on another volume must not be
  # derived from the project dir.
  expect_equal(linkr_project_dir(), "/srv/proj")
  expect_equal(linkr_scripts_dir(), "/srv/code")
  expect_equal(linkr_datasets_dir(), "/mnt/big/data")
  expect_equal(linkr_ide_dir(), "/srv/home")
})

test_that("an unset variable falls back to the working directory and warns", {
  old <- Sys.getenv("LINKR_DATASETS", unset = NA)
  Sys.unsetenv("LINKR_DATASETS")
  rm(list = ls(.linkr_warned), envir = .linkr_warned)
  on.exit(if (!is.na(old)) Sys.setenv(LINKR_DATASETS = old))

  expect_warning(path <- linkr_datasets_dir(), "not running inside a Linkr")
  expect_equal(path, getwd())
})

test_that("the fallback warns once, not on every call", {
  old <- Sys.getenv("LINKR_SCRIPTS", unset = NA)
  Sys.unsetenv("LINKR_SCRIPTS")
  rm(list = ls(.linkr_warned), envir = .linkr_warned)
  on.exit(if (!is.na(old)) Sys.setenv(LINKR_SCRIPTS = old))

  expect_warning(linkr_scripts_dir())
  expect_silent(linkr_scripts_dir())
})

test_that("an empty variable counts as unset", {
  old <- Sys.getenv("LINKR_PROJECT", unset = NA)
  Sys.setenv(LINKR_PROJECT = "")
  rm(list = ls(.linkr_warned), envir = .linkr_warned)
  on.exit(if (!is.na(old)) Sys.setenv(LINKR_PROJECT = old) else Sys.unsetenv("LINKR_PROJECT"))

  expect_warning(path <- linkr_project_dir())
  expect_equal(path, getwd())
})
