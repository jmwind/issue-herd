// Linear. GraphQL, no dependencies. Auth: a personal API key (raw in the Authorization header) or an
// OAuth token from `issue-herd login` (Bearer, refreshed here when it expires).
//
// Browser sign-in needs an OAuth application in Linear (Settings → API → OAuth applications):
// callback URL http://localhost:8497/callback, public client (PKCE, no secret). Put its client id
// in LINEAR_CLIENT_ID below or in the ISSUE_HERD_LINEAR_CLIENT_ID environment variable. Without
// one, `issue-herd login linear` opens the personal-API-keys page and asks for the key instead.

import { slugify } from '../tracker.mjs';
import { oauthCodeFlow, postForm } from '../auth.mjs';

const ENDPOINT = 'https://api.linear.app/graphql';
const AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const TOKEN_URL = 'https://api.linear.app/oauth/token';
const API_KEYS_PAGE = 'https://linear.app/settings/account/security';
export const LINEAR_CLIENT_ID = process.env.ISSUE_HERD_LINEAR_CLIENT_ID || '';

export class LinearTracker {
  static id = 'linear';
  static label = 'Linear';
  static auth = { env: ['LINEAR_API_KEY'], hint: 'a personal API key: Linear → Settings → Security & access → Personal API keys' };

  static async login(ui, { clientId = LINEAR_CLIENT_ID, paste = false, fetchImpl = fetch } = {}) {
    if (clientId && !paste) {
      const t = await oauthCodeFlow({ authorizeUrl: AUTHORIZE_URL, tokenUrl: TOKEN_URL, clientId, scope: 'read,write', extra: { prompt: 'consent' }, ui, fetchImpl });
      return { kind: 'oauth', token: t.access_token, refreshToken: t.refresh_token || null, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null, clientId };
    }
    ui.log('Create a personal API key named "issue-herd" on the page that opens and paste it here.');
    await ui.open(API_KEYS_PAGE);
    const token = (await ui.askSecret('Linear API key: ')).trim();
    if (!token) throw new Error('no key entered');
    return { kind: 'apiKey', token };
  }

  constructor(credential, { fetchImpl = fetch, onCredential = null } = {}) {
    const cred = typeof credential === 'string' ? { token: credential } : credential;
    if (!cred?.token) throw new Error('no Linear token — run `issue-herd login linear` or put LINEAR_API_KEY in the repository .env.local');
    this.cred = { ...cred };
    this.fetch = fetchImpl;
    this.onCredential = onCredential;
    this.viewer = null;
    this.statesByTeam = new Map();
  }

  authHeader() {
    const t = this.cred.token;
    return this.cred.kind === 'oauth' || t.startsWith('lin_oauth_') ? `Bearer ${t}` : t;
  }

  /** OAuth tokens last 24h; renew a minute early, or on a 401, and hand the new one to whoever stores it. */
  async refresh() {
    const t = await postForm(TOKEN_URL, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.cred.refreshToken, client_id: this.cred.clientId || LINEAR_CLIENT_ID }), this.fetch);
    Object.assign(this.cred, { token: t.access_token, refreshToken: t.refresh_token || this.cred.refreshToken, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null });
    if (this.onCredential) await this.onCredential(this.cred);
  }

  async gql(query, variables = {}, { retry = true } = {}) {
    if (this.cred.refreshToken && this.cred.expiresAt && Date.now() > this.cred.expiresAt - 60_000) await this.refresh();
    const res = await this.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      if (res.status === 401 && retry && this.cred.refreshToken) { await this.refresh(); return this.gql(query, variables, { retry: false }); }
      const text = await res.text();
      let detail = text.slice(0, 200);
      try { const j = JSON.parse(text); if (j.errors?.length) detail = j.errors.map((e) => e.message).join('; '); } catch { /* keep text */ }
      throw new Error(`Linear HTTP ${res.status}: ${detail}${res.status === 401 ? ' — run `issue-herd login linear` or check LINEAR_API_KEY in .env.local' : ''}`);
    }
    const json = await res.json();
    if (json.errors?.length) throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    return json.data;
  }

  async me() {
    if (!this.viewer) {
      const d = await this.gql('{ viewer { id name displayName email } }');
      this.viewer = { ...d.viewer, login: null };
    }
    return this.viewer;
  }

  /** Open issues (not completed/canceled) updated since `sinceIso`, normalized. */
  async openIssues({ sinceIso, pageSize = 100, maxPages = 10 } = {}) {
    const filter = { state: { type: { nin: ['completed', 'canceled'] } } };
    if (sinceIso) filter.updatedAt = { gte: sinceIso };
    const out = [];
    let after = null;
    for (let page = 0; page < maxPages; page++) {
      const d = await this.gql(ISSUES_QUERY, { filter, first: pageSize, after });
      for (const n of d.issues.nodes) out.push(normalizeIssue(n));
      if (!d.issues.pageInfo.hasNextPage) break;
      after = d.issues.pageInfo.endCursor;
    }
    return out;
  }

  async issueByKey(identifier) {
    const d = await this.gql(`query($id: String!) { issue(id: $id) ${ISSUE_FIELDS} }`, { id: identifier });
    return d.issue ? normalizeIssue(d.issue) : null;
  }

  async comment(issueId, body) {
    const d = await this.gql(
      'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }',
      { input: { issueId, body } },
    );
    return d.commentCreate.comment;
  }

  async teamStates(teamId) {
    if (!this.statesByTeam.has(teamId)) {
      const d = await this.gql('query($id: String!) { team(id: $id) { states { nodes { id name type position } } } }', { id: teamId });
      this.statesByTeam.set(teamId, d.team.states.nodes);
    }
    return this.statesByTeam.get(teamId);
  }

  /** Move an issue to a state by name (case-insensitive) or by type (e.g. "started"). */
  async setState(issue, stateNameOrType) {
    const states = await this.teamStates(issue.team.id);
    const want = stateNameOrType.toLowerCase();
    const state = states.find((s) => s.name.toLowerCase() === want) || states.find((s) => s.type === want);
    if (!state) throw new Error(`team ${issue.team.key} has no state named or typed '${stateNameOrType}'`);
    await this.gql('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', {
      id: issue.id, input: { stateId: state.id },
    });
    return state;
  }

  async labelId(name) {
    this.labelIds ??= new Map();
    const key = name.toLowerCase();
    if (!this.labelIds.has(key)) {
      const d = await this.gql('query($name: String!) { issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 5) { nodes { id name team { id } } } }', { name });
      const hit = d.issueLabels.nodes.find((l) => !l.team) || d.issueLabels.nodes[0];
      if (!hit) throw new Error(`no Linear label named '${name}' — create it in Linear first`);
      this.labelIds.set(key, hit.id);
    }
    return this.labelIds.get(key);
  }

  async addLabel(issueId, labelName) {
    const labelId = await this.labelId(labelName);
    await this.gql('mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }', { id: issueId, labelId });
  }

  async removeLabel(issueId, labelName) {
    const labelId = await this.labelId(labelName);
    await this.gql('mutation($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }', { id: issueId, labelId });
  }

  async assign(issue, user) {
    await this.gql('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', {
      id: issue.id, input: { assigneeId: user.id },
    });
  }
}

const ISSUE_FIELDS = `{
  id identifier title description url priority priorityLabel estimate createdAt updatedAt branchName
  labels { nodes { name } }
  project { id name }
  team { id key name }
  assignee { id name displayName email }
  creator { id name displayName email }
  state { id name type }
  cycle { id number isActive }
  comments(first: 25) { nodes { body createdAt user { name displayName } } }
}`;

const ISSUES_QUERY = `query($filter: IssueFilter, $first: Int, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes ${ISSUE_FIELDS}
    pageInfo { hasNextPage endCursor }
  }
}`;

const user = (u) => (u ? { id: u.id, login: null, name: u.name, displayName: u.displayName, email: u.email } : null);

export function normalizeIssue(n) {
  return {
    id: n.id,
    identifier: n.identifier,
    ref: n.identifier,
    title: n.title,
    description: n.description || '',
    url: n.url,
    priority: n.priority ?? 0,
    priorityLabel: n.priorityLabel,
    estimate: n.estimate ?? null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    branchName: n.branchName || `${n.identifier.toLowerCase()}-${slugify(n.title, 32)}`,
    labels: (n.labels?.nodes || []).map((l) => l.name),
    project: n.project || null,
    team: n.team,
    assignee: user(n.assignee),
    creator: user(n.creator),
    state: n.state,
    cycle: n.cycle || null,
    comments: (n.comments?.nodes || []).map((c) => ({ body: c.body, createdAt: c.createdAt, author: c.user?.displayName || c.user?.name || 'unknown' })),
  };
}
