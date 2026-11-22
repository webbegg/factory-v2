// The board's selection helpers: which column a stage sits in, which job the
// URL selects, what Esc does, and who writes each job file.
import { describe, expect, test } from 'bun:test'
import { COLUMNS, columnIndex, escapeAction, fileWriter, selectedJobId } from '../../app/utils/board'
import { STAGES } from './types'

describe('columnIndex', () => {
  test('every stage sits in exactly one column, and columnIndex finds it', () => {
    for (const stage of STAGES) {
      const holders = COLUMNS.flatMap((c, i) => c.stages.includes(stage) ? [i] : [])
      expect(holders).toHaveLength(1)
      expect(columnIndex(stage)).toBe(holders[0]!)
    }
  })

  test('a live update from build to review moves the job one column on', () => {
    expect(columnIndex('build')).toBe(columnIndex('gate'))
    expect(columnIndex('review')).toBe(columnIndex('build') + 1)
  })
})

describe('selectedJobId', () => {
  const ids = ['006-board', '007-other']

  test('a known id is selected', () => {
    expect(selectedJobId('006-board', ids)).toBe('006-board')
  })

  test('an id that is not on the board selects nothing', () => {
    expect(selectedJobId('does-not-exist', ids)).toBeNull()
  })

  test('a repeated query parameter selects nothing', () => {
    expect(selectedJobId(['006-board', '007-other'], ids)).toBeNull()
  })

  test('an empty or missing value selects nothing', () => {
    expect(selectedJobId('', ids)).toBeNull()
    expect(selectedJobId(undefined, ids)).toBeNull()
    expect(selectedJobId(null, ids)).toBeNull()
  })

  test('before the state loads nothing is selected yet', () => {
    expect(selectedJobId('006-board', null)).toBeNull()
    expect(selectedJobId('006-board', undefined)).toBeNull()
  })
})

describe('escapeAction', () => {
  test('an open overlay keeps Esc for itself', () => {
    expect(escapeAction({ overlayOpen: true, inTextField: false, hasSelection: true })).toBe('ignore')
  })

  test('an overlay beats a focused text field', () => {
    expect(escapeAction({ overlayOpen: true, inTextField: true, hasSelection: true })).toBe('ignore')
  })

  test('in a text field Esc only blurs it, so typed text survives', () => {
    expect(escapeAction({ overlayOpen: false, inTextField: true, hasSelection: true })).toBe('blur')
    expect(escapeAction({ overlayOpen: false, inTextField: true, hasSelection: false })).toBe('blur')
  })

  test('otherwise Esc closes the selection', () => {
    expect(escapeAction({ overlayOpen: false, inTextField: false, hasSelection: true })).toBe('close')
  })

  test('with nothing selected Esc does nothing', () => {
    expect(escapeAction({ overlayOpen: false, inTextField: false, hasSelection: false })).toBe('ignore')
  })
})

describe('fileWriter', () => {
  test.each([
    ['issue.md', 'the factory'],
    ['intake.md', 'intake'],
    ['intake-2.md', 'intake'],
    ['spec.md', 'the spec writer'],
    ['build.md', 'the builder'],
    ['round-1/checks.md', 'the gate'],
    ['round-3/merge-checks.md', 'the gate'],
    ['round-2/review-ux.md', 'the ux reviewer'],
    ['round-1/review-security.md', 'the security reviewer'],
    ['decision.md', 'the approver'],
    ['decision-2.md', 'the approver'],
    ['feedback-1.md', 'you'],
    ['rejection.md', 'you'],
    ['round-1/sync.md', 'the factory'],
    ['notes.md', 'the factory']
  ])('%s is written by %s', (path, writer) => {
    expect(fileWriter(path)).toBe(writer)
  })
})
