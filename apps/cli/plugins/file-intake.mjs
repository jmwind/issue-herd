// A shipped example plugin: intake from a file.
//
// Issues come from `.weawr/issues.json` in the repository instead of a tracker — a list of
// { id, title, description?, labels?, state? } — and everything weawr writes back (the claim
// label, comments, the state) is written into that same file. Useful for an offline factory, a
// demo, or a source of work that is not an issue tracker at all: anything that can write a JSON
// file can feed a factory. `"tracker": "file"` in config.json, and `"plugins": ["examples/file-intake"]`.
//
// The contract is the one every tracker implements (packages/engine/src/adapters/tracker.mjs);
// this file has no import from weawr at all.
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'issues.json';

class FileTracker {
  static id = 'file';
  static label = 'Issues file';
  static auth = { env: [], hint: 'no token: the issues live in .weawr/issues.json' };
  /** `weawr login file` has nothing to do; a credential is still returned so the CLI's flow is unchanged. */
  static async login() { return { token: 'none', kind: 'none' }; }
  static fallback() { return { token: 'none', kind: 'none', source: 'the issues file' }; }

  constructor(credential, { options }) {
    this.file = path.join(options.cwd, '.weawr', FILE);
    this.user = { id: 'file', name: 'weawr', displayName: 'weawr', email: null };
  }
  describe() { return path.relative(process.cwd(), this.file) || this.file; }
  check() { if (!fs.existsSync(this.file)) throw new Error(`no ${this.file}: the file tracker reads issues from there ([{ "id": 1, "title": "…", "labels": ["ai"] }])`); }

  load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { throw new Error(`${this.file}: ${e.message}`); } }
  save(list) { const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n'); fs.renameSync(tmp, this.file); }
  normalize(raw) {
    const id = String(raw.id);
    const now = new Date().toISOString();
    return {
      id, identifier: `F-${id}`, ref: `F-${id}`, title: String(raw.title || ''), description: String(raw.description || ''), url: `file://${this.file}#${id}`,
      priority: Number.isInteger(raw.priority) ? raw.priority : 0, priorityLabel: raw.priority ? String(raw.priority) : null, estimate: null,
      createdAt: raw.createdAt || now, updatedAt: raw.updatedAt || raw.createdAt || now, branchName: raw.branch || `f-${id}-${String(raw.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}`,
      labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [], project: null, team: null,
      assignees: raw.assignee ? [{ id: raw.assignee, name: raw.assignee, displayName: raw.assignee, email: null }] : [], assignee: raw.assignee ? { id: raw.assignee, name: raw.assignee, displayName: raw.assignee, email: null } : null, creator: null,
      state: { id: raw.state || 'open', name: raw.state || 'open', type: raw.state === 'done' ? 'completed' : raw.state === 'in progress' ? 'started' : 'unstarted' }, cycle: null,
      comments: (raw.comments || []).map((c) => ({ body: String(c.body || ''), createdAt: c.createdAt || now, author: c.author || 'someone' })),
    };
  }
  find(list, id) { const i = list.findIndex((r) => String(r.id) === String(id)); if (i < 0) throw new Error(`no issue ${id} in ${this.file}`); return i; }

  async me() { return this.user; }
  async openIssues({ sinceIso }) { return this.load().filter((r) => r.state !== 'done' && r.state !== 'closed').map((r) => this.normalize(r)).filter((i) => !sinceIso || i.updatedAt >= sinceIso); }
  async issueByKey(identifier) { const r = this.load().find((x) => `F-${x.id}` === identifier || String(x.id) === identifier); return r ? this.normalize(r) : null; }
  async comment(issueId, body) { const list = this.load(); const i = this.find(list, issueId); (list[i].comments ||= []).push({ body, author: 'weawr', createdAt: new Date().toISOString() }); list[i].updatedAt = new Date().toISOString(); this.save(list); }
  async addLabel(issueId, name) { const list = this.load(); const i = this.find(list, issueId); list[i].labels = [...new Set([...(list[i].labels || []), name])]; this.save(list); }
  async removeLabel(issueId, name) { const list = this.load(); const i = this.find(list, issueId); list[i].labels = (list[i].labels || []).filter((l) => l !== name); this.save(list); }
  async assign(issue, user) { const list = this.load(); const i = this.find(list, issue.id); list[i].assignee = user.name; this.save(list); }
  async setState(issue, name) { const list = this.load(); const i = this.find(list, issue.id); list[i].state = name; list[i].updatedAt = new Date().toISOString(); this.save(list); return { name, type: name === 'done' ? 'completed' : 'started' }; }
}

export default { name: 'file-intake', version: '1.0.0', api: 1, intake: [FileTracker] };
