test_that("on a Linkr server, a dependency still installing says to wait for its job", {
  lib <- tempfile("client-lib")
  dir.create(lib)
  old <- Sys.getenv("LINKR_CLIENT_R_LIB", unset = NA)
  on.exit(if (is.na(old)) Sys.unsetenv("LINKR_CLIENT_R_LIB") else Sys.setenv(LINKR_CLIENT_R_LIB = old))
  Sys.setenv(LINKR_CLIENT_R_LIB = lib)
  expect_error(.linkr_dep("linkrNoSuchPackage"), "still installing on this server")
})

test_that("outside Linkr, a missing dependency says how to install it", {
  old <- Sys.getenv("LINKR_CLIENT_R_LIB", unset = NA)
  on.exit(if (is.na(old)) Sys.unsetenv("LINKR_CLIENT_R_LIB") else Sys.setenv(LINKR_CLIENT_R_LIB = old))
  Sys.unsetenv("LINKR_CLIENT_R_LIB")
  expect_error(.linkr_dep("linkrNoSuchPackage"), 'install.packages("linkrNoSuchPackage")', fixed = TRUE)
})
