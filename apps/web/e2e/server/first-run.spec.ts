import { test, expect, ADMIN } from '../fixtures'

// A fresh server instance (each SPE scenario starts from empty volumes): the
// setup wizard creates the first administrator, then the instance starts empty —
// inside an SPE the catalog is out of reach, so no default data can be installed.
test('the first visit creates the administrator and reaches the home page', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Welcome to Linkr' })).toBeVisible({ timeout: 60_000 })

  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Username').fill(ADMIN.username)
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
  await page.getByLabel('Confirm password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Create Account' }).click()

  // The browser may reach the catalog while the SPE's server cannot: the install
  // is declined rather than left to fail (its failure is DefaultDataStep's own case).
  const install = page.getByRole('checkbox', { name: 'Install the default data' })
  const unreachable = page.getByText('The catalog could not be reached', { exact: false })
  await expect(install.or(unreachable)).toBeVisible({ timeout: 60_000 })
  if (await install.isVisible()) await install.uncheck()
  await page.getByRole('button', { name: 'Start empty', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible()
})
