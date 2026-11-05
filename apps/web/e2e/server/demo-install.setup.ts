import { test, expect, ADMIN } from '../fixtures'

// The first run of a fresh instance WITH the default data: the state the
// versioning journeys start from. Not a journey of its own (no .spec suffix):
// `npm run test:versioning` runs it once through the `server-demo-setup`
// project and snapshots the instance. Needs the public catalog (network).
test('the first visit creates the administrator and installs the demo workspace', async ({ page }) => {
  test.setTimeout(900_000)
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Welcome to Linkr' })).toBeVisible({ timeout: 60_000 })

  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Username').fill(ADMIN.username)
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
  await page.getByLabel('Confirm password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Create Account' }).click()

  const install = page.getByRole('checkbox', { name: 'Install the default data' })
  await expect(install).toBeVisible({ timeout: 60_000 })
  await install.check()
  await page.getByRole('button', { name: 'Install and finish', exact: true }).click()
  await expect(page.getByText('The demo workspace has been installed.')).toBeVisible({ timeout: 900_000 })
  await page.getByRole('button', { name: 'Finish', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible()
})
