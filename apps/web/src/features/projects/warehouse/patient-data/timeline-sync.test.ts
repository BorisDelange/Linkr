import { describe, it, expect, vi } from 'vitest'
import {
  syncChannel,
  subscribeTimelineSync,
  broadcastTimelineRange,
  getTimelineRange,
  forgetTimelineRange,
  publishGutter,
  retractGutter,
  getGutter,
  subscribeGutter,
} from './timeline-sync'

// Which timelines hear each other is the whole point of the channel: get it
// wrong and two patients' boards drag each other's windows around.

describe('syncChannel', () => {
  it('keeps each tab on its own channel by default', () => {
    expect(syncChannel('t1', 'b1', false)).not.toBe(syncChannel('t2', 'b1', false))
  })

  it('puts every tab of a board on one channel when cross-tab sync is on', () => {
    expect(syncChannel('t1', 'b1', true)).toBe(syncChannel('t2', 'b1', true))
  })

  it('still separates two boards when cross-tab sync is on', () => {
    // Two boards can be open on two different patients, whose records cover
    // entirely different dates; sharing a window would be nonsense.
    expect(syncChannel('t1', 'b1', true)).not.toBe(syncChannel('t2', 'b2', true))
  })

  it('falls back to the tab when the board is unknown', () => {
    // A widget whose tab has not resolved to a board yet must not land on a
    // shared 'board:undefined' channel with every other such widget.
    expect(syncChannel('t1', undefined, true)).toBe(syncChannel('t1', 'b1', false))
  })

  it('treats an unset setting as off', () => {
    expect(syncChannel('t1', 'b1', undefined)).toBe(syncChannel('t1', 'b1', false))
  })
})

describe('pub/sub', () => {
  it('delivers a range to the other timelines on the channel', () => {
    const listener = vi.fn()
    const off = subscribeTimelineSync('c-deliver', listener)
    broadcastTimelineRange('c-deliver', 'w1', { min: 10, max: 20 })
    expect(listener).toHaveBeenCalledWith({ min: 10, max: 20 }, 'w1')
    off()
  })

  it('does not leak across channels', () => {
    const listener = vi.fn()
    const off = subscribeTimelineSync('c-a', listener)
    broadcastTimelineRange('c-b', 'w1', { min: 10, max: 20 })
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('remembers the last range, so a timeline turning sync on can adopt it', () => {
    const off = subscribeTimelineSync('c-last', vi.fn())
    broadcastTimelineRange('c-last', 'w1', { min: 5, max: 9 })
    expect(getTimelineRange('c-last')).toEqual({ min: 5, max: 9 })
    off()
  })

  it('keeps the range when the last timeline unmounts, so a tab switch can adopt it', () => {
    // With reload-on-tab-switch on, leaving a tab unmounts every timeline it
    // holds. Dropping the range there would leave the tab being switched TO
    // with nothing to adopt — cross-tab sync would do nothing in exactly the
    // configuration it exists for.
    const off = subscribeTimelineSync('c-clean', vi.fn())
    broadcastTimelineRange('c-clean', 'w1', { min: 5, max: 9 })
    off()
    expect(getTimelineRange('c-clean')).toEqual({ min: 5, max: 9 })
  })

  it('forgets the range on request, for when the patient changes', () => {
    // A different patient's record covers different dates; adopting the old
    // window would open every synced timeline on empty space.
    broadcastTimelineRange('c-forget', 'w1', { min: 5, max: 9 })
    forgetTimelineRange('c-forget')
    expect(getTimelineRange('c-forget')).toBeNull()
  })

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn()
    subscribeTimelineSync('c-off', listener)()
    broadcastTimelineRange('c-off', 'w1', { min: 1, max: 2 })
    expect(listener).not.toHaveBeenCalled()
  })

  it('carries a range between two different widget kinds', () => {
    // The channel knows nothing about plugins: a data-overview widget and a
    // timeline on the same channel hear each other. This is what was broken —
    // sync only ever existed between timelines.
    const overview = vi.fn()
    const offA = subscribeTimelineSync('board:b1', overview)
    const offB = subscribeTimelineSync('board:b1', vi.fn())
    broadcastTimelineRange('board:b1', 'timeline-w', { min: 10, max: 20 })
    expect(overview).toHaveBeenCalledWith({ min: 10, max: 20 }, 'timeline-w')
    offA()
    offB()
  })

  it('names the source, so a timeline can ignore its own broadcast', () => {
    const listener = vi.fn()
    const off = subscribeTimelineSync('c-src', listener)
    broadcastTimelineRange('c-src', 'w-self', null)
    expect(listener.mock.calls[0][1]).toBe('w-self')
    off()
  })
})

describe('shared gutter', () => {
  it('hands a timeline the gutter an overview measured', () => {
    publishGutter('tab-a', 260)
    expect(getGutter('tab-a')).toBe(260)
    retractGutter('tab-a')
  })

  it('notifies timelines already listening', () => {
    const listener = vi.fn()
    const off = subscribeGutter('tab-b', listener)
    publishGutter('tab-b', 240)
    expect(listener).toHaveBeenCalledWith(240)
    off()
    retractGutter('tab-b')
  })

  it('stays within its tab', () => {
    // A board syncing across tabs still must not let a long label in one tab
    // reshape a chart in another, where the two are never seen side by side.
    const other = vi.fn()
    const off = subscribeGutter('tab-c', other)
    publishGutter('tab-d', 300)
    expect(other).not.toHaveBeenCalled()
    expect(getGutter('tab-c')).toBeNull()
    off()
    retractGutter('tab-d')
  })

  it('says nothing is leading once the overview retracts', () => {
    const listener = vi.fn()
    publishGutter('tab-e', 260)
    const off = subscribeGutter('tab-e', listener)
    retractGutter('tab-e')
    // Null is the signal to fall back to the timeline's own fixed width.
    expect(listener).toHaveBeenCalledWith(null)
    expect(getGutter('tab-e')).toBeNull()
    off()
  })

  it('does not re-notify when the gutter has not moved', () => {
    // The overview publishes from its paint, which runs on every redraw.
    const listener = vi.fn()
    publishGutter('tab-f', 260)
    const off = subscribeGutter('tab-f', listener)
    publishGutter('tab-f', 260)
    expect(listener).not.toHaveBeenCalled()
    off()
    retractGutter('tab-f')
  })

  it('ignores a widget with no tab yet', () => {
    publishGutter('', 260)
    expect(getGutter('')).toBeNull()
  })
})
