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
//
// Or a GitHub App (`issue-herd login github --app`, or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH),
// which is the tool's own identity rather than the maintainer's: everything it writes shows as
// `name[bot]` with a bot badge, it is not a billable seat, and it gets its own hourly API budget
// instead of spending the person's. There is no token to store — the app signs a nine-minute JWT
// with its private key, trades it for an installation token that lasts an hour, and renews it. The
// one thing it cannot do is hold an issue: GitHub assignees must be users, so an app run leans on
// the claim label instead (see assign()).

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { slugify } from '../tracker.mjs';
import { appJwt, deviceFlow, homePath, noCredentialError, privateKeyOf, usableCredential } from '../auth.mjs';

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

  /**
   * A GitHub App identity assembled from the environment: an app id and a private key, which is not
   * one variable and so cannot come through `auth.env`. `GITHUB_APP_INSTALLATION_ID` is optional —
   * the installation is looked up from the repository when it is not given.
   *
   * GITHUB_APP_PRIVATE_KEY_PATH is refused from a repository's `.env` (see loadEnvFile in the CLI),
   * for the same reason as ISSUE_HERD_*: it names a file this process reads and signs with, and a
   * committed .env must not get to choose which key on your disk that is.
   */
  static envCredential(env = process.env) {
    const appId = env.GITHUB_APP_ID;
    const privateKey = env.GITHUB_APP_PRIVATE_KEY || null;
    const privateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH || null;
    if (!appId || (!privateKey && !privateKeyPath)) return null;
    return { kind: 'app', appId, privateKey, privateKeyPath, installationId: env.GITHUB_APP_INSTALLATION_ID || null, source: 'GITHUB_APP_ID' };
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
    const { clientId = GITHUB_CLIENT_ID, paste = false, app = false, fetchImpl = fetch } = options;
    const host = this.host(options);
    if (app) return this.loginAsApp(ui, options, host);
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

  /**
   * `issue-herd login github --app`: register the app yourself, then tell issue-herd its id and
   * where its key is. Only the path is saved — the key stays the one copy GitHub gave you.
   *
   * There is no browser flow to run here on purpose. A GitHub App is created once, by a person with
   * admin rights, and installed on the repositories it may touch; that is a setup step, not a
   * sign-in, and pretending otherwise would only hide which permissions were granted.
   */
  static async loginAsApp(ui, options, host) {
    ui.log('A GitHub App is the tool\'s own identity: everything it writes appears as `name[bot]`,');
    ui.log('it is not a billable seat, and it has its own API rate limit.');
    ui.log('On the page that opens: New GitHub App → repository permissions Issues, Pull requests and Contents');
    ui.log('= Read and write → create it, install it on the repositories it should work, then Generate a private key.');
    await ui.open(`https://${host}/settings/apps`);
    const appId = (await ui.ask('App ID: ')).trim();
    if (!/^\d+$/.test(appId)) throw new Error(`the App ID is the number on the app's settings page, not ${JSON.stringify(appId)}`);
    const keyPath = homePath((await ui.ask('Path to the app private key (.pem): ')).trim());
    if (!keyPath) throw new Error('no private key given');
    const cred = { kind: 'app', appId, privateKeyPath: resolve(keyPath) };
    privateKeyOf(cred);   // fail here, where the person can fix it, rather than on the first poll
    return cred;
  }

  constructor(credential, { options = {}, fetchImpl = fetch } = {}) {
    const cred = typeof credential === 'string' ? { token: credential } : credential;
    if (!usableCredential(cred)) throw noCredentialError(GitHubTracker);
    this.cred = { ...cred };
    this.app = cred.kind === 'app';   // no token at rest; one is minted per installation, per hour
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

  describe() { return this.repo || '(repository unknown)'; }

  /**
   * The token to put in the next request. A personal one is used as it stands; an app has none, so
   * this mints an installation token on first use and a minute before each expiry (they last an
   * hour). The in-flight promise is shared, so a poll and three supervisors do not mint four.
   */
  async accessToken() {
    if (!this.app) return this.cred.token;
    if (this.installToken && Date.now() < this.installExpiresAt - 60_000) return this.installToken;
    this.minting ??= (async () => {
      const id = await this.installationId();
      const r = await this.request('POST', `${this.api}/app/installations/${id}/access_tokens`, null, { token: this.jwt() });
      this.installToken = r.token;
      this.installExpiresAt = Date.parse(r.expires_at) || Date.now() + 3600e3;
      return this.installToken;
    })().finally(() => { this.minting = null; });
    return this.minting;
  }

  /** A nine-minute JWT signed with the app's private key: how the app asks about itself. */
  jwt() { return appJwt({ appId: this.cred.appId, key: privateKeyOf(this.cred) }); }

  /** Which installation of the app to act as: the one on this repository, unless it was configured. */
  async installationId() {
    if (this.cred.installationId) return this.cred.installationId;
    this.check();
    try {
      const inst = await this.request('GET', `${this.api}/repos/${this.repo}/installation`, null, { token: this.jwt() });
      this.cred.installationId = inst.id;
      return inst.id;
    } catch (e) {
      if (e.status === 404) throw new Error(`GitHub App ${this.cred.appId} is not installed on ${this.repo} — install it (Settings → Developer settings → GitHub Apps → Install App), or set GITHUB_APP_INSTALLATION_ID`);
      throw e;
    }
  }

  /** Throws if this tracker cannot work: the watcher needs a repository (login only needs a token). */
  check() {
    if (!this.repo) throw new Error(`cannot tell which GitHub repository this is (origin is not on ${this.host}); set "tracker": { "type": "github", "repo": "owner/name" } in config.json`);
  }

  async request(method, url, body, { retry = true, token = null } = {}) {
    const headers = { authorization: `Bearer ${token || await this.accessToken()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'issue-herd' };
    if (body) headers['content-type'] = 'application/json';
    const res = await this.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok) {
      // An installation token can die before its hour is up (the app is reinstalled, its permissions
      // change). Throw ours away and mint another once, rather than 401 until the watcher restarts.
      if (res.status === 401 && retry && this.app && !token) {
        this.installToken = null;
        return this.request(method, url, body, { retry: false });
      }
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
    // An installation has its own hourly budget, so an app run is not spending the maintainer's.
    return this.rateLimit ? `${this.rateLimit.remaining} GraphQL points left until ${String(this.rateLimit.resetAt).slice(11, 16)}${this.app ? ' (the installation\'s own budget)' : ''}` : null;
  }

  /**
   * The account this credential acts as. For an app that is the app itself, asked for with its own
   * JWT: `slug[bot]` is the login its comments and pull requests carry, and the bot account's
   * numeric id is what makes a noreply address resolve to it, so a commit made with `commitEmail`
   * is attributed to the same identity the API writes as. Without the id the commit still lands,
   * just unlinked, which is why the lookup is allowed to fail.
   */
  async me() {
    if (!this.viewer) {
      if (this.app) {
        const a = await this.request('GET', `${this.api}/app`, null, { token: this.jwt() });
        const login = `${a.slug}[bot]`;
        const id = await this.request('GET', `${this.api}/users/${encodeURIComponent(login)}`).then((u) => u.id).catch(() => null);
        this.viewer = { id: login, login, name: a.name || login, displayName: login, email: null, app: true, commitEmail: `${id ? `${id}+` : ''}${login}@users.noreply.github.com` };
      } else {
        const d = await this.gql('{ viewer { login name } }');
        this.viewer = user(d.viewer);
      }
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

  /**
   * `onPickup.assignToMe`, when there is someone to assign to. A GitHub App is not one: assignees
   * must be users, and GitHub silently ignores a login it will not accept, so an app run says so
   * once and leans on the claim label — which is the guard that actually stops double work anyway.
   * Linear has no such limit, and delegates instead; the two trackers differ here for real reasons.
   */
  async assign(issue, u) {
    if (u.app) return 'not assigned: a GitHub App cannot be an issue assignee, so the claim label marks it instead';
    await this.rest('POST', `/issues/${issue.id}/assignees`, { assignees: [u.login || u.id] });
    return `assigned to @${u.login || u.id}`;
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
