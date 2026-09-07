// The console's view of a factory, computed from what is already on disk and what herdr says.
// Pure: every input is passed in, so the whole thing is testable with fixtures.
import { issueKeyOf } from '../claim.mjs';

// ---------------------------------------------------------------- the watcher's log

const LINE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] (\S+?): (.*)$/;

/** One event per line that changes a run's state. Timestamps are local time, as the watcher writes them. */
export function parseLog(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    const key = m[7]; const msg = m[8];
    let kind = null;
    if (/^prompted/.test(msg)) kind = 'working';
    else if (/^blocked\b/.test(msg)) kind = 'blocked';
    else if (/^unblocked/.test(msg)) kind = 'working';
    else if (/^(idle|done|unknown) without a result/.test(msg)) kind = 'question';
    else if (/^working again/.test(msg)) kind = 'working';
    else if (/^done \(/.test(msg)) kind = 'done';
    else if (/^agent exited without a result/.test(msg)) kind = 'gone';
    else if (/^(pull request .* merged|PR .* merged)/i.test(msg)) kind = 'merged';
    if (kind) out.push({ ts, key, kind });
  }
  return out;
}

/**
 * The run's life as segments on one axis: working, blocked (a dialog), question (stopped to ask),
 * done. Ends at `now` for a run still going. From the log alone; a run the log never saw is one
 * working segment from startedAt.
 */
export function segments(run, events, now = Date.now()) {
  const start = Date.parse(run.startedAt || '') || now;
  const end = Date.parse(run.finishedAt || '') || now;
  const mine = events.filter((e) => e.ts >= start - 1000 && e.ts <= end + 1000);
  const segs = [];
  let kind = 'working'; let from = start;
  for (const e of mine) {
    const next = e.kind === 'done' || e.kind === 'gone' ? 'done' : e.kind === 'merged' ? null : e.kind;
    if (!next || next === kind) continue;
    if (e.ts > from) segs.push({ from, to: e.ts, kind });
    kind = next; from = e.ts;
  }
  if (kind !== 'done' && run.finishedAt) { if (end > from) segs.push({ from, to: end, kind }); segs.push({ from: end, to: now, kind: 'done' }); }
  else if (now > from) segs.push({ from, to: now, kind });
  return segs;
}

/** Milliseconds a person was being waited for: dialogs, questions, and a PR waiting to be merged. */
export function humanWaitMs(run, segs, now = Date.now()) {
  let ms = 0;
  for (const s of segs) if (s.kind === 'blocked' || s.kind === 'question') ms += s.to - s.from;
  if (run.status === 'awaiting_merge') ms += now - (Date.parse(run.finishedAt || '') || now);
  return Math.max(0, ms);
}

// ---------------------------------------------------------------- herdr

/** herdr's snapshot as two maps: agents by name, workspaces by id. Tolerates a missing snapshot. */
export function indexSnapshot(snapshot) {
  const s = snapshot?.result?.snapshot || snapshot?.snapshot || snapshot || {};
  const agents = new Map(); const workspaces = new Map(); const panes = new Map();
  for (const a of s.agents || []) agents.set(a.name, a);
  for (const w of s.workspaces || []) workspaces.set(w.workspace_id, w);
  for (const p of s.panes || []) panes.set(p.pane_id, p);
  return { agents, workspaces, panes, version: s.version || null };
}

/** Watcher workspaces herdr knows about (`<name>Watch`) with the directory they run in. */
export function watchWorkspaces(index) {
  const out = [];
  for (const w of index.workspaces.values()) {
    if (!/Watch$/.test(w.label || '')) continue;
    const pane = [...index.panes.values()].find((p) => p.workspace_id === w.workspace_id);
    out.push({ workspaceId: w.workspace_id, label: w.label, name: w.label.replace(/Watch$/, ''), cwd: pane?.foreground_cwd || pane?.cwd || null });
  }
  return out;
}

// ---------------------------------------------------------------- the view

const ROLE_ORDER = ['impl', 'review', 'usability'];

/** The three-word state of one run for a row, and which light it gets. */
export function runState(run, agent) {
  const st = run.status;
  if (st === 'running' || st === 'starting') {
    const a = agent?.agent_status;
    if (!agent) return { light: 'red', phrase: 'agent gone', needsYou: 'gone' };
    if (a === 'blocked') return { light: 'red', phrase: 'blocked on a dialog', needsYou: 'blocked' };
    if (a === 'working') return { light: 'green', phrase: 'working', needsYou: null };
    if (a === 'idle' || a === 'done' || a === 'unknown') return { light: 'yellow', phrase: 'waiting on you', needsYou: 'question' };
    return { light: 'green', phrase: a || 'starting', needsYou: null };
  }
  if (st === 'awaiting_merge') return { light: 'yellow', phrase: 'awaiting your merge', needsYou: 'merge' };
  if (st === 'merged') return { light: 'grey', phrase: 'merged', needsYou: null };
  if (st === 'done') {
    const r = run.result?.status;
    if (r === 'needs_human') return { light: 'yellow', phrase: 'needs you', needsYou: 'needs_human' };
    if (r === 'pr_open') return { light: 'grey', phrase: 'PR open', needsYou: null };
    if (r === 'nothing_to_do') return { light: 'grey', phrase: 'nothing to do', needsYou: null };
    if (r === 'failed') return { light: 'red', phrase: 'failed', needsYou: 'failed' };
    return { light: 'grey', phrase: r || 'done', needsYou: null };
  }
  if (st === 'stopped') return { light: 'red', phrase: 'stopped without a result', needsYou: 'stopped' };
  if (st === 'failed') return { light: 'red', phrase: 'failed to start', needsYou: 'failed' };
  return { light: 'grey', phrase: st, needsYou: null };
}

/**
 * One factory, ready to render.
 *   config    the merged config.json (+ local): name, tracker, roles, rules, maxConcurrent, pollSeconds
 *   state     state.json
 *   events    parseLog() of the watcher's log
 *   index     indexSnapshot() of herdr
 *   sizes     { [runKey]: runSize() result } for whichever runs the caller measured
 *   registry  the registry entry for this repo, or null
 */
export function factoryView({ id, repo, config = {}, state = { runs: {} }, events = [], index = indexSnapshot(null), sizes = {}, registry = null, stale = false, enrich = { issues: {}, prs: {} }, cleared = {}, now = Date.now() }) {
  const name = config.name || registry?.name || repo.split('/').pop();
  const tracker = typeof config.tracker === 'object' ? config.tracker?.type : (config.tracker || registry?.tracker || 'linear');
  const rules = (config.rules || []).filter((r) => r.enabled !== false).map((r) => ({
    name: r.name, role: r.role || null, match: r.match || '',
    agent: r.agentKind || config.defaults?.agentKind || 'claude', model: r.model || config.defaults?.model || null, effort: r.effort || config.defaults?.effort || null,
    basedOn: r.basedOn || null, passes: r.passes || 1, maxConcurrent: r.maxConcurrent ?? config.defaults?.maxConcurrent ?? null,
  }));
  const roles = (config.roles || [...new Set(rules.map((r) => r.role).filter(Boolean))]);
  const roleOrder = (r) => { const i = ROLE_ORDER.indexOf(r); return i < 0 ? 99 : i; };
  const roleList = [...roles].sort((a, b) => roleOrder(a) - roleOrder(b) || a.localeCompare(b));

  const byIssue = new Map();
  for (const [key, run] of Object.entries(state.runs || {})) {
    const issueKey = run.issueKey || issueKeyOf(key);
    const agent = index.agents.get(run.agentName) || null;
    const st = runState(run, agent);
    const segs = segments(run, events.filter((e) => e.key === key), now);
    const started = Date.parse(run.startedAt || '') || now;
    const finished = Date.parse(run.finishedAt || '') || null;
    const size = sizes[key] || null;
    const entry = {
      key, role: run.role || null, rule: run.rule, pass: run.pass || 1, status: run.status,
      agent: run.agentName, agentKind: rules.find((r) => r.name === run.rule)?.agent || 'claude', agentStatus: agent?.agent_status || null, agentAlive: !!agent,
      workspaceId: run.workspaceId || agent?.workspace_id || null, branch: run.branch || null, worktree: run.workDir || run.worktreePath || null,
      startedAt: run.startedAt || null, finishedAt: run.finishedAt || null,
      elapsedMs: (finished || now) - started,
      light: st.light, phrase: st.phrase, needsYou: st.needsYou,
      result: run.result ? { status: run.result.status, prUrl: run.result.prUrl || null, summary: run.result.summary || '', notes: run.result.notes || '' } : null,
      prUrl: run.prUrl || run.result?.prUrl || null, error: run.error || null,
      segments: segs, humanWaitMs: humanWaitMs(run, segs, now), size,
    };
    if (!byIssue.has(issueKey)) byIssue.set(issueKey, { key: issueKey, title: run.title || issueKey, url: run.url || null, runs: [] });
    byIssue.get(issueKey).runs.push(entry);
  }

  const issues = [...byIssue.values()].map((iss) => {
    iss.runs.sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || (a.role || '').localeCompare(b.role || ''));
    const live = iss.runs.filter((r) => r.status === 'running' || r.status === 'starting' || r.status === 'awaiting_merge');
    const anyPr = iss.runs.map((r) => r.prUrl).find(Boolean) || null;
    // What the tracker and GitHub said, when this machine could ask; null means unknown.
    const issueState = enrich.issues?.[iss.key] ?? null;
    const prLive = anyPr ? (enrich.prs?.[anyPr] ?? null) : null;
    const merged = iss.runs.some((r) => r.status === 'merged') || prLive === 'merged';
    // The PR's state as far as anyone knows: GitHub's answer first, then what the runs recorded.
    const prStateOf = !anyPr ? 'none' : prLive || (merged ? 'merged' : 'open');
    const lead = live.find((r) => r.needsYou) || live.find((r) => r.light === 'green') || live[0] || iss.runs.find((r) => r.needsYou) || iss.runs[0];
    const startedAt = iss.runs.map((r) => Date.parse(r.startedAt || '')).filter(Number.isFinite).sort()[0] || now;
    const lastEnd = iss.runs.every((r) => r.finishedAt) ? Math.max(...iss.runs.map((r) => Date.parse(r.finishedAt))) : now;
    // A person marked it done in the console, and nothing has started on it since.
    const clearedAt = cleared[iss.key] || 0;
    const isCleared = clearedAt > 0 && iss.runs.every((r) => (Date.parse(r.startedAt || '') || 0) <= clearedAt);
    const running = iss.runs.some((r) => r.status === 'running' || r.status === 'starting');
    const bucket = isCleared && !running ? (merged ? 'merged' : 'done') : live.length ? 'inflight' : merged ? 'merged' : 'done';
    const slots = roleList.length ? roleList.map((role) => { const r = iss.runs.find((x) => x.role === role); return { role, light: r ? (r.status === 'merged' || r.status === 'done' ? 'grey' : r.light) : 'empty', phrase: r?.phrase || 'not started' }; })
      : iss.runs.map((r) => ({ role: r.role || 'run', light: r.status === 'merged' || r.status === 'done' ? 'grey' : r.light, phrase: r.phrase }));
    // The task's light and phrase follow the task, not its unluckiest run: a merged task is
    // finished even if a reviewer never started, and a finished one is described by its outcome.
    const outcome = (s) => iss.runs.find((r) => r.result?.status === s);
    const finishedLead = outcome('needs_human') || outcome('pr_open') || outcome('nothing_to_do') || iss.runs.find((r) => r.status === 'merged') || lead;
    const light = bucket === 'inflight' ? (lead?.light || 'grey') : 'grey';
    const phrase = bucket === 'merged' ? 'merged'
      : bucket === 'done' ? (finishedLead ? (finishedLead.role && roleList.length > 1 ? `${finishedLead.role} ${finishedLead.phrase}` : finishedLead.phrase) : '')
      : lead ? (lead.role && roleList.length > 1 ? `${lead.role} ${lead.phrase}` : lead.phrase) : '';
    const size = iss.runs.map((r) => r.size).find(Boolean) || null;
    return {
      key: iss.key, title: iss.title, url: iss.url, bucket, light, phrase,
      prUrl: anyPr, merged, prState: prStateOf, issueState, cleared: isCleared, slots, startedAt: new Date(startedAt).toISOString(), elapsedMs: lastEnd - startedAt,
      humanWaitMs: iss.runs.reduce((s, r) => s + r.humanWaitMs, 0), size, runs: iss.runs,
      finishedAt: iss.runs.every((r) => r.finishedAt) ? new Date(lastEnd).toISOString() : null,
    };
  });
  const order = { inflight: 0, done: 1, merged: 2 };
  issues.sort((a, b) => order[a.bucket] - order[b.bucket] || Date.parse(b.startedAt) - Date.parse(a.startedAt));

  const alerts = [];
  const DAY = 86400e3;
  for (const iss of issues) for (const r of iss.runs) {
    if (iss.cleared) continue;
    let why = r.needsYou;
    // A run that failed or stopped is worth a card while it is news. After a day it is history:
    // state.json keeps it forever, and the issue has usually been retried or given up on by then.
    if ((why === 'failed' || why === 'stopped' || why === 'gone') && r.finishedAt && now - Date.parse(r.finishedAt) > DAY) why = null;
    if (!why) { if (r.agentAlive && (r.status === 'done' || r.status === 'merged') && r.agentStatus !== 'working') alerts.push(alert('holding', iss, r, `Finished (${r.result?.status || r.status}) and still holding workspace ${r.workspaceId || '?'}.`, now)); continue; }
    if (why === 'blocked') alerts.push(alert('blocked', iss, r, `Waiting for approval or input in workspace ${r.workspaceId || '?'}.`, now));
    else if (why === 'question') alerts.push(alert('question', iss, r, `Stopped without a result and is probably asking a question in workspace ${r.workspaceId || '?'}.`, now));
    else if (why === 'merge') alerts.push(alert('merge', iss, r, 'Pull request open. Waiting for your merge.', now));
    else if (why === 'needs_human') alerts.push(alert('needs_human', iss, r, r.result?.summary ? clip(r.result.summary, 240) : 'Stopped for a decision only you can make.', now));
    else if (why === 'gone') alerts.push(alert('gone', iss, r, 'The run is marked running but herdr has no such agent.', now));
    else if (why === 'stopped') alerts.push(alert('stopped', iss, r, `The agent ended without writing a result. Workspace ${r.workspaceId || '?'} is still open.`, now));
    else if (why === 'failed') alerts.push(alert('failed', iss, r, r.error || (r.result?.summary ? clip(r.result.summary, 240) : 'Failed.'), now));
  }
  const weight = { blocked: 0, question: 1, needs_human: 2, merge: 3, stopped: 4, failed: 5, gone: 6, holding: 7 };
  alerts.sort((a, b) => weight[a.kind] - weight[b.kind] || b.sinceMs - a.sinceMs);

  const running = issues.flatMap((i) => i.runs).filter((r) => r.status === 'running' || r.status === 'starting').length;
  return {
    id, repo, name, tracker, roles: roleList, rules,
    maxConcurrent: config.maxConcurrent ?? null, pollSeconds: config.pollSeconds ?? registry?.pollSeconds ?? null,
    watcher: { version: registry?.version || null, lastPoll: registry?.lastPoll || null, stale, workspaceId: registry?.workspaceId || null, pid: registry?.pid || null },
    counts: { running, alerts: alerts.length, inflight: issues.filter((i) => i.bucket === 'inflight').length, merged: issues.filter((i) => i.bucket === 'merged').length, done: issues.filter((i) => i.bucket === 'done').length },
    humanWaitMs: issues.reduce((s, i) => s + i.humanWaitMs, 0),
    alerts, issues,
  };
}

function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }

function alert(kind, iss, r, text, now) {
  const since = kind === 'merge' || kind === 'holding' || kind === 'needs_human' || kind === 'stopped' || kind === 'failed'
    ? (Date.parse(r.finishedAt || '') || now)
    : (r.segments.filter((s) => s.kind === 'blocked' || s.kind === 'question').at(-1)?.from || now);
  return { kind, issueKey: iss.key, title: iss.title, runKey: r.key, role: r.role, agent: r.agent, agentKind: r.agentKind, workspaceId: r.workspaceId, prUrl: r.prUrl, url: iss.url, text, sinceMs: now - since, light: r.light };
}
