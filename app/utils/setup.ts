import type { DoctorCheck } from '../../server/factory/setup'

export type CheckState = 'ok' | 'warn' | 'fail'

// The checks `init()` can fix; the rest need the user (gh auth, claude, …).
const INIT_CHECKS = new Set(['.factory/config.json', '.factory/checks.sh', 'GitHub labels', '.gitignore'])

/** Same rule as `factory doctor`: only a required check that is not ok fails. */
export function checkState(c: DoctorCheck): CheckState {
  if (c.ok) return 'ok'
  return c.optional ? 'warn' : 'fail'
}

export function summarizeDoctor(checks: DoctorCheck[]): { ok: DoctorCheck[], warnings: DoctorCheck[], failures: DoctorCheck[] } {
  return {
    ok: checks.filter(c => checkState(c) === 'ok'),
    warnings: checks.filter(c => checkState(c) === 'warn'),
    failures: checks.filter(c => checkState(c) === 'fail')
  }
}

export function canInitialize(checks: DoctorCheck[]): boolean {
  return checks.some(c => INIT_CHECKS.has(c.name) && !c.ok)
}
