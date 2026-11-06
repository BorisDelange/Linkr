import type { Page } from '@playwright/test'
import { test, expect, bootDemo, MORTALITY } from '../fixtures'

const openDataset = (page: Page) => page.getByText('mortality_dataset.csv', { exact: true }).click()
const FIRST_ROW = (page: Page, age: number) =>
  page.getByRole('row', { name: new RegExp(`^1 34577403 10003400 23559586 ${age} F `) })

test('a project dataset opens as a table', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${MORTALITY}/lab/datasets`)
  await page.getByText('mortality_dataset.csv', { exact: true }).click()
  await expect(page.getByRole('columnheader', { name: /in_hospital_death/ })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: /heart_rate_max/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /^1 34577403 10003400 23559586 72 F / })).toBeVisible()
})

async function editFirstAge(page: Page) {
  await page.goto(`${MORTALITY}/lab/datasets`)
  await openDataset(page)
  await expect(FIRST_ROW(page, 72)).toBeVisible()
  await page.getByRole('button', { name: 'Edit data' }).click()
  await FIRST_ROW(page, 72).getByRole('cell', { name: '72', exact: true }).dblclick()
  await page.keyboard.insertText('99')
  await page.keyboard.press('Enter')
  await expect(FIRST_ROW(page, 99)).toBeVisible()
}

async function undoFromHistory(page: Page) {
  // The toolbar's counter of recorded changes opens the history.
  await page.getByRole('button', { name: '1', exact: true }).click()
  await page.getByRole('button', { name: 'Undo last change' }).click()
  await page.keyboard.press('Escape')
}

async function reloadDataset(page: Page) {
  await page.reload()
  await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 90_000 })
  await openDataset(page)
}

test('a cell edit survives a reload', async ({ page }) => {
  await bootDemo(page)
  await editFirstAge(page)
  await reloadDataset(page)
  await expect(FIRST_ROW(page, 99)).toBeVisible()
})

test('undoing a cell edit restores the value, for good', async ({ page }) => {
  await bootDemo(page)
  await editFirstAge(page)
  await undoFromHistory(page)
  await expect(FIRST_ROW(page, 72)).toBeVisible()
  await reloadDataset(page)
  await expect(FIRST_ROW(page, 72)).toBeVisible()
})

test('undoing after a reload restores the value @known-bug', async ({ page }) => {
  await bootDemo(page)
  await editFirstAge(page)
  await reloadDataset(page)
  await page.getByRole('button', { name: 'Edit data' }).click()
  await undoFromHistory(page)
  await expect(FIRST_ROW(page, 72)).toBeVisible()
})
