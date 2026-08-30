import { describe, it, expect, vi } from 'vitest'
import {
  syncChannel,
  subscribeTimelineSync,
  broadcastTimelineRange,
  getTimelineRange,
  forgetTimelineRange,
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

  it('names the source, so a timeline can ignore its own broadcast', () => {
    const listener = vi.fn()
    const off = subscribeTimelineSync('c-src', listener)
    broadcastTimelineRange('c-src', 'w-self', null)
    expect(listener.mock.calls[0][1]).toBe('w-self')
    off()
  })
})
