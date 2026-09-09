// The result file an agent writes when its turn is over: what weawr reads to finish an attempt and
// report back. Version 1. A result that does not check must not finalize anything.
import { s, validate } from './schema.js';
import type { Infer, Result } from './schema.js';

export const RESULT_SCHEMA_VERSION = 1;

export const RESULT_STATUSES = ['pr_open', 'needs_human', 'nothing_to_do', 'failed'] as const;
export type ResultStatus = typeof RESULT_STATUSES[number];

/** A structured review verdict about one pull request head. Distinct from whether the turn completed. */
export const REVIEW_VERDICTS = ['approved', 'changes_requested', 'unable_to_review'] as const;
export type ReviewVerdict = typeof REVIEW_VERDICTS[number];

export const ROLE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

const nudgeSchema = s.object({
  role: s.string({ pattern: ROLE_PATTERN }),
  message: s.string({ min: 1, max: 4000 }),
});

export const reviewSchema = s.object({
  verdict: s.enum(REVIEW_VERDICTS),
  /** The pull request reviewed. Required for a verdict to count towards a merge. */
  prUrl: s.maybe(s.string({ min: 1 })),
  /** The commit that was reviewed. A verdict for one head never authorises another. */
  headSha: s.maybe(s.string({ pattern: SHA_PATTERN })),
  notes: s.maybe(s.string({ max: 20000 })),
});
export type Review = Infer<typeof reviewSchema>;

export const resultSchema = s.object({
  schemaVersion: s.maybe(s.number({ integer: true, min: 1 })),
  status: s.enum(RESULT_STATUSES),
  prUrl: s.maybe(s.string({ max: 2000 })),
  branch: s.maybe(s.string({ max: 500 })),
  summary: s.maybe(s.string({ max: 50000 })),
  testing: s.maybe(s.string({ max: 50000 })),
  notes: s.maybe(s.string({ max: 50000 })),
  nudge: s.maybe(s.union<any>([nudgeSchema, s.array(nudgeSchema, { max: 10 })])),
  nudges: s.maybe(s.array(nudgeSchema, { max: 10 })),
  review: s.maybe(reviewSchema),
});
export type AgentResult = Infer<typeof resultSchema>;

/**
 * Check a parsed result file. A version newer than this weawr understands is refused outright:
 * the file is preserved and the person is told to upgrade.
 */
export function validateResult(value: unknown): Result<AgentResult> {
  const v = value as any;
  if (v && typeof v === 'object' && typeof v.schemaVersion === 'number' && v.schemaVersion > RESULT_SCHEMA_VERSION) {
    return { ok: false, issues: [{ path: 'schemaVersion', message: `is ${v.schemaVersion}; this weawr reads results up to version ${RESULT_SCHEMA_VERSION} — upgrade weawr` }] };
  }
  return validate(resultSchema, value);
}

/**
 * A reviewer's verdict from a result: the structured one when present, else what the prose said
 * — only where the wording is unambiguous, and marked `legacy` because such a verdict names no
 * head and so can never authorise a merge on its own.
 */
export function verdictOf(result: { review?: Review | null; summary?: string | null; status?: string } | null | undefined): { verdict: ReviewVerdict | 'unknown'; source: 'structured' | 'legacy' | 'none'; headSha: string | null; prUrl: string | null } {
  if (!result) return { verdict: 'unknown', source: 'none', headSha: null, prUrl: null };
  if (result.review?.verdict) return { verdict: result.review.verdict, source: 'structured', headSha: result.review.headSha ?? null, prUrl: result.review.prUrl ?? null };
  // The prose verdicts recipe revision 1 asked for. Read from the first line only, and only
  // where a person would read it the same way; "FINDINGS — n (m blocking)" is a verdict when m is
  // given, and nothing else is.
  const first = String(result.summary || '').trim().split('\n')[0];
  const legacy = (verdict: ReviewVerdict) => ({ verdict, source: 'legacy' as const, headSha: null, prUrl: null });
  if (/^(NOT OK TO MERGE TO MAIN|USABILITY: NOT OK|SECURITY: NOT OK)\b/i.test(first)) return legacy('changes_requested');
  if (/^(OK TO MERGE TO MAIN|USABILITY: OK|SECURITY: NO FINDINGS|SECURITY: OK)\b/i.test(first)) return legacy('approved');
  const findings = /^USABILITY: FINDINGS\b.*?\((\d+) blocking\)/i.exec(first);
  if (findings) return legacy(Number(findings[1]) > 0 ? 'changes_requested' : 'approved');
  return { verdict: 'unknown', source: 'none', headSha: null, prUrl: null };
}
