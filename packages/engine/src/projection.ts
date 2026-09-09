// The canonical projection of a factory: from the runs, the structured events, what herdr says
// and what the tracker/GitHub said, to the snapshot every client renders. Pure: every input is
// passed in, so the whole thing is testable with fixtures. Ported from the console's model, with
// one change of principle: a run's history comes from its events, and a run with no events (one
// imported from state.json) has an unknown history — shown as unknown, never as zero wait.
import { verdictOf } from '@weawr/protocol';
import * as _claim from './claim.mjs';
import * as _herdr from './adapters/herdr.mjs';
const { issueKeyOf } = _claim as Record<string, any>;
const { isRunsWorkspace, workspaceOwner } = _herdr as Record<string, any>;

export interface TimelineEvent { ts: number; key: string; kind: 'working' | 'blocked' | 'question' | 'done' | 'gone' | 'merged' }

/** The store's structured events as the timeline the projection reads: one entry per event that moves a run. */
export function timelineOf(events: Array<{ at: string; kind: string; runKey?: string | null }>): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const e of events) {
    if (!e.runKey) continue;
    const kind: TimelineEvent['kind'] | null =
      e.kind === 'run.prompted' || e.kind === 'run.running' || e.kind === 'run.working' ? 'working'
      : e.kind === 'run.blocked' ? 'blocked'
      : e.kind === 'run.question' ? 'question'
      : e.kind === 'run.finished' ? 'done'
      : e.kind === 'run.stopped' || e.kind === 'run.failed' ? 'gone'
      : e.kind === 'run.merged' ? 'merged'
      : null;
    if (kind) out.push({ ts: Date.parse(e.at), key: e.runKey, kind });
  }
  return out;
}

// The console's view of a factory, computed from what is already on disk and what herdr says.
// Pure: every input is passed in, so the whole thing is testable with fixtures.


/**
 * The run's life as segments on one axis: working, blocked (a dialog), question (stopped to ask),
 * done. Ends at `now` for a run still going. From the log alone; a run the log never saw is one
 * working segment from startedAt.
 */
export function segments(run: any, events: TimelineEvent[], now = Date.now()): Array<{ from: number; to: number; kind: string }> {
  const start = Date.parse(run.startedAt || '') || now;
  const end = Date.parse(run.finishedAt || '') || now;
  const mine = events.filter((e: any) => e.ts >= start - 1000 && e.ts <= end + 1000);
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

/**
 * Milliseconds a person was being waited for: dialogs, questions, and a PR waiting to be merged.
 * The merge wait counts from `merge.since` (default: when the run finished), and not at all while
 * `merge.waiting` is false — a PR that reviewers are still reading is nobody's wait. Once the PR
 * is merged the wait is history, not gone: it ran from `merge.since` to `merge.until`.
 */
export function humanWaitMs(run: any, segs: Array<{ from: number; to: number; kind: string }>, now = Date.now(), merge: any = {}): number {
  let ms = 0;
  for (const s of segs) if (s.kind === 'blocked' || s.kind === 'question') ms += s.to - s.from;
  if (run.status === 'awaiting_merge' && merge.waiting !== false) ms += now - (merge.since || Date.parse(run.finishedAt || '') || now);
  else if (run.status === 'merged' && merge.since && merge.until) ms += Math.max(0, merge.until - merge.since);
  return Math.max(0, ms);
}

// ---------------------------------------------------------------- herdr

/**
 * herdr's snapshot as two maps: agents by name, workspaces by id. Tolerates a missing snapshot —
 * `available` is false then, and empty maps mean "unknown", not "nothing is running".
 */
export function indexSnapshot(snapshot: any): HerdrIndex {
  const s = snapshot?.result?.snapshot || snapshot?.snapshot || snapshot || {};
  const agents = new Map<string, any>(); const workspaces = new Map<string, any>(); const panes = new Map<string, any>();
  for (const a of s.agents || []) agents.set(a.name, a);
  for (const w of s.workspaces || []) workspaces.set(w.workspace_id, w);
  for (const p of s.panes || []) panes.set(p.pane_id, p);
  return { agents, workspaces, panes, version: s.version || null, available: !!snapshot };
}

/** Watcher workspaces herdr knows about (`<name>Watch`) with the directory they run in. */
export function watchWorkspaces(index: HerdrIndex) {
  const out: any[] = [];
  for (const w of index.workspaces.values()) {
    if (!/Watch$/.test(w.label || '')) continue;
    const pane = [...index.panes.values()].find((p: any) => p.workspace_id === w.workspace_id);
    out.push({ workspaceId: w.workspace_id, label: w.label, name: w.label.replace(/Watch$/, ''), cwd: pane?.foreground_cwd || pane?.cwd || null });
  }
  return out;
}

// ---------------------------------------------------------------- the view

const ROLE_ORDER = ['impl', 'review', 'usability'];

/**
 * How long an in-flight agent must read as idle, blocked or missing before that is an alert.
 * Each of those is what a run looks like on its way somewhere else: herdr has not registered the
 * agent yet, Claude Code is on its startup dialog, the prompt has not landed, a turn ended a
 * moment before the next one. The console asks herdr every two seconds, so every such moment
 * moved the task to Alerts and back. 45s is longer than an agent's startup and than the watcher's
 * own poll, and a question that will wait minutes for its answer loses nothing to it. Leaving an
 * alert state shows at once.
 */
export const SETTLE_MS = 45_000;
const SETTLES = new Set(['blocked', 'question', 'gone']);

/**
 * The state herdr reports for a live run, held back until it has lasted `settleMs`. `seen` is the
 * caller's memory between ticks — what each live run last read as (an alert state or not) and
 * since when — and is updated here; without one there is nothing to compare against and the
 * instant state stands. The watcher's log is memory too, but only for the console's first look
 * at a run: a dialog or question the watcher already logged has been going on at least that
 * long, so a console that starts up next to a long-blocked agent does not wait again. After
 * that the console's own observations are the truth: a recovery it saw ends the episode even
 * if the watcher, on its slower poll, never logged it, and the next episode waits the full window.
 */
function settle(key: string, st: any, run: any, segs: any[], { seen, settleMs, now }: any) {
  if (!seen) return st;
  if (run.status !== 'running' && run.status !== 'starting') { delete seen[key]; return st; }
  const kind = SETTLES.has(st.needsYou) ? st.needsYou : null;
  const first = !seen[key];
  if (first || seen[key].needsYou !== kind) seen[key] = { needsYou: kind, since: now };
  if (!kind) return st;
  const last = segs.at(-1);
  if (first && last?.kind === kind) seen[key].since = Math.min(now, last.from);
  if (now - seen[key].since >= settleMs) return st;
  return { light: 'green', phrase: run.status === 'starting' ? 'starting' : 'working', needsYou: null, settling: kind };
}

/** A run that made (or is the one that will merge) the task's pull request; every other role reviews it. */
export function ownsPr(run: any): boolean { return !!(run.prUrl || run.result?.prUrl) || run.status === 'awaiting_merge' || run.status === 'merged'; }

/**
 * The three-word state of one run for a row, and which light it gets. The task around the run
 * decides two things a run cannot see on its own:
 *   othersLive  another role is still running on the task, so a PR waiting to be merged is
 *               waiting for review, not for a person;
 *   reviewer    the task's PR belongs to another run, so this run's result is a report on it —
 *               findings for whoever merges, never a decision the reviewer is holding open.
 */
export function runState(run: any, agent: any, { othersLive = false, reviewer = false }: { othersLive?: boolean; reviewer?: boolean } = {}): { light: string; phrase: string; needsYou: string | null; settling?: string | null } {
  const st = run.status;
  const a = agent?.agent_status;
  if (st === 'running' || st === 'starting') {
    if (!agent) return { light: 'red', phrase: 'agent gone', needsYou: 'gone' };
    if (a === 'blocked') return { light: 'red', phrase: 'blocked on a dialog', needsYou: 'blocked' };
    if (a === 'working') return { light: 'green', phrase: 'working', needsYou: null };
    if (a === 'idle' || a === 'done' || a === 'unknown') return { light: 'yellow', phrase: 'waiting on you', needsYou: 'question' };
    return { light: 'green', phrase: a || 'starting', needsYou: null };
  }
  if (st === 'awaiting_merge') {
    if (a === 'blocked') return { light: 'red', phrase: 'blocked on a dialog', needsYou: 'blocked' };
    if (othersLive) return { light: a === 'working' ? 'green' : 'grey', phrase: 'waiting for review', needsYou: null };
    if (a === 'working') return { light: 'green', phrase: 'working', needsYou: null };
    return { light: 'yellow', phrase: 'awaiting your merge', needsYou: 'merge' };
  }
  if (st === 'merged') return { light: 'grey', phrase: 'merged', needsYou: null };
  if (st === 'done') {
    const r = run.result?.status;
    if (reviewer && r === 'needs_human') return { light: 'grey', phrase: 'has findings', needsYou: null };
    if (reviewer && r === 'nothing_to_do') return { light: 'grey', phrase: 'found nothing blocking', needsYou: null };
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
 *   seen      the caller's memory between ticks for settle(): pass the same object every tick,
 *             or nothing for a one-shot view that shows what herdr says right now
 */
export interface HerdrIndex { agents: Map<string, any>; workspaces: Map<string, any>; panes: Map<string, any>; version: string | null; available: boolean }

export interface ProjectionInput {
  id: string; factoryId?: string; repo: string; config?: any; state?: { runs: Record<string, any> }; events?: TimelineEvent[]; index?: HerdrIndex; sizes?: Record<string, any>;
  registry?: any; stale?: boolean; enrich?: { issues: Record<string, any>; prs: Record<string, any>; branches: Record<string, any> }; cleared?: Record<string, number>;
  seen?: Record<string, any> | null; settleMs?: number; now?: number; recipeRevision?: number | null; trackerScope?: string | null;
}

export function factoryView({ id, factoryId = id, repo, config = {}, state = { runs: {} }, events = [], index = indexSnapshot(null), sizes = {}, registry = null, stale = false, enrich = { issues: {}, prs: {}, branches: {} }, cleared = {}, seen = null, settleMs = SETTLE_MS, now = Date.now(), recipeRevision = null, trackerScope = null }: ProjectionInput) {
  const name = config.name || registry?.name || repo.split('/').pop();
  const tracker = typeof config.tracker === 'object' ? config.tracker?.type : (config.tracker || registry?.tracker || 'linear');
  const rules = (config.rules || []).filter((r: any) => r.enabled !== false).map((r: any) => ({
    name: r.name, role: r.role || null, match: r.match || '',
    agent: r.agentKind || config.defaults?.agentKind || 'claude', model: r.model || config.defaults?.model || null, effort: r.effort || config.defaults?.effort || null,
    basedOn: r.basedOn || null, passes: r.passes || 1, maxConcurrent: r.maxConcurrent ?? config.defaults?.maxConcurrent ?? null,
  }));
  const roles = (config.roles || [...new Set(rules.map((r: any) => r.role).filter(Boolean))]);
  const roleOrder = (r: any) => { const i = ROLE_ORDER.indexOf(r); return i < 0 ? 99 : i; };
  const roleList = [...roles].sort((a: any, b: any) => roleOrder(a) - roleOrder(b) || a.localeCompare(b));

  const byIssue = new Map<string, any>();
  for (const [key, run] of Object.entries(state.runs || {})) {
    const issueKey = run.issueKey || issueKeyOf(key);
    if (!byIssue.has(issueKey)) byIssue.set(issueKey, { key: issueKey, title: run.title || issueKey, url: run.url || null, runs: [] });
    byIssue.get(issueKey).runs.push({ key, run });
  }
  const isLive = (r: any) => r.status === 'running' || r.status === 'starting';
  for (const iss of byIssue.values()) iss.runs = iss.runs.map(({ key, run }: any) => {
    const siblings = iss.runs.filter((o: any) => o.key !== key).map((o: any) => o.run);
    const agent = index.agents.get(run.agentName) || null;
    const othersLive = siblings.some(isLive);
    const mine = events.filter((e: any) => e.key === key);
    // A run the events never saw (imported from state.json) is drawn as one working stretch from its
    // start to its end — those are recorded facts — but nothing is known about dialogs or questions
    // inside it, and the wait it reports is only what its state says (a PR waiting to be merged).
    // `partial` says so; a client shows the number as a floor, never as the whole story.
    const evidence: 'events' | 'partial' = mine.length || (run.status === 'running' || run.status === 'starting') ? 'events' : 'partial';
    const segs = segments(run, mine, now);
    const st = settle(key, runState(run, agent, { othersLive, reviewer: !ownsPr(run) && siblings.some(ownsPr) }), run, segs, { seen, settleMs, now });
    const started = Date.parse(run.startedAt || '') || now;
    const finished = Date.parse(run.finishedAt || '') || null;
    const size = sizes[key] || null;
    // A PR is a person's to merge from the moment the last role on the task has finished with it.
    const waitingSince = st.needsYou === 'merge' ? Math.max(finished || now, ...siblings.map((o: any) => Date.parse(o.finishedAt || '') || 0)) : null;
    // The PR's wait as an interval: open (`to` null: until now) while a person is the one being
    // waited for, so the view stays the same from tick to tick and only the clock moves.
    // A merge that happened keeps its wait. The watcher stamps `mergedAt` and then overwrites
    // `finishedAt` with the moment it noticed, so the agent's own finish is the log's `done`
    // event; the wait ran from the last role's finish to the merge, and there was none if a role
    // was still on the task when the PR merged. No `done` event in the log (the tail is finite)
    // means the wait is unknown, and unknown counts as none.
    const mergedAt = run.status === 'merged' ? Date.parse(run.mergedAt || '') || null : null;
    const doneAt = segs.find((s: any) => s.kind === 'done')?.from || null;
    let mergeWait: { from: number; to: number | null } | null = waitingSince ? { from: waitingSince, to: null } : null;
    if (mergedAt && doneAt) {
      const roleEnds = siblings.filter((o: any) => (Date.parse(o.startedAt || '') || 0) < mergedAt).map((o: any) => Date.parse(o.finishedAt || '') || Infinity);
      const from = Math.max(doneAt, ...roleEnds);
      if (from < mergedAt) mergeWait = { from, to: mergedAt };
    }
    const wsId = run.workspaceId || agent?.workspace_id || null;
    const owner = workspaceOwner(run, repo);
    return {
      key, role: run.role || null, rule: run.rule, pass: run.pass || 1, status: run.status, ownsPr: ownsPr(run),
      agent: run.agentName, agentKind: rules.find((r: any) => r.name === run.rule)?.agent || 'claude', agentStatus: agent?.agent_status || null, agentAlive: !!agent,
      // Still open in herdr: the snapshot lists it, in this repository, under this run's label or
      // with this run's agent standing in it — herdr reuses a closed workspace's id after a
      // restart, and a stranger's workspace under the run's old id is not this run's to close
      // (isRunsWorkspace). A workspace the snapshot does not list but the run's agent says it is
      // in is taken at the agent's word. Null when herdr did not answer: unknown is not closed.
      workspaceId: wsId, workspaceLabel: owner.label,
      workspaceOpen: !wsId ? false : !index.available ? null : index.workspaces.has(wsId) ? isRunsWorkspace(index.workspaces.get(wsId), owner, agent) : agent?.workspace_id === wsId,
      branch: run.branch || null, worktree: run.workDir || run.worktreePath || null,
      startedAt: run.startedAt || null, finishedAt: run.finishedAt || null,
      elapsedMs: (finished || now) - started,
      light: st.light, phrase: st.phrase, needsYou: st.needsYou, settling: st.settling || null,
      result: run.result ? (() => { const v = verdictOf(run.result); return { status: run.result.status, prUrl: run.result.prUrl || null, summary: run.result.summary || '', notes: run.result.notes || '', live: !!run.resultIsLive, verdict: v.verdict === 'unknown' ? null : v.verdict, verdictSource: v.source === 'none' ? null : v.source, verdictHead: v.headSha }; })() : null,
      prUrl: run.prUrl || run.result?.prUrl || null, error: run.error || null,
      segments: segs, humanWaitMs: humanWaitMs(run, segs, now, { waiting: st.needsYou === 'merge', since: mergeWait?.from, until: mergeWait?.to || undefined }), evidence, size, waitingSince, mergeWait,
      recipeRevision: run.recipeRevision ?? null, attemptId: run.attemptId ?? null,
    };
  });

  const issues = [...byIssue.values()].map((iss: any) => {
    iss.runs.sort((a: any, b: any) => roleOrder(a.role) - roleOrder(b.role) || (a.role || '').localeCompare(b.role || ''));
    const live = iss.runs.filter((r: any) => r.status === 'running' || r.status === 'starting' || r.status === 'awaiting_merge');
    // The PR the runs recorded, else the one GitHub has for a run's branch.
    const anyPr = iss.runs.map((r: any) => r.prUrl).find(Boolean) || iss.runs.map((r: any) => r.branch && enrich.branches?.[r.branch]).find(Boolean) || null;
    // What the tracker and GitHub said, when this machine could ask; null means unknown.
    const issueState = enrich.issues?.[iss.key] ?? null;
    const prLive = anyPr ? (enrich.prs?.[anyPr] ?? null) : null;
    const merged = iss.runs.some((r: any) => r.status === 'merged') || prLive === 'merged';
    // The PR's state as far as anyone knows: GitHub's answer first, then what the runs recorded.
    const prStateOf = !anyPr ? 'none' : prLive || (merged ? 'merged' : 'open');
    const lead = live.find((r: any) => r.needsYou) || live.find((r: any) => r.light === 'green') || live[0] || iss.runs.find((r: any) => r.needsYou) || iss.runs[0];
    const startedAt = iss.runs.map((r: any) => Date.parse(r.startedAt || '')).filter(Number.isFinite).sort()[0] || now;
    const lastEnd = iss.runs.every((r: any) => r.finishedAt) ? Math.max(...iss.runs.map((r: any) => Date.parse(r.finishedAt))) : now;
    // A person marked it done in the console, and nothing has started on it since.
    const clearedAt = cleared[iss.key] || 0;
    const isCleared = clearedAt > 0 && iss.runs.every((r: any) => (Date.parse(r.startedAt || '') || 0) <= clearedAt);
    const running = iss.runs.some((r: any) => r.status === 'running' || r.status === 'starting');
    const bucket = isCleared && !running ? (merged ? 'merged' : 'done') : live.length ? 'inflight' : merged ? 'merged' : 'done';
    const slots = roleList.length ? roleList.map((role: any) => { const r = iss.runs.find((x: any) => x.role === role); return { role, light: r ? (r.status === 'merged' || r.status === 'done' ? 'grey' : r.light) : 'empty', phrase: r?.phrase || 'not started' }; })
      : iss.runs.map((r: any) => ({ role: r.role || 'run', light: r.status === 'merged' || r.status === 'done' ? 'grey' : r.light, phrase: r.phrase }));
    // The task's light and phrase follow the task, not its unluckiest run: a merged task is
    // finished even if a reviewer never started, and a finished one is described by its outcome.
    const outcome = (s: any) => iss.runs.find((r: any) => r.result?.status === s);
    const finishedLead = outcome('needs_human') || outcome('pr_open') || outcome('nothing_to_do') || iss.runs.find((r: any) => r.status === 'merged') || lead;
    const light = bucket === 'inflight' ? (lead?.light || 'grey') : 'grey';
    const phrase = bucket === 'merged' ? 'merged'
      : bucket === 'done' ? (finishedLead ? (finishedLead.role && roleList.length > 1 ? `${finishedLead.role} ${finishedLead.phrase}` : finishedLead.phrase) : '')
      : lead ? (lead.role && roleList.length > 1 ? `${lead.role} ${lead.phrase}` : lead.phrase) : '';
    const size = iss.runs.map((r: any) => r.size).find(Boolean) || null;
    return {
      key: iss.key, title: iss.title, url: iss.url, bucket, light, phrase,
      prUrl: anyPr, merged, prState: prStateOf, issueState, cleared: isCleared, slots, startedAt: new Date(startedAt).toISOString(), elapsedMs: lastEnd - startedAt,
      humanWaitMs: iss.runs.reduce((s: any, r: any) => s + r.humanWaitMs, 0), size, runs: iss.runs,
      // A task with a run whose dialogs were never recorded reports a floor, and says so.
      evidence: iss.runs.some((r: any) => r.evidence === 'partial') ? 'partial' : 'events',
      finishedAt: iss.runs.every((r: any) => r.finishedAt) ? new Date(lastEnd).toISOString() : null,
      taskId: trackerScope ? `${factoryId}/${trackerScope}/${iss.key}` : null,
      attention: null as string | null,
    };
  });
  const order: Record<string, number> = { inflight: 0, done: 1, merged: 2 };
  issues.sort((a: any, b: any) => order[a.bucket] - order[b.bucket] || Date.parse(b.startedAt) - Date.parse(a.startedAt));

  const alerts: any[] = [];
  const DAY = 86400e3;
  for (const iss of issues) for (const r of iss.runs) {
    if (iss.cleared) continue;
    let why = r.needsYou;
    // A run that failed or stopped is worth a card while it is news. After a day it is history:
    // state.json keeps it forever, and the issue has usually been retried or given up on by then.
    if ((why === 'failed' || why === 'stopped' || why === 'gone') && r.finishedAt && now - Date.parse(r.finishedAt) > DAY) why = null;
    // A finished agent still holding its workspace is a fact, not an alert, while the task is in
    // flight: workspaces are kept for whoever reviews the PR. Once the task is over it is clutter.
    if (!why) { if (iss.bucket !== 'inflight' && r.agentAlive && (r.status === 'done' || r.status === 'merged') && r.agentStatus !== 'working') alerts.push(alert('holding', iss, r, `Finished (${r.result?.status || r.status}) and still holding workspace ${r.workspaceId || '?'}.`, now)); continue; }
    if (why === 'blocked') alerts.push(alert('blocked', iss, r, `Waiting for approval or input in workspace ${r.workspaceId || '?'}.`, now));
    else if (why === 'question') alerts.push(alert('question', iss, r, `Stopped without a result and is probably asking a question in workspace ${r.workspaceId || '?'}.`, now));
    else if (why === 'merge') {
      // The reviews are in; their verdicts are what the person merging wants to know.
      const reviews = iss.runs.filter((o: any) => o.key !== r.key && o.result).map((o: any) => `${o.role || o.rule} ${o.phrase}`).join(', ');
      alerts.push({ ...alert('merge', iss, r, `Pull request open${reviews ? `; ${reviews}` : ''}. Waiting for your merge.`, now), verdicts: reviews || null });
    }
    else if (why === 'needs_human') alerts.push(alert('needs_human', iss, r, r.result?.summary ? clip(r.result.summary, 240) : 'Stopped for a decision only you can make.', now));
    else if (why === 'gone') alerts.push(alert('gone', iss, r, 'The run is marked running but herdr has no such agent.', now));
    else if (why === 'stopped') alerts.push(alert('stopped', iss, r, `The agent ended without writing a result. Workspace ${r.workspaceId || '?'} is still open.`, now));
    else if (why === 'failed') alerts.push(alert('failed', iss, r, r.error || (r.result?.summary ? clip(r.result.summary, 240) : 'Failed.'), now));
  }
  // A finished task is not over until a person says so. Whatever happened to its agents — exited
  // on their own, exited by onMerged, still holding a workspace — it waits in Alerts for a sign-off,
  // even after an auto-merge, so the reports and the scrollback get looked at. One card per task;
  // a task that already has a card (a decision, a failure, an agent holding on) needs no second.
  // After a day it is history, like a failure: state.json remembers every task ever run.
  for (const iss of issues) {
    if (iss.cleared || iss.bucket === 'inflight' || !iss.finishedAt || alerts.some((a: any) => a.issueKey === iss.key)) continue;
    const finishedAt = Date.parse(iss.finishedAt);
    if (now - finishedAt > DAY) continue;
    const r = iss.runs.find((o: any) => o.ownsPr) || iss.runs[0];
    const reports = iss.runs.filter((o: any) => o !== r && o.result).map((o: any) => `${o.role || o.rule} ${o.phrase}`).join(', ');
    const what = iss.merged ? `Merged${iss.prUrl ? ` #${iss.prUrl.split('/').pop()}` : ''}` : `Finished (${iss.phrase || r.result?.status || r.status})`;
    alerts.push({ ...alert('finished', iss, r, `${what}${reports ? `; ${reports}` : ''}. Look it over and mark it done.`, now), light: 'yellow', sinceMs: now - finishedAt, verdicts: reports || null });
  }
  const weight: Record<string, number> = { blocked: 0, question: 1, needs_human: 2, merge: 3, stopped: 4, failed: 5, gone: 6, holding: 7, finished: 8 };
  alerts.sort((a: any, b: any) => weight[a.kind] - weight[b.kind] || b.sinceMs - a.sinceMs);
  // What a person should do about a task, decided here so no client has to: the top-ranked alert.
  for (const iss of issues) iss.attention = alerts.find((a: any) => a.issueKey === iss.key)?.kind ?? null;

  const allRuns = issues.flatMap((i: any) => i.runs);
  const running = allRuns.filter((r: any) => r.status === 'running' || r.status === 'starting').length;
  // A factory is working when an agent on it is: the lights are on and the belts move.
  const working = allRuns.filter((r: any) => r.light === 'green' && r.agentAlive).length;
  const windows = productionWindows(now);
  return {
    id, repo, name, tracker, roles: roleList, rules,
    maxConcurrent: config.maxConcurrent ?? null, pollSeconds: config.pollSeconds ?? registry?.pollSeconds ?? null,
    watcher: { version: registry?.version || null, lastPoll: registry?.lastPoll || null, stale, workspaceId: registry?.workspaceId || null, pid: registry?.pid || null },
    counts: { running, working, alerts: alerts.length, inflight: issues.filter((i: any) => i.bucket === 'inflight').length, merged: issues.filter((i: any) => i.bucket === 'merged').length, done: issues.filter((i: any) => i.bucket === 'done').length },
    humanWaitMs: issues.reduce((s: any, i: any) => s + i.humanWaitMs, 0),
    recipeRevision, factoryId,
    production: { today: production(issues, windows.today, now), week: production(issues, windows.week, now), month: production(issues, windows.month, now) },
    alerts, issues,
  };
}

// ---------------------------------------------------------------- production

/** When today, this week (from Monday) and this month began, in the machine's local time. */
export function productionWindows(now = Date.now()): { today: number; week: number; month: number } {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const week = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7).getTime();
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return { today, week, month };
}

/**
 * The factory's production since `from`: tasks finished (and how many of those merged), the
 * agents' time working with nobody waited for, and a person's time being waited for (dialogs,
 * questions, a PR waiting to be merged, and the wait a merged PR had). Times are clipped to the
 * window, so a run that straddles midnight counts today's part only.
 */
export function production(issues: any[], from: number, now = Date.now()): { finished: number; merged: number; workingMs: number; humanMs: number } {
  let finished = 0, merged = 0, workingMs = 0, humanMs = 0;
  const clip = (a: any, b: any) => Math.max(0, Math.min(b, now) - Math.max(a, from));
  for (const iss of issues) {
    if (iss.bucket !== 'inflight' && iss.finishedAt && Date.parse(iss.finishedAt) >= from) { finished++; if (iss.merged) merged++; }
    for (const r of iss.runs) {
      for (const s of r.segments) {
        if (s.kind === 'working') workingMs += clip(s.from, s.to);
        else if (s.kind === 'blocked' || s.kind === 'question') humanMs += clip(s.from, s.to);
      }
      if (r.mergeWait) humanMs += clip(r.mergeWait.from, r.mergeWait.to || now);
    }
  }
  return { finished, merged, workingMs, humanMs };
}

function clip(s: any, n: number): string { s = String(s); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }

function alert(kind: string, iss: any, r: any, text: string, now: number) {
  const since = kind === 'merge' ? (r.waitingSince || Date.parse(r.finishedAt || '') || now)
    : kind === 'holding' || kind === 'needs_human' || kind === 'stopped' || kind === 'failed' ? (Date.parse(r.finishedAt || '') || now)
    : (r.segments.filter((s: any) => s.kind === 'blocked' || s.kind === 'question').at(-1)?.from || now);
  return { kind, issueKey: iss.key, title: iss.title, runKey: r.key, role: r.role, agent: r.agent, agentKind: r.agentKind, workspaceId: r.workspaceId, prUrl: r.prUrl, url: iss.url, text, sinceMs: now - since, light: r.light };
}
