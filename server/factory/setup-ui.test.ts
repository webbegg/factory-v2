// The Setup page and its header badge read doctor's checks through these
// helpers, so they must agree with `factory doctor` on what fails.
import { describe, expect, test } from 'bun:test'
import { canInitialize, checkState, summarizeDoctor } from '../../app/utils/setup'
import type { DoctorCheck } from './setup'

const check = (name: string, ok: boolean, optional = false): DoctorCheck => ({ name, ok, detail: '', optional })

const INIT_CHECKS = ['.factory/config.json', '.factory/checks.sh', 'GitHub labels', '.gitignore']

describe('checkState', () => {
  test('ok, optional not-ok warns, required not-ok fails', () => {
    expect(checkState(check('a', true))).toBe('ok')
    expect(checkState(check('a', true, true))).toBe('ok')
    expect(checkState(check('a', false, true))).toBe('warn')
    expect(checkState(check('a', false))).toBe('fail')
  })
})

describe('summarizeDoctor', () => {
  test('buckets checks by state, keeping their order', () => {
    const checks = [check('a', true), check('b', false), check('c', false, true), check('d', true), check('e', false)]
    const s = summarizeDoctor(checks)
    expect(s.ok.map(c => c.name)).toEqual(['a', 'd'])
    expect(s.warnings.map(c => c.name)).toEqual(['c'])
    expect(s.failures.map(c => c.name)).toEqual(['b', 'e'])
  })

  test('empty list', () => {
    expect(summarizeDoctor([])).toEqual({ ok: [], warnings: [], failures: [] })
  })
})

describe('canInitialize', () => {
  test('false when all init-related checks are ok, even if gh authenticated fails', () => {
    const checks = [...INIT_CHECKS.map(n => check(n, true)), check('gh authenticated', false), check('agent-browser (UI reviews)', false, true)]
    expect(canInitialize(checks)).toBe(false)
  })

  test('true when only GitHub labels fails', () => {
    const checks = [...INIT_CHECKS.map(n => check(n, n !== 'GitHub labels')), check('gh authenticated', true)]
    expect(canInitialize(checks)).toBe(true)
  })

  test('true when any one of the four is not ok', () => {
    for (const failing of INIT_CHECKS) {
      expect(canInitialize(INIT_CHECKS.map(n => check(n, n !== failing)))).toBe(true)
    }
  })

  test('false with no checks yet', () => {
    expect(canInitialize([])).toBe(false)
  })
})
