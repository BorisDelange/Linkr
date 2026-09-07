/**
 * Parity fixture for the dataset ops replay engine.
 *
 * The client replays ops to render an edited dataset; the server replays the same
 * log to build the Parquet cache the IDE, dashboards and exports read. A drift
 * means the two disagree about what the dataset *contains* — silently, since both
 * sides look internally consistent.
 *
 * This runs the shared fixture against the TS engine; the Python twin runs the
 * same file (apps/api/tests/test_dataset_ops_parity.py), so neither can quietly
 * diverge.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { canonicalOp, opsHash, replayOps, type DatasetOp, type ReplayInput } from './dataset-ops.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../../../apps/web/src/lib/dataset-ops.fixture.json')

interface Fixture {
  canonical: { ops: DatasetOp[]; expected: Record<string, unknown>[]; hash: string }
  cases: { name: string; input: ReplayInput; ops: DatasetOp[]; expected: ReplayInput }[]
}

describe('replayOps parity fixture', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as Fixture

  it('loads the shared fixture', () => {
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      expect(replayOps(testCase.input, testCase.ops)).toEqual(testCase.expected)
    })
  }
})

describe('canonical wire form parity', () => {
  const { canonical } = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as Fixture

  it('emits the fixture keys in the fixture order', () => {
    // Compared as JSON, not toEqual: key ORDER is the property under test, and the
    // export builders write this verbatim.
    const emitted = canonical.ops.map(canonicalOp)
    expect(emitted.map((o) => JSON.stringify(o))).toEqual(
      canonical.expected.map((o) => JSON.stringify(o)),
    )
  })

  it('hashes to the fixture digest', () => {
    expect(opsHash(canonical.ops)).toBe(canonical.hash)
  })
})
