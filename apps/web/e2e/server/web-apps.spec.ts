import { test, expect, signIn } from '../fixtures'

// A web app started from the IDE is served by the API under its own path, so it
// must work behind the SPE gateway's prefix with no port opened. Standard library
// only: the SPE has no internet, and a framework would come through the mirror.
test.beforeEach(async ({ page }) => signIn(page))

const SITE = {
  'serve.py': '# A static site, started with a custom command.\n',
  'index.html': '<!doctype html><h1>Static site</h1><p id="out">loading</p><script src="app.js"></script>\n',
  // Relative URLs resolve under the app's mount point, gateway prefix included.
  'app.js': "fetch('data.json').then((r) => r.json()).then((d) => { document.getElementById('out').textContent = d.message })\n",
  'data.json': '{"message": "Served through Linkr"}\n',
}

test('a script runs as a web app in its own tab, then stops', async ({ page }) => {
  const stamp = Date.now()
  await page.goto('./workspaces')
  await page.getByRole('button', { name: 'New workspace' }).click()
  await page.getByLabel('Workspace name').fill(`E2E web apps ${stamp}`)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name: `E2E web apps ${stamp}` })).toBeVisible()
  await page.goto(page.url().replace(/\/home$/, '/projects'))
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(`E2E web app ${stamp}`)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/\/projects\/[^/]+\/summary$/)
  const projectUrl = page.url().replace(/\/summary$/, '')

  // The URL names the project by a slug; the API wants its uid.
  const token = await page.evaluate(() => localStorage.getItem('linkr-access-token'))
  const headers = { Authorization: `Bearer ${token}` }
  const projects: { uid: string; name: { en?: string } }[] = await (await page.request.get('./api/v1/projects', { headers })).json()
  const projectUid = projects.find((p) => p.name.en === `E2E web app ${stamp}`)!.uid
  for (const [path, content] of Object.entries(SITE)) {
    const res = await page.request.post('./api/v1/ide-files', {
      headers,
      data: { projectUid, path, type: 'file', content },
    })
    expect(res.ok(), `${res.status()} ${await res.text()}`).toBeTruthy()
  }

  await page.goto(`${projectUrl}/ide`)
  await page.getByText('serve.py', { exact: true }).click()
  await page.locator('button[aria-haspopup="menu"]:has(svg.lucide-chevron-down)').first().click()
  await page.getByRole('menuitem', { name: 'Run as web app' }).click()

  // Not a framework Linkr knows: it asks for the command.
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Command')).toHaveValue('python serve.py')
  await dialog.getByLabel('Command').fill('python -m http.server "$PORT" --bind 127.0.0.1')
  await dialog.getByRole('button', { name: 'Run as web app' }).click()

  const app = page.frameLocator('iframe[title="serve.py"]')
  await expect(app.getByRole('heading', { name: 'Static site' })).toBeVisible({ timeout: 60_000 })
  await expect(app.getByText('Served through Linkr')).toBeVisible()

  await page.getByRole('button', { name: 'Stop the app' }).click()
  await expect(page.getByText('The app is stopped.')).toBeVisible()
})
