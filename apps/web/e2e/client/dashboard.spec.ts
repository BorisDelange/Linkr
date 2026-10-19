import { test, expect, bootDemo, ACTIVITY } from '../fixtures'

test('the demo dashboard computes its indicators', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${ACTIVITY}/lab/dashboards`)
  await page.getByText('ICU Activity', { exact: true }).click()
  const main = page.locator('main main')
  await expect(main.getByText('Unique patients')).toBeVisible()
  await expect(main).toContainText(/Unique patients\s*100\s*n = 100/)
  await expect(main).toContainText(/ICU stays\s*172\s*n = 172/)
  await expect(main.getByText(/error/i)).toHaveCount(0)
})
