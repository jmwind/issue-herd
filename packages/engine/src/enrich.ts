// What the tracker and GitHub say about a factory's tasks — is the issue closed, is the PR merged,
// is there a PR for this branch — refreshed on a budget and remembered. Facts from those systems
// stay theirs; this only asks and records when it asked. Ported from the console into the owner,
// which already holds the tracker and the GitHub token.
import * as _pr from './adapters/pr.mjs';
const { prForBranch, prState } = _pr as Record<string, any>;

// One call per task, refreshed every 90s for tasks that are in flight or finished this week, every
// 30 min for the rest. A few calls a minute, well inside either API's budget.
const LIVE_TTL = 90_000;
const OLD_TTL = 30 * 60_000;
const WEEK = 7 * 86400e3;

export interface EnrichmentSources {
  tracker: any | null;
  ghRepo: string | null;
  ghToken: string | null;
  host: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
  clock?: () => number;
}

export class Enricher {
  issues = new Map<string, { at: number; state: string | null; name?: string | null; error?: string }>();
  prs = new Map<string, { at: number; state: string | null; error?: string }>();
  branches = new Map<string, { at: number; url: string | null; state: string | null; error?: string }>();
  busy = false;
  lastAskedAt: number | null = null;
  lastError: string | null = null;
  constructor(readonly sources: EnrichmentSources) {}

  /** The maps as the projection reads them. */
  view() {
    return {
      issues: Object.fromEntries([...this.issues].map(([k, v]) => [k, v.state])),
      prs: Object.fromEntries([...this.prs].map(([k, v]) => [k, v.state])),
      branches: Object.fromEntries([...this.branches].filter(([, v]) => v.url).map(([k, v]) => [k, v.url])),
    };
  }

  /** Refresh what is due for these tasks, in the background; the next snapshot reads the cache. */
  refresh(issues: any[], now = this.sources.clock?.() ?? Date.now()): void {
    if (this.busy) return;
    const { tracker, ghRepo, ghToken, host, fetchImpl, log = () => {} } = this.sources;
    const due: any[] = [];
    for (const iss of issues) {
      const recent = iss.bucket === 'inflight' || (iss.finishedAt && now - Date.parse(iss.finishedAt) < WEEK);
      const ttl = recent ? LIVE_TTL : OLD_TTL;
      if (tracker && now - (this.issues.get(iss.key)?.at || 0) > ttl) due.push({ kind: 'issue', key: iss.key });
      if (iss.prUrl && this.prs.get(iss.prUrl)?.state !== 'merged' && now - (this.prs.get(iss.prUrl)?.at || 0) > ttl) due.push({ kind: 'pr', url: iss.prUrl });
      if (!iss.prUrl && ghRepo) for (const r of iss.runs) {
        if (!r.branch) continue;
        const b = this.branches.get(r.branch);
        if (b?.state === 'merged' || now - (b?.at || 0) <= ttl) continue;
        due.push({ kind: 'branch', branch: r.branch });
      }
    }
    if (!due.length) return;
    this.busy = true;
    (async () => {
      for (const d of due.slice(0, 12)) {
        const at = this.sources.clock?.() ?? Date.now();
        try {
          if (d.kind === 'issue') {
            const issue = await tracker.issueByKey(d.key);
            const closed = !!issue && (/^(completed|canceled)$/.test(issue.state?.type || '') || /^closed$/i.test(issue.state?.name || ''));
            this.issues.set(d.key, { at, state: issue ? (closed ? 'closed' : 'open') : null, name: issue?.state?.name || null });
          } else if (d.kind === 'branch') {
            const pr = await prForBranch({ repo: ghRepo, branch: d.branch, token: ghToken, host, fetchImpl });
            this.branches.set(d.branch, { at, url: pr?.url || null, state: pr?.state || null });
            if (pr) this.prs.set(pr.url, { at, state: pr.state });
          } else {
            const pr = await prState(d.url, { token: ghToken, host, fetchImpl });
            this.prs.set(d.url, { at, state: pr.state });
          }
          this.lastAskedAt = at; this.lastError = null;
        } catch (e: any) {
          this.lastError = e.message;
          if (d.kind === 'issue') this.issues.set(d.key, { at, state: null, error: e.message });
          else if (d.kind === 'branch') this.branches.set(d.branch, { at, url: null, state: null, error: e.message });
          else this.prs.set(d.url, { at, state: null, error: e.message });
          log(`enrich: ${d.kind === 'issue' ? d.key : d.kind === 'branch' ? d.branch : d.url}: ${String(e.message).slice(0, 120)}`);
        }
      }
      this.busy = false;
    })();
  }
}
