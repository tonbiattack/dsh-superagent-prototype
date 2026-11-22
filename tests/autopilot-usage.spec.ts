// What a job's work cost, as far as the provider reported it.
import { describe, expect, it } from 'vitest'
import { addUsage, cacheHitRate, noUsage } from '../src/app/autopilot-usage.ts'

describe('usage totals', () => {
  it('adds the figures the provider reported', () => {
    let total = noUsage()
    total = addUsage(total, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300 })
    total = addUsage(total, { inputTokens: 50, outputTokens: 10, cacheReadTokens: 450 })
    expect(total).toEqual({ calls: 2, unreported: 0, inputTokens: 150, outputTokens: 30, cacheReadTokens: 750 })
  })
  it('keeps a figure the provider omitted unknown, rather than counting it as zero', () => {
    // A provider that reports no cache figures must not look like a 0% cache hit rate.
    const total = addUsage(noUsage(), { inputTokens: 100, outputTokens: 20 })
    expect(total).toEqual({ calls: 1, unreported: 0, inputTokens: 100, outputTokens: 20 })
    expect(total.cacheReadTokens).toBeUndefined()
  })
  it('counts a call whose usage the provider did not report, so the totals are known to be incomplete', () => {
    const total = addUsage(addUsage(noUsage(), { inputTokens: 100, outputTokens: 20 }), undefined)
    expect(total).toEqual({ calls: 2, unreported: 1, inputTokens: 100, outputTokens: 20 })
  })
  it('keeps a cache figure that only some calls reported', () => {
    const total = addUsage(addUsage(noUsage(), { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300 }),
      { inputTokens: 50, outputTokens: 10 })
    expect(total.cacheReadTokens).toBe(300)
  })
})

describe('cache hit rate', () => {
  it('is the cached share of all input, which is what a person compares between sessions', () => {
    expect(cacheHitRate({ inputTokens: 250, cacheReadTokens: 750 })).toBe(0.75)
    expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: 0 })).toBe(0)
  })
  it('is unavailable when the provider reported no cache figure, rather than 0%', () => {
    expect(cacheHitRate({ inputTokens: 100 })).toBeUndefined()
    expect(cacheHitRate({ cacheReadTokens: 100 })).toBeUndefined()
  })
  it('is unavailable when there was no input at all, rather than dividing by zero', () => {
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0 })).toBeUndefined()
  })
})
