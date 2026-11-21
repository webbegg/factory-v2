// The Activity sidebar's pure helpers: grouping, the follow-the-bottom test and status-line parsing.
import { describe, expect, test } from 'bun:test'
import { atBottom, groupFeed, parseStatus, type FeedEntry } from '../../app/utils/feed'

let next = 0
function entry(sender: string, jobId: string | null, text = 'x', at = '10:00:00'): FeedEntry {
  return { id: ++next, at, sender, jobId, kind: 'text', text }
}

describe('groupFeed', () => {
  test('consecutive entries from the same sender and job share one group headed by the first', () => {
    const groups = groupFeed([entry('builder', '013-x', 'a', '10:00:01'), entry('builder', '013-x', 'b', '10:00:02')])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.at).toBe('10:00:01')
    expect(groups[0]!.entries.map(e => e.text)).toEqual(['a', 'b'])
  })

  test('a change of sender starts a new group', () => {
    const groups = groupFeed([entry('builder', '013-x'), entry('factory', '013-x'), entry('builder', '013-x')])
    expect(groups.map(g => g.sender)).toEqual(['builder', 'factory', 'builder'])
  })

  test('a change of job starts a new group', () => {
    const groups = groupFeed([entry('builder', '013-x'), entry('builder', '014-y'), entry('factory', null), entry('factory', '014-y')])
    expect(groups.map(g => g.jobId)).toEqual(['013-x', '014-y', null, '014-y'])
  })

  test('no entries, no groups', () => {
    expect(groupFeed([])).toEqual([])
  })
})

describe('atBottom', () => {
  test('exactly at the end is the bottom', () => {
    expect(atBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
  })

  test('within a few pixels still counts', () => {
    expect(atBottom({ scrollTop: 596.5, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
  })

  test('scrolled up past the tolerance does not', () => {
    expect(atBottom({ scrollTop: 590, scrollHeight: 1000, clientHeight: 400 })).toBe(false)
  })

  test('content shorter than the region is at the bottom', () => {
    expect(atBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(true)
  })
})

describe('parseStatus', () => {
  const jobs = ['013-x', '014-y']

  test('a known job id prefix is parsed and stripped', () => {
    expect(parseStatus('013-x: builder started', jobs)).toEqual({ jobId: '013-x', text: 'builder started' })
  })

  test('an unknown prefix is left whole with no job', () => {
    expect(parseStatus('999-gone: builder started', jobs)).toEqual({ jobId: null, text: '999-gone: builder started' })
  })

  test('a queue: line is left whole with no job', () => {
    expect(parseStatus('queue: #27 waiting for a slot', jobs)).toEqual({ jobId: null, text: 'queue: #27 waiting for a slot' })
  })

  test('a line with no prefix is left whole', () => {
    expect(parseStatus('gate passed', jobs)).toEqual({ jobId: null, text: 'gate passed' })
  })
})
