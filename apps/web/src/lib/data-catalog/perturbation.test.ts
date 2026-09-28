import { describe, expect, it } from 'vitest'
import { addKeys, fallbackKey, KEY_SPACE, noiseOf, patientKeySql, perturbed } from './perturbation'

describe('noiseOf', () => {
  it('stays within ±noise, and is the same for the same key', () => {
    for (let key = 0; key < KEY_SPACE; key += 9_973_411) {
      const n = noiseOf(key, 'patients', 3)
      expect(n).toBeGreaterThanOrEqual(-3)
      expect(n).toBeLessThanOrEqual(3)
      expect(noiseOf(key, 'patients', 3)).toBe(n)
    }
  })

  it('spreads evenly over its values, centred on 0', () => {
    const seen = new Map<number, number>()
    let sum = 0
    for (let key = 0; key < 70_000; key++) {
      const n = noiseOf(key * 61_363, 'records', 3)
      seen.set(n, (seen.get(n) ?? 0) + 1)
      sum += n
    }
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual([-3, -2, -1, 0, 1, 2, 3])
    for (const count of seen.values()) expect(count / 70_000).toBeCloseTo(1 / 7, 1)
    expect(Math.abs(sum / 70_000)).toBeLessThan(0.05)
  })

  it('gives the counts of one cell unrelated noises', () => {
    let same = 0
    for (let key = 1; key <= 1000; key++) if (noiseOf(key * 7919, 'patients', 3) === noiseOf(key * 7919, 'records', 3)) same++
    expect(same / 1000).toBeLessThan(0.25)
  })

  it('is nothing without noise', () => {
    expect(noiseOf(123, 'patients', 0)).toBe(0)
    expect(perturbed(42, 123, 'patients', 0, 10)).toBe(42)
  })
})

describe('perturbed', () => {
  it('never shows a published cell below the threshold, nor a count below zero', () => {
    for (let key = 0; key < 5000; key++) {
      expect(perturbed(10, key * 104_729, 'patients', 5, 10)).toBeGreaterThanOrEqual(10)
      expect(perturbed(1, key * 104_729, 'records', 5, 10)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('cell keys', () => {
  it('add up as disjoint sets of patients, within the key space', () => {
    expect(addKeys(KEY_SPACE - 1, 2)).toBe(1)
    expect(addKeys(undefined, 5)).toBe(5)
    expect(addKeys(undefined, undefined)).toBeUndefined()
  })

  it('fall back on what the cell is, stably', () => {
    expect(fallbackKey('period', '2020')).toBe(fallbackKey('period', '2020'))
    expect(fallbackKey('period', '2020')).not.toBe(fallbackKey('period', '2021'))
    expect(fallbackKey('a', 'bc')).not.toBe(fallbackKey('ab', 'c'))
  })

  it('hash each patient with md5, salted and quoted', () => {
    expect(patientKeySql('pid', "o'k")).toBe("(md5_number_lower('o''k' || CAST(pid AS VARCHAR)) % 4294967296)")
  })
})
