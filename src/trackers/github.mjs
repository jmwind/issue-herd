// GitHub Issues. One GraphQL query reads issues with labels, assignees and comments in one round
// trip; the handful of writes use REST because they only need the issue number. No dependencies.
//
// Config:  "tracker": "github"
//      or  "tracker": { "type": "github", "repo": "owner/name", "host": "github.com", "prefix": "GH" }
//   repo    defaults to the `origin` remote of the repository issue-herd runs in
//   host    a GitHub Enterprise host; api.github.com otherwise
//   prefix  issues are known as <prefix>-<number> (GH-7) in runs, branches and herdr; "#7" in PR text
//
// What GitHub has no equivalent for: priority is 0 unless a label says p0..p3 / urgent / high /
// medium / low; estimate and cycle are empty; the milestone is the "project"; the repository is
// the "team". state is open (type unstarted) or closed (type completed). setState("closed") closes,
// setState("open") reopens, and any other name is applied as a label (created if missing), so
// `"onPickup": { "state": "in progress" }` labels the issue rather than failing.
//
// Auth: GITHUB_TOKEN / GH_TOKEN, a saved credential, or `gh auth token`. Browser sign-in without
// `gh` needs an OAuth app with device flow enabled (Settings → Developer settings → OAuth Apps);
// put its client id in GITHUB_CLIENT_ID below or in ISSUE_HERD_GITHUB_CLIENT_ID.

import { execFileSync } from 'node:child_process';
import { slugify } from '../tracker.mjs';
import { deviceFlow, noCredentialError } from '../auth.mjs';

export const GITHUB_CLIENT_ID = process.env.ISSUE_HERD_GITHUB_CLIENT_ID || '';
const PRIORITY_LABELS = { p0: 1, p1: 2, p2: 3, p3: 4, urgent: 1, high: 2, medium: 3, low: 4 };
const PRIORITY_NAMES = ['none', 'Urgent', 'High', 'Medium', 'Low'];
// config.json is committed, so these three end up in URLs, file paths and branch names. Validate
// them where they are read rather than trusting them: a "host" carrying a path or query would send
// the token somewhere else, and a "prefix" carrying a slash or a dot would put a run's directory
// outside .issue-herd/state/runs/.
const VALID_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;
const VALID_REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const VALID_PREFIX = /^[A-Za-z][A-Za-z0-9]{0,15}$/;

export class GitHubTracker {
  static id = 'github';
  static label = 'GitHub';
  static auth = { env: ['GITHUB_TOKEN', 'GH_TOKEN'], hint: 'a token with read/write access to the repository\'s issues (classic scope "repo"), or `gh auth login`' };
  static exampleConfig = {
    rules: [{ name: 'ai-label', match: 'label:ai' }],
    defaults: { onPickup: { state: null }, onDone: { state: null } },
  };

  /**
   * The GitHub host this machine trusts: github.com, or whatever ISSUE_HERD_GITHUB_HOST names —
   * a variable issue-herd deliberately refuses to read from a repository's .env.
   *
   * A committed config may *name* the host it expects, but it may not introduce one, because this
   * value decides where an `Authorization: Bearer <your token>` header is sent, and config.json
   * travels with the repository. Every entry point resolves the host through here, including the
   * static ones, so signing in cannot be pointed at someone else's server either.
   */
  static host(options = {}) {
    const trusted = process.env.ISSUE_HERD_GITHUB_HOST || 'github.com';
    if (!VALID_HOST.test(trusted)) throw new Error(`ISSUE_HERD_GITHUB_HOST is not a hostname: ${JSON.stringify(trusted)}`);
    const want = options.host;
    if (want && want !== trusted) {
      throw new Error(`the config asks to reach GitHub at ${JSON.stringify(want)}, but this machine trusts ${trusted}. A repository cannot redirect your token: if you meant it, set ISSUE_HERD_GITHUB_HOST=${want} in your shell.`);
    }
    return trusted;
  }

  /** The token the `gh` CLI is logged in with, if it is installed and logged in. */
  static fallback(options = {}) {
    let host;
    try { host = this.host(options); } catch { return null; }   // an untrusted host borrows nothing
    try {
      const token = execFileSync('gh', ['auth', 'token', '-h', host], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return token ? { kind: 'borrowed', token, source: 'gh auth token' } : null;
    } catch { return null; }
  }

  static async login(ui, options = {}) {
    const { clientId = GITHUB_CLIENT_ID, paste = false, fetchImpl = fetch } = options;
    const host = this.host(options);
    if (clientId && !paste) {
      const t = await deviceFlow({ deviceUrl: `https://${host}/login/device/code`, tokenUrl: `https://${host}/login/oauth/access_token`, clientId, scope: 'repo', ui, fetchImpl });
      return { kind: 'oauth', token: t.access_token, refreshToken: t.refresh_token || null, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null, clientId };
    }
    if (!paste) {
      const found = this.fallback(options);
      if (found) { ui.log('Using the token `gh` is logged in with.'); return found; }
      if (hasGh()) {
        ui.log('Signing in with `gh auth login` (it opens your browser)…');
        execFileSync('gh', ['auth', 'login', '--web', '--hostname', host, '--scopes', 'repo'], { stdio: 'inherit' });
        const again = this.fallback(options);
        if (again) return again;
      }
    }
    ui.log('Create a token with the "repo" scope on the page that opens and paste it here.');
    await ui.open(`https://${host}/settings/tokens/new?scopes=repo&description=issue-herd`);
    const token = (await ui.askSecret('GitHub token: ')).trim();
    if (!token) throw new Error('no token entered');
    return { kind: 'apiKey', token };
  }

  constructor(credential, { options = {}, fetchImpl = fetch } = {}) {
    const cred = typeof credential === 'string' ? { token: credential } : credential;
    if (!cred?.token) throw noCredentialError(GitHubTracker);
    this.cred = { ...cred };
    this.options = options;
    this.fetch = fetchImpl;
    this.host = GitHubTracker.host(options);
    this.prefix = options.prefix || 'GH';
    if (!VALID_PREFIX.test(this.prefix)) throw new Error(`tracker "prefix" must be letters and digits starting with a letter (it names branches and directories): ${JSON.stringify(options.prefix)}`);
    // An unknown repository is not fatal here — `issue-herd login` needs only a token. check() is
    // what refuses to run the watcher without one.
    const repo = options.repo || repoFromGit(options.cwd || process.cwd(), this.host);
    this.repo = VALID_REPO.test(repo || '') ? repo : null;
    this.api = this.host === 'github.com' ? 'https://api.github.com' : `https://${this.host}/api/v3`;
    this.graphql = this.host === 'github.com' ? 'https://api.github.com/graphql' : `https://${this.host}/api/graphql`;
    this.viewer = null;
    this.labelsPending = new Map();   // name -> in-flight ensureLabel(), so two runs cannot both create it
  }

  get token() { return this.cred.token; }

  describe() { return this.repo || '(repository unknown)'; }

  /** Throws if this tracker cannot work: the watcher needs a repository (login only needs a token). */
  check() {
    if (!this.repo) throw new Error(`cannot tell which GitHub repository this is (origin is not on ${this.host}); set "tracker": { "type": "github", "repo": "owner/name" } in config.json`);
  }

  async request(method, url, body, { retry = true } = {}) {
    const headers = { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'issue-herd' };
    if (body) headers['content-type'] = 'application/json';
    const res = await this.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok) {
      // A borrowed token belongs to `gh`, which rotates it. Re-read it once rather than 401 forever.
      if (res.status === 401 && retry && this.cred.kind === 'borrowed') {
        const fresh = GitHubTracker.fallback(this.options);
        if (fresh?.token && fresh.token !== this.cred.token) { this.cred = { ...fresh }; return this.request(method, url, body, { retry: false }); }
      }
      const e = new Error(`GitHub HTTP ${res.status}: ${json?.message || text.slice(0, 200)}${res.status === 401 ? ' — run `issue-herd login github` or check GITHUB_TOKEN' : ''}`);
      e.status = res.status; throw e;
    }
    return json;
  }

  rest(method, p, body) { this.check(); return this.request(method, `${this.api}/repos/${this.repo}${p}`, body); }

  async gql(query, variables = {}) {
    const json = await this.request('POST', this.graphql, { query, variables });
    if (json?.errors?.length) throw new Error(`GitHub GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    // Free to ask for, and the only way to see how much of the hourly budget polling is using.
    if (json?.data?.rateLimit) this.rateLimit = json.data.rateLimit;
    return json.data;
  }

  /** "4832 GraphQL points left" for the watcher's heartbeat, or null before the first poll. */
  budget() {
    return this.rateLimit ? `${this.rateLimit.remaining} GraphQL points left until ${String(this.rateLimit.resetAt).slice(11, 16)}` : null;
  }

  async me() {
    if (!this.viewer) {
      const d = await this.gql('{ viewer { login name } }');
      this.viewer = user(d.viewer);
    }
    return this.viewer;
  }

  async openIssues({ sinceIso, pageSize = 100, maxPages = 10 } = {}) {
    const out = [];
    let after = null;
    for (let page = 0; page < maxPages; page++) {
      const d = await this.gql(ISSUES_QUERY, { owner: this.owner, name: this.name, first: pageSize, after, since: sinceIso || null });
      const conn = d.repository.issues;
      for (const n of conn.nodes) out.push(this.normalize(n));
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  async issueByKey(identifier) {
    const number = issueNumber(identifier);
    if (!number) return null;
    const d = await this.gql(`query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) ${ISSUE_FIELDS} } }`, { owner: this.owner, name: this.name, number });
    return d.repository.issue ? this.normalize(d.repository.issue) : null;
  }

  async comment(issueId, body) {
    const c = await this.rest('POST', `/issues/${issueId}/comments`, { body });
    return { id: c.id, url: c.html_url };
  }

  /**
   * The claim label is created on first use; there is no "create it in the UI first" step on GitHub.
   * The in-flight promise is shared, and a 422 from a racing creator counts as success, because two
   * runs finishing together would otherwise both see 404 and the loser would fail on "already_exists".
   */
  ensureLabel(name) {
    if (!this.labelsPending.has(name)) {
      this.labelsPending.set(name, (async () => {
        try { await this.rest('GET', `/labels/${encodeURIComponent(name)}`); return; }
        catch (e) { if (e.status !== 404) throw e; }
        try { await this.rest('POST', '/labels', { name, color: 'c5def5', description: 'set by issue-herd' }); }
        catch (e) { if (e.status !== 422) throw e; }   // someone created it between our GET and POST
      })().catch((e) => { this.labelsPending.delete(name); throw e; }));
    }
    return this.labelsPending.get(name);
  }

  async addLabel(issueId, name) {
    await this.ensureLabel(name);
    await this.rest('POST', `/issues/${issueId}/labels`, { labels: [name] });
  }

  async removeLabel(issueId, name) {
    try { await this.rest('DELETE', `/issues/${issueId}/labels/${encodeURIComponent(name)}`); }
    catch (e) { if (e.status !== 404) throw e; }
  }

  async assign(issue, u) {
    await this.rest('POST', `/issues/${issue.id}/assignees`, { assignees: [u.login || u.id] });
  }

  /**
   * GitHub has two states, open and closed. The contract's state types map onto them; a workflow
   * name from some other tracker throws.
   *
   * Guessing was worse than refusing. Treating an unknown name as a label silently created
   * "In Progress" in the user's repository the first time a Linear-shaped config ran here, and
   * treating "Done" as closed shut the issue the moment its PR opened, before anyone reviewed it.
   * `issue-herd init --tracker github` sets these to null; the error says to do the same.
   */
  async setState(issue, name) {
    const want = String(name).trim().toLowerCase();
    const state = ['closed', 'completed', 'canceled'].includes(want) ? 'closed'
      : ['open', 'triage', 'backlog', 'unstarted', 'started'].includes(want) ? 'open'
        : null;
    if (!state) throw new Error(`GitHub has no workflow state "${name}" — an issue is only open or closed. Set this rule's state to null, "open" or "closed".`);
    await this.rest('PATCH', `/issues/${issue.id}`, { state });
    return { name: state, type: state === 'closed' ? 'completed' : 'unstarted' };
  }

  get owner() { this.check(); return this.repo.split('/')[0]; }
  get name() { return this.repo.split('/')[1]; }

  normalize(n) {
    const labels = (n.labels?.nodes || []).map((l) => l.name);
    const priority = priorityFromLabels(labels);
    const assignees = (n.assignees?.nodes || []).map(user).filter(Boolean);
    return {
      id: String(n.number),
      identifier: `${this.prefix}-${n.number}`,
      ref: `#${n.number}`,
      title: n.title,
      description: n.body || '',
      url: n.url,
      priority,
      priorityLabel: priority ? PRIORITY_NAMES[priority] : null,
      estimate: null,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      branchName: `${n.number}-${slugify(n.title, 40)}`,   // what GitHub's own "create a branch" button names it
      labels,
      project: n.milestone ? { id: String(n.milestone.number), name: n.milestone.title } : null,
      team: { id: this.repo, key: this.name, name: this.repo },
      assignees,
      assignee: pickAssignee(assignees, this.viewer?.login),
      creator: user(n.author),
      state: n.state === 'CLOSED' ? { id: 'closed', name: 'closed', type: 'completed' } : { id: 'open', name: 'open', type: 'unstarted' },
      cycle: null,
      comments: (n.comments?.nodes || []).map((c) => ({ body: c.body, createdAt: c.createdAt, author: c.author?.login || 'unknown' })),
    };
  }
}

const ISSUE_FIELDS = `{
  id number title body url state createdAt updatedAt
  labels(first: 50) { nodes { name } }
  milestone { number title }
  assignees(first: 10) { nodes { login name } }
  author { login ... on User { name } }
  comments(last: 25) { nodes { body createdAt author { login } } }
}`;

const ISSUES_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String, $since: DateTime) {
  rateLimit { remaining resetAt }
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }, filterBy: { since: $since }) {
      nodes ${ISSUE_FIELDS}
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function user(u) {
  if (!u?.login) return null;
  return { id: u.login, login: u.login, name: u.name || u.login, displayName: u.login, email: null };
}

/**
 * GitHub issues can have several assignees; `assignee` is the one worth showing. Prefer the token's
 * own account so the brief and `assignee:me` read naturally. This is display only: the guard that
 * decides whether someone else holds the issue reads the whole `assignees` list, because collapsing
 * "alex and you" to "you" would let the watcher claim an issue alex is working.
 */
function pickAssignee(assignees, meLogin) {
  if (!assignees?.length) return null;
  return (meLogin && assignees.find((a) => a.login === meLogin)) || assignees[0];
}

/**
 * The most urgent priority label on the issue, or 0. The most urgent, not the first: label order
 * is the repository's, so an issue re-triaged from `low` to `urgent` without the old label being
 * removed would otherwise read as Low and never match a `priority<=2` rule.
 */
export function priorityFromLabels(labels) {
  let best = 0;
  for (const l of labels) {
    const m = /^(?:priority[:\s-]*)?(p[0-3]|urgent|high|medium|low)$/i.exec(l.trim());
    if (!m) continue;
    const p = PRIORITY_LABELS[m[1].toLowerCase()];
    best = best === 0 ? p : Math.min(best, p);
  }
  return best;
}

/** "GH-7", "#7", "7", "owner/repo#7" → 7. */
export function issueNumber(identifier) {
  const m = /(\d+)\s*$/.exec(String(identifier));
  return m ? parseInt(m[1], 10) : null;
}

function hasGh() { try { execFileSync('gh', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }

/** "owner/name" from a git remote URL on `host`, or null. Handles ssh, https, ssh:// and git:// forms. */
export function repoFromRemote(url, host = 'github.com') {
  if (!url) return null;
  const h = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^(?:git@${h}:|(?:https?|ssh|git)://(?:[^@/]+@)?${h}(?::\\d+)?/)([^/]+/[^/]+?)(?:\\.git)?/?$`, 'i').exec(url.trim());
  return m ? m[1] : null;
}

export function repoFromGit(cwd, host) {
  try { return repoFromRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), host); }
  catch { return null; }
}
