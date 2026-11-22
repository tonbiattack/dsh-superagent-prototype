/**
 * What a job's work cost, as far as DSH reports it.
 *
 * Reusing a session is meant to make work cheaper and faster, but that is a claim to measure rather than assume. The
 * figures here come from the model's own usage records: prompt tokens, cached tokens, and the cache hit rate derived from
 * them. A figure the provider does not report is `undefined`, never zero, so the panel can say "not available" instead of
 * showing a confident 0%.
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** One job's measured cost, with the fields the provider did not report left out. */
export interface JobUsage {
  /** Uncached input tokens, as the provider reported them. */
  inputTokens?: number
  outputTokens?: number
  /** Input tokens served from the provider's cache. */
  cacheReadTokens?: number
  /** Input tokens written to the provider's cache. */
  cacheWriteTokens?: number
  /** Calls whose usage was reported, which is what the totals cover. */
  calls: number
  /** Calls whose usage the provider did not report, so the totals are incomplete. */
  unreported: number
}
/** The cache hit rate, or undefined when the provider reported no input at all. */
export function cacheHitRate(usage: Pick<JobUsage, 'inputTokens' | 'cacheReadTokens'>): number | undefined {
  const cached = usage.cacheReadTokens
  const uncached = usage.inputTokens
  // Without both figures there is no rate to report; a missing one is not a zero.
  if (cached === undefined || uncached === undefined) return undefined
  const total = cached + uncached
  return total === 0 ? undefined : cached / total
}
/** Adds one call's usage to a job's totals, keeping a figure the provider omitted as unknown. */
export function addUsage(total: JobUsage, usage: TokenUsage | undefined): JobUsage {
  if (!usage) return { ...total, calls: total.calls + 1, unreported: total.unreported + 1 }
  // A field the provider omitted stays unknown: adding it as zero would report a confident figure the provider never gave.
  const plus = (current: number | undefined, next: number | undefined): number | undefined =>
    next === undefined ? current : (current ?? 0) + next
  return { calls: total.calls + 1, unreported: total.unreported,
    ...optional('inputTokens', plus(total.inputTokens, usage.inputTokens)),
    ...optional('outputTokens', plus(total.outputTokens, usage.outputTokens)),
    ...optional('cacheReadTokens', plus(total.cacheReadTokens, usage.cacheReadTokens)),
    ...optional('cacheWriteTokens', plus(total.cacheWriteTokens, usage.cacheWriteTokens)) }
}
/** A field to merge, or nothing when the figure is unknown. */
const optional = <K extends keyof JobUsage>(key: K, value: JobUsage[K] | undefined): Partial<JobUsage> =>
  value === undefined ? {} : { [key]: value } as Partial<JobUsage>
/** An empty total, which the first reported call fills in. */
export const noUsage = (): JobUsage => ({ calls: 0, unreported: 0 })
