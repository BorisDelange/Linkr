import { test, expect, bootDemo, DEMO_WS } from '../fixtures'

test('the demo mapping project filters its mappings and opens one', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${DEMO_WS}/warehouse/concept-mapping/projects`)
  await page.getByText('MIMIC-IV Demo', { exact: true }).click()
  await expect(page.getByText('1,786 of 5,636 source concepts mapped')).toBeVisible()

  await page.getByRole('tab', { name: 'Mappings' }).click()
  await expect(page.getByRole('row', { name: /Chloride, Whole Blood/ }).first()).toBeVisible()
  // The first column filter is the source concept name.
  await page.getByRole('textbox', { name: '...' }).first().fill('Heart Rate')
  const heartRate = page.getByRole('row', { name: /^d_items Heart Rate Exact LOINC Heart rate / })
  await expect(heartRate).toBeVisible()
  await expect(page.getByRole('row', { name: /Chloride, Whole Blood/ })).toHaveCount(0)

  await heartRate.getByRole('cell', { name: 'Heart Rate', exact: true }).click()
  const detail = page.locator('main main')
  await expect(detail).toContainText(/Source concept code\s*220045/)
  await expect(detail).toContainText(/Patients\s*100/)
  await expect(detail).toContainText(/Target concept ID\s*3027018/)
  await expect(detail).toContainText(/Target concept code\s*8867-4/)
})
