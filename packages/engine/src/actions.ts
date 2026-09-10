// What a person asks of a task through a console: mark it done (every agent on it exits, every
// workspace closes, the task moves to output), undo that, stop its agents, tidy the pile, read an
// agent's screen, exit one agent. Ported from the console's orchestrator into the owner: one
// implementation, evented, and refused rather than recorded when herdr is not answering.
import type { TeamEngine } from './team.js';
import { isDurable } from './store/index.js';
import * as _agents from './agents.mjs';
import * as _herdr from './adapters/herdr.mjs';
const { exitCommandFor } = _agents as Record<string, any>;
const { isNotFound } = _herdr as Record<string, any>;

/** Why a Mark done or Tidy is refused while herdr is not answering: nothing can be closed, so nothing is recorded. */
export const HERDR_AWAY = 'herdr is not answering; nothing was closed and nothing is marked done — try again when it is back';

export interface CloseOutcome { run: string; role: string | null; agent: string | null; outcome: string; workspaceId: string | null; workspace: string | null }

/**
 * What became of one run's workspace close, as a phrase: 'closed', 'was already closed', 'was
 * reused by herdr for "…"' (the id names somebody else's workspace now — herdr numbers them per
 * server session — and that one is left alone), or 'is still open (why)'.
 */
export async function closeWorkspace(engine: TeamEngine, r: { workspaceId?: string | null; workspaceLabel?: string | null; agent?: string | null }): Promise<string> {
  if (!r.workspaceId) return 'was already closed';
  try {
    if (typeof engine.herdr.closeWorkspaceOf === 'function') return await engine.herdr.closeWorkspaceOf(r.workspaceId, { label: r.workspaceLabel ?? null, repo: engine.paths.repo, agentName: r.agent ?? null });
    await engine.herdr.closeWorkspace(r.workspaceId); return 'closed';
  } catch (e: any) {
    if (isNotFound(e)) return 'was already closed';
    engine.log(`could not close workspace ${r.workspaceId}: ${e.message}`);
    return `is still open (${e.message})`;
  }
}

/**
 * Every run on the task is shut down: an agent still up is sent its own exit command and goes the
 * way it wants, and then its herdr workspace is closed — the agent first, because it is a process
 * with its own idea of how to stop; the workspace second. A workspace whose agent would not exit is
 * left alone. Runs with nothing to close are not reported.
 */
export async function closeTask(engine: TeamEngine, task: any): Promise<CloseOutcome[]> {
  const outcomes: CloseOutcome[] = [];
  for (const r of task.runs) {
    const hasWorkspace = !!r.workspaceId && r.workspaceOpen !== false;
    if (!r.agentAlive && !hasWorkspace) continue;
    const outcome = r.agentAlive ? await engine.herdr.stopAgent(r.agent, { exitCommand: exitCommandFor(r.agentKind) }) : 'was already gone';
    let workspace: string | null = null;
    if (hasWorkspace) workspace = outcome === 'is still running' ? 'left open' : await closeWorkspace(engine, r);
    outcomes.push({ run: r.key, role: r.role, agent: r.agent, outcome, workspaceId: r.workspaceId || null, workspace });
    engine.emit('run.closed_by_person', r.key, { outcome, workspace });
  }
  return outcomes;
}

/**
 * A person decided the task is done: composed of the shutdown and, only when every step
 * succeeded, the acknowledgement. Stop, acknowledgement and cleanup stay distinct facts: a task
 * with an agent or a workspace still on it is not done whatever anyone clicked, and when herdr is
 * not answering nothing is recorded at all.
 */
export async function markDone(engine: TeamEngine, issueKey: string, { by = 'console' }: { by?: string } = {}): Promise<{ done: boolean; outcomes: CloseOutcome[]; error: string | null }> {
  const snap = await engine.snapshot();
  const task = snap.issues.find((i: any) => i.key === issueKey);
  if (!task) throw new Error(`no task ${issueKey} in this team`);
  if (!snap.freshness.herdrAt) return { done: false, outcomes: [], error: HERDR_AWAY };
  const outcomes = await closeTask(engine, task);
  const stuck = outcomes.filter((o) => o.outcome === 'is still running' || /^is still open/.test(o.workspace || ''));
  if (stuck.length) {
    const why = stuck.map((o) => o.outcome === 'is still running' ? `${o.role || o.run} (${o.agent}) still running` : `${o.role || o.run} workspace ${o.workspaceId} ${o.workspace}`);
    engine.emit('task.done_refused', null, { issueKey, why });
    return { done: false, outcomes, error: `${why.join(', ')}; not marked done` };
  }
  engine.commit(() => { if (isDurable(engine.store)) engine.store.acknowledge(issueKey, engine.clock().toISOString(), by); engine.emit('task.acknowledged', null, { issueKey, by, outcomes }); });
  engine.log(`${issueKey}: marked done by ${by}${outcomes.length ? ` (${outcomes.map((o) => `${o.agent} ${o.outcome}${o.workspace ? `, workspace ${o.workspaceId} ${o.workspace}` : ''}`).join('; ')})` : ''}`);
  engine.invalidateSnapshot();
  return { done: true, outcomes, error: null };
}

export function undoDone(engine: TeamEngine, issueKey: string): { done: false } {
  engine.commit(() => { if (isDurable(engine.store)) engine.store.unacknowledge(issueKey); engine.emit('task.unacknowledged', null, { issueKey }); });
  engine.log(`${issueKey}: no longer marked done`);
  engine.invalidateSnapshot();
  return { done: false };
}

/** Stop a task's agents (each asked to exit its own way). Explicit: stopping is not finishing, and nothing is acknowledged. */
export async function stopTask(engine: TeamEngine, issueKey: string): Promise<{ outcomes: Array<{ run: string; agent: string | null; outcome: string }> }> {
  const snap = await engine.snapshot();
  const task = snap.issues.find((i: any) => i.key === issueKey);
  if (!task) throw new Error(`no task ${issueKey} in this team`);
  if (!snap.freshness.herdrAt) throw new Error(HERDR_AWAY);
  const outcomes: Array<{ run: string; agent: string | null; outcome: string }> = [];
  for (const r of task.runs) {
    if (!r.agentAlive) continue;
    const outcome = await engine.herdr.stopAgent(r.agent, { exitCommand: exitCommandFor(r.agentKind) });
    outcomes.push({ run: r.key, agent: r.agent ?? null, outcome });
    engine.emit('run.stopped_by_person', r.key, { outcome });
  }
  engine.invalidateSnapshot();
  return { outcomes };
}

/** Exit one run's agent, its own way. */
export async function exitRun(engine: TeamEngine, runKey: string): Promise<{ outcome: string }> {
  const snap = await engine.snapshot();
  const r = snap.issues.flatMap((i: any) => i.runs).find((x: any) => x.key === runKey);
  if (!r) throw new Error(`no run ${runKey} in this team`);
  const outcome = await engine.herdr.stopAgent(r.agent, { exitCommand: exitCommandFor(r.agentKind) });
  engine.emit('run.exited_by_person', runKey, { outcome });
  engine.invalidateSnapshot();
  return { outcome };
}

/**
 * One-shot clean-up of the pile: every workspace still open for a run whose task a person has
 * already marked done and whose agent is gone. Runs with an agent still up are never touched.
 */
export async function tidy(engine: TeamEngine): Promise<Array<{ issue: string; run: string; role: string | null; workspaceId: string; workspace: string }>> {
  const snap = await engine.snapshot();
  if (!snap.freshness.herdrAt) throw new Error(HERDR_AWAY);
  const outcomes: Array<{ issue: string; run: string; role: string | null; workspaceId: string; workspace: string }> = [];
  for (const iss of snap.issues) {
    if (!iss.cleared || iss.bucket === 'inflight') continue;
    for (const r of iss.runs) {
      if (r.agentAlive || !r.workspaceId || !r.workspaceOpen) continue;
      outcomes.push({ issue: iss.key, run: r.key, role: r.role ?? null, workspaceId: r.workspaceId, workspace: await closeWorkspace(engine, r) });
    }
  }
  if (outcomes.length) engine.invalidateSnapshot();
  return outcomes;
}

/** The last `lines` of every agent that worked on the task, one block per role, for a read-only look. */
export async function tailTask(engine: TeamEngine, issueKey: string, lines = 100) {
  const snap = await engine.snapshot();
  const task = snap.issues.find((i: any) => i.key === issueKey);
  if (!task) throw new Error(`no task ${issueKey} in this team`);
  const out: any[] = [];
  for (const r of task.runs) {
    let text: string | null;
    if (!r.agentAlive) text = null;
    else { try { text = String(await engine.herdr.readAgent(r.agent, lines)).trim(); } catch (e: any) { text = `(no scrollback: ${e.message})`; } }
    out.push({ run: r.key, role: r.role, agent: r.agent, agentKind: r.agentKind, alive: r.agentAlive, phrase: r.phrase, text, source: r.agentAlive ? 'herdr' : 'none', observedAt: engine.clock().toISOString() });
  }
  return out;
}
