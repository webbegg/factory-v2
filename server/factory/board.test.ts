// The board's selection helpers: which column a stage sits in, which job the
// URL selects, what Esc does, who writes each job file, which run action a job
// offers, which stages are live, and each file tone's colour.
import { describe, expect, test } from 'bun:test'
import { COLUMNS, LIVE_STAGES, columnIndex, escapeAction, fileWriter, jobAction, selectedJobId, toneColor } from '../../app/utils/board'
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

describe('jobAction', () => {
  test('a running job offers Cancel, even with an error', () => {
    expect(jobAction({ stage: 'build', running: true, error: undefined })).toBe('cancel')
    expect(jobAction({ stage: 'build', running: true, error: 'boom' })).toBe('cancel')
  })

  test('a stalled job offers Retry', () => {
    expect(jobAction({ stage: 'spec', running: false, error: 'boom' })).toBe('retry')
  })

  test('an idle job in a live stage offers Resume', () => {
    expect(jobAction({ stage: 'review', running: false, error: undefined })).toBe('resume')
  })

  test('a job waiting on someone or done offers nothing', () => {
    for (const stage of ['needs-human', 'needs-info', 'merged', 'rejected'] as const) {
      expect(jobAction({ stage, running: false, error: undefined })).toBeNull()
    }
  })
})

describe('LIVE_STAGES', () => {
  test('every stage that is neither finished nor waiting, in stage order', () => {
    expect([...LIVE_STAGES]).toEqual(['intake', 'spec', 'build', 'gate', 'review', 'approve', 'merging'])
  })
})

describe('toneColor', () => {
  test('a file tone picks its dot colour', () => {
    expect(toneColor('good')).toBe('bg-success')
    expect(toneColor('warn')).toBe('bg-warning')
    expect(toneColor('stop')).toBe('bg-error')
    expect(toneColor(null)).toBe('bg-accented')
  })
})
