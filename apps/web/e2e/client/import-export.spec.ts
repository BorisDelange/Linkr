import { test, expect, bootDemo, DEMO_WS, ACTIVITY } from '../fixtures'

test('a project exported as a ZIP comes back whole when imported', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${ACTIVITY}/versioning`)
  await page.getByRole('tab', { name: 'Export' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download ZIP' }).click(),
  ])
  const zip = await download.path()

  await page.goto(`${ACTIVITY}/settings`)
  await page.getByRole('tab', { name: 'Delete project' }).click()
  await page.getByRole('button', { name: 'Delete project' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete project' }).click()
  await expect(page).toHaveURL(new RegExp(`${DEMO_WS}/projects$`))
  await expect(page.getByText('ICU Mortality Prediction Example')).toBeVisible()
  await expect(page.getByText('ICU Dashboard Example')).toHaveCount(0)

  await page.getByRole('button', { name: 'Import' }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByText('Drag and drop a file here, or click to browse').click(),
  ])
  await chooser.setFiles(zip)
  await page.getByText('ICU Dashboard Example').click()

  // Its dashboard and the dataset it reads came back with it.
  await expect(page).toHaveURL(/\/summary$/)
  await page.goto(page.url().replace(/\/summary$/, '/lab/dashboards'))
  await page.getByText('ICU Activity', { exact: true }).click()
  await expect(page.locator('main main')).toContainText(/Unique patients\s*100\s*n = 100/)
})
