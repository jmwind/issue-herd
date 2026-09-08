// Is the run's pull request merged yet?
//
// The agent's job ends when the PR is open; the run's does not. Its herdr workspace and its
// worktree stay up so a reviewer can poke at them, and the thing that says they are no longer
// needed is the PR being merged — which is a GitHub question no matter which tracker the issue
// came from, because a Linear issue's PR is on GitHub too. So this is not a tracker method: it is
// one REST call about one URL, and it is the only part of issue-herd that reads a code host.
//
// The URL comes out of the agent's result.json, and result.json is written by a model that has
// read the issue's text, so it is not trusted to say where the token goes: `host` is what the
// machine trusts (github.com, or ISSUE_HERD_GITHUB_HOST), and a PR URL anywhere else is refused
// rather than fetched.

const PR_URL = /^https?:\/\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/pulls?\/(\d+)(?:[/?#].*)?$/;

/**
 * Does this rule follow a run past its PR? Everything in `onMerged` switched off (or the whole
 * block set to null in config.json) means no: the run is over when the agent is, as it was before
 * any of this existed.
 */
export function watchesMerge(rule) {
  const p = rule?.onMerged;
  return !!p && ['exitAgent', 'closeWorkspace', 'removeWorktree', 'comment', 'notify'].some((k) => p[k]);
}

/** { host, owner, repo, number } for a pull request URL, or null for anything else. */
export function parsePrUrl(url) {
  const m = PR_URL.exec(String(url || '').trim());
  if (!m) return null;
  return { host: m[1].toLowerCase(), owner: m[2], repo: m[3].replace(/\.git$/, ''), number: Number(m[4]) };
}

/** GitHub's REST root for a host: api.github.com for github.com, /api/v3 on GitHub Enterprise. */
export function apiBase(host) {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

/** 'merged' | 'closed' (closed without merging) | 'open', from GitHub's pull request payload. */
export function stateOf(pr) {
  if (pr?.merged || pr?.merged_at) return 'merged';
  return pr?.state === 'closed' ? 'closed' : 'open';
}

/**
 * Does GitHub say this pull request cannot be merged because of conflicts? `mergeable_state` is
 * "dirty" for exactly that (and `mergeable` false); "blocked", "behind" and "unstable" are reviews,
 * branch protection and checks, which are not the implementer's branch being stale. `mergeable` is
 * null while GitHub is still working it out after a push: "not known yet", never "conflicting".
 */
export function conflictsOf(pr) {
  return pr?.mergeable_state === 'dirty' || pr?.mergeable === false;
}

/**
 * Ask GitHub about one pull request. Returns { state, mergedAt, number, url, headSha, baseRef,
 * conflicts }.
 * Throws when the URL is not a PR on the trusted host, or when GitHub will not answer — the
 * watcher logs that once and keeps waiting, because a token that expired is not a merged PR.
 */
export async function prState(url, { token = null, host = 'github.com', fetchImpl = fetch } = {}) {
  const pr = parsePrUrl(url);
  if (!pr) throw new Error(`not a pull request URL: ${url}`);
  if (pr.host !== host) throw new Error(`${pr.host} is not the GitHub host this machine trusts (${host}); not asking it about ${url}`);
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'issue-herd' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(`${apiBase(host)}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, { headers });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const e = new Error(`GitHub HTTP ${res.status} for ${url}: ${json?.message || text.slice(0, 120)}${res.status === 404 && !token ? ' (no GitHub token on this machine, so a private repository looks missing)' : ''}`);
    e.status = res.status;
    throw e;
  }
  return {
    state: stateOf(json), mergedAt: json?.merged_at || null, number: pr.number, url,
    headSha: json?.head?.sha || null, baseRef: json?.base?.ref || null, conflicts: conflictsOf(json),
  };
}

/**
 * What the watcher owes an open pull request this poll, given what it did last time.
 *
 * The implementer is told once per conflict, not once a minute: `run.conflictHead` is the head the
 * PR had when it was last told, so the same conflicts on the same commits are nothing new. A
 * different head that still conflicts is new — either the fix was pushed and something else landed
 * on top of it, or the fix did not take — and the implementer hears about it again. A PR that reads
 * clean again forgets the marker, so the next drift is a fresh episode.
 *
 * Returns 'nudge' (tell the implementer and remember this head), 'clear' (the conflicts are gone,
 * forget the marker), or null (nothing to do).
 */
export function conflictStep(run, pr) {
  if (!pr || pr.state !== 'open') return null;
  const head = pr.headSha || 'unknown';
  if (!pr.conflicts) return run?.conflictHead ? 'clear' : null;
  return run?.conflictHead === head ? null : 'nudge';
}

/**
 * The message the watcher types into the implementer's session when its PR has drifted into
 * conflicts. Self-contained: the session may be hours past its brief, so it says what happened,
 * what the brief already asked for, and what not to do (rewrite history, or the result file).
 */
export function conflictPrompt({ prUrl, branch, baseRef, briefPath }) {
  const base = baseRef || '<base>';
  return `issue-herd: your pull request ${prUrl} now conflicts with ${baseRef || 'the base branch'} — something merged after you pushed, and GitHub reports it as not mergeable. `
    + `Your brief${briefPath ? ` (${briefPath})` : ''} says the PR is yours to keep mergeable until it is merged or closed. `
    + `Bring the branch up to date now: \`git fetch origin ${base}\` and \`git merge origin/${base}\` into \`${branch || 'your branch'}\` — a merge, never a rebase, never a force-push — `
    + `resolve every conflict so the change still does what the PR says, re-run the repository's checks, push, and say on the PR in one line what you merged in. `
    + `Do not rewrite the result file. Then stop again.`;
}

/**
 * The pull request whose head is `branch` in `repo` ("owner/name"), or null. Every run has a
 * branch, so this finds the PR even when the run never recorded one (an older result, a PR
 * opened by hand, a result written after the watcher stopped reading it). Newest first, so a
 * reopened branch answers with its latest PR.
 */
export async function prForBranch({ repo, branch, token = null, host = 'github.com', fetchImpl = fetch }) {
  if (!repo || !branch) return null;
  const owner = repo.split('/')[0];
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'issue-herd' };
  if (token) headers.authorization = `Bearer ${token}`;
  const q = `head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&sort=created&direction=desc&per_page=1`;
  const res = await fetchImpl(`${apiBase(host)}/repos/${repo}/pulls?${q}`, { headers });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`GitHub HTTP ${res.status} for ${repo} pulls?head=${branch}: ${text.slice(0, 120)}`); e.status = res.status; throw e; }
  let list = []; try { list = JSON.parse(text); } catch { /* not json */ }
  const pr = Array.isArray(list) ? list[0] : null;
  return pr ? { url: pr.html_url, number: pr.number, state: stateOf(pr), mergedAt: pr.merged_at || null } : null;
}
