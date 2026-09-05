// Minimal Linear GraphQL client (no dependencies). Personal API key auth.

const ENDPOINT = 'https://api.linear.app/graphql';

export class LinearClient {
  constructor(apiKey, { fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error('LINEAR_API_KEY is not set — put it in the repository .env.local (see .env.example)');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.viewer = null;
    this.statesByTeam = new Map();
  }

  async gql(query, variables = {}) {
    const res = await this.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 200);
      try { const j = JSON.parse(text); if (j.errors?.length) detail = j.errors.map((e) => e.message).join('; '); } catch { /* keep text */ }
      throw new Error(`Linear HTTP ${res.status}: ${detail}${res.status === 401 ? ' — check LINEAR_API_KEY in .env.local' : ''}`);
    }
    const json = await res.json();
    if (json.errors?.length) throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    return json.data;
  }

  async me() {
    if (!this.viewer) {
      const d = await this.gql('{ viewer { id name displayName email } }');
      this.viewer = d.viewer;
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

  /**
   * Id of the label called `name` (case-insensitive; a workspace label wins over a team one).
   * With `create`, a label that does not exist yet is created as a workspace label, so a claim
   * label like `herdr-<host>` never has to be made by hand. Returns null when absent and not creating.
   */
  async labelId(name, { create = false } = {}) {
    this.labelIds ??= new Map();
    const key = name.toLowerCase();
    if (!this.labelIds.has(key)) {
      const d = await this.gql('query($name: String!) { issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 5) { nodes { id name team { id } } } }', { name });
      const hit = d.issueLabels.nodes.find((l) => !l.team) || d.issueLabels.nodes[0];
      if (hit) this.labelIds.set(key, hit.id);
      else if (create) this.labelIds.set(key, await this.createLabel(name));
      else return null;
    }
    return this.labelIds.get(key);
  }

  /** Create a workspace-level issue label. Returns its id. */
  async createLabel(name) {
    const d = await this.gql('mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }', { input: { name } });
    const created = d.issueLabelCreate?.issueLabel;
    if (!created?.id) throw new Error(`could not create Linear label '${name}'`);
    return created.id;
  }

  /** Add a label to an issue, creating the label in the workspace if Linear does not have it yet. */
  async addLabel(issueId, labelName) {
    const labelId = await this.labelId(labelName, { create: true });
    await this.gql('mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }', { id: issueId, labelId });
  }

  /** Remove a label from an issue. A label that does not exist cannot be on the issue: no-op. */
  async removeLabel(issueId, labelName) {
    const labelId = await this.labelId(labelName);
    if (!labelId) return;
    await this.gql('mutation($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }', { id: issueId, labelId });
  }

  async assign(issue, userId) {
    await this.gql('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', {
      id: issue.id, input: { assigneeId: userId },
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

export function normalizeIssue(n) {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description || '',
    url: n.url,
    priority: n.priority ?? 0,
    priorityLabel: n.priorityLabel,
    estimate: n.estimate ?? null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    branchName: n.branchName,
    labels: (n.labels?.nodes || []).map((l) => l.name),
    project: n.project || null,
    team: n.team,
    assignee: n.assignee || null,
    creator: n.creator || null,
    state: n.state,
    cycle: n.cycle || null,
    comments: (n.comments?.nodes || []).map((c) => ({ body: c.body, createdAt: c.createdAt, author: c.user?.displayName || c.user?.name || 'unknown' })),
  };
}
