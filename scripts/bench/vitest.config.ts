import { defineConfig } from 'vitest/config'
import path from 'path'

// Runs `concept-sql.export.ts` with the web app's aliases, so the bench measures
// the SQL the app actually sends rather than a copy of it.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '../../apps/web/src') } },
  test: { environment: 'node', include: [path.resolve(__dirname, '*.export.ts')] },
})
