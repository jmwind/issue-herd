// The application interface: every command a UI or a terminal can ask of a factory, as data, with
// one dispatcher behind it. Human commands and machine transports both come through here, so there
// is one implementation of each lifecycle action and the terminal's text is a rendering of its
// result. Grows with the versioned CLI interface; this is the seam.
import crypto from 'node:crypto';
import type { FactoryEngine } from './factory.js';
import { isDurable } from './store/index.js';
import type { OperationRecord } from './store/sqlite.js';
import * as _claim from './claim.mjs';
const { issueKeyOf } = _claim as Record<string, any>;

export type Command =
  | { type: 'factory.status' }
  | { type: 'runs.list' }
  | { type: 'run.reset'; key: string; requestId?: string }
  | { type: 'agent.tail'; runKey: string; lines?: number }
  | { type: 'operation.show'; id: string }
  | { type: 'run.merge'; key: string; requestId?: string; requestedBy?: string }
  | { type: 'run.submitResult'; key: string; result: unknown; requestId?: string }
  | { type: 'run.reconfigure'; key: string }
  | { type: 'recipe.show' }
  | { type: 'recipe.upgrade'; to?: number; dryRun?: boolean }
  | { type: 'attempt.list'; key: string }
  | { type: 'events.after'; cursor: number; limit?: number }
  | { type: 'ping' };

export type CommandResult<T = unknown> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export interface Application {
  dispatch(cmd: Command): Promise<CommandResult>;
}

export class ApplicationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** Which runs `weawr reset <KEY>` forgets: the issue's every role, or one run key. Pure. */
export function resetTargets(runs: Record<string, unknown>, key: string): string[] {
  return Object.keys(runs).filter((k) => k === key || issueKeyOf(k) === key);
}

/**
 * The application over a live engine — the owner's own view. Every mutation here happens under the
 * owner's lock because the engine only exists inside one.
 */
export function createApplication(engine: FactoryEngine): Application {
  const locks = new Map<string, Promise<unknown>>();
  /** Conflicting commands about one task run one at a time, in the order they arrived. */
  const serialized = async <T>(scope: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(scope) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(scope, next.catch(() => {}));
    try { return await next; } finally { if (locks.get(scope) === next.catch(() => {})) locks.delete(scope); }
  };
  /**
   * A tracked operation: accepted once per (scope, requestId), run, and recorded with its outcome.
   * Repeating a request returns the original operation's result; a request id reused for different
   * input is refused. Without a durable store the work simply runs.
   */
  const operation = async <T>(scope: string, requestId: string | undefined, kind: string, input: unknown, fn: () => Promise<T>): Promise<{ operation: OperationRecord | null; result: T | null; replayed: boolean }> => {
    if (!isDurable(engine.store) || !requestId) return { operation: null, result: await fn(), replayed: false };
    const store = engine.store;
    const { op, fresh } = store.beginOperation({ id: crypto.randomUUID(), scope, requestId, kind, input }, engine.clock());
    if (!fresh) return { operation: op, result: op.result as T, replayed: true };
    store.updateOperation(op.id, { status: 'running' }, engine.clock());
    try { const result = await fn(); store.updateOperation(op.id, { status: 'completed', result }, engine.clock()); return { operation: store.operation(op.id), result, replayed: false }; }
    catch (e: any) { store.updateOperation(op.id, { status: 'failed', error: e.message }, engine.clock()); throw e; }
  };
  const handlers: { [K in Command['type']]: (cmd: Extract<Command, { type: K }>) => Promise<unknown> } = {
    async ping() { return { pong: true, factoryId: engine.ids.factoryId, version: engine.version }; },
    async 'factory.status'() {
      const running: Record<string, string> = {};
      for (const [key, run] of Object.entries(engine.state.runs)) {
        if (run.status !== 'running') continue;
        const a = await engine.herdr.agentGet(run.agentName).catch(() => null);
        running[key] = a?.agent_status || 'gone';
      }
      return { factoryId: engine.ids.factoryId, name: engine.cfg.name, repo: engine.paths.repo, runs: engine.state.runs, nudges: engine.state.nudges, maxNudges: engine.cfg.maxNudges, agentStatus: running };
    },
    async 'runs.list'() { return { runs: engine.state.runs }; },
    async 'run.reset'({ key, requestId }) {
      // Naming the issue forgets every role's run on it (GH-7 clears GH-7, GH-7@impl, GH-7@review);
      // naming one run key forgets only that one. The nudges are the issue's, not one role's:
      // forgetting the issue hands the budget back too.
      // Request ids are scoped to the factory (and, over a transport, to the caller): one id names one action here.
      return serialized(issueKeyOf(key), () => operation(`factory:${engine.ids.factoryId}`, requestId, 'run.reset', { key }, async () => {
        const gone = resetTargets(engine.state.runs, key);
        engine.commit(() => {
          for (const k of gone) delete engine.state.runs[k];
          if (engine.state.nudges?.[key]) delete engine.state.nudges[key];
          engine.saveState();
          engine.emit('run.reset', null, { key, forgot: gone });
        });
        if (gone.length) engine.log(`reset: forgot ${gone.join(', ')}`);
        return { forgot: gone };
      })).then(({ result, operation: op, replayed }) => ({ ...(result as object), operationId: op?.id ?? null, replayed }));
    },
    async 'run.merge'({ key, requestId, requestedBy = 'cli' }) {
      return serialized(issueKeyOf(key), () => operation(`factory:${engine.ids.factoryId}`, requestId, 'run.merge', { key }, () => engine.mergeRun(key, { requestedBy })))
        .then(({ result, operation: op, replayed }) => ({ ...(result as object), operationId: op?.id ?? null, replayed }));
    },
    async 'run.submitResult'({ key, result, requestId }) {
      return serialized(issueKeyOf(key), () => operation(`factory:${engine.ids.factoryId}`, requestId, 'run.submitResult', { key, result }, async () => engine.submitResult(key, result)))
        .then(({ result: r, operation: op, replayed }) => ({ ...(r as object), operationId: op?.id ?? null, replayed }));
    },
    async 'run.reconfigure'({ key }) { return serialized(issueKeyOf(key), async () => engine.reconfigure(key)); },
    async 'recipe.show'() {
      const durable = isDurable(engine.store);
      return { id: 'weawr-default', revision: engine.recipeRevision, latest: engine.upgradeRecipe(undefined, { dryRun: true }).to, pinnedIn: durable ? 'store' : 'memory', rules: engine.cfg.rules.map((r: any) => ({ name: r.name, role: r.role, prompt: r.prompt, origin: r.templateOrigin || null, protocol: r.templateProtocol || null })) };
    },
    async 'recipe.upgrade'({ to, dryRun = false }) { return engine.upgradeRecipe(to, { dryRun }); },
    async 'attempt.list'({ key }) { return { attempts: isDurable(engine.store) ? engine.store.attempts(key) : [] }; },
    async 'operation.show'({ id }) {
      if (!isDurable(engine.store)) throw new ApplicationError('not_tracked', 'this factory has no durable store, so operations are not tracked');
      const op = engine.store.operation(id);
      if (!op) throw new ApplicationError('no_such_operation', `no operation ${id}`);
      return op;
    },
    async 'events.after'({ cursor, limit = 200 }) {
      if (!isDurable(engine.store)) return { events: [], cursor, expired: false };
      const first = engine.store.firstEventSeq();
      // A cursor from before the oldest kept event cannot be resumed from; the client must resnapshot.
      if (cursor > 0 && first > 0 && cursor < first - 1) return { events: [], cursor, expired: true };
      const events = engine.store.eventsAfter(cursor, limit);
      return { events, cursor: events.length ? events[events.length - 1].seq : cursor, expired: false };
    },
    async 'agent.tail'({ runKey, lines = 100 }) {
      const run = engine.state.runs[runKey];
      if (!run) throw new ApplicationError('no_such_run', `no run ${runKey}`);
      const agent = await engine.herdr.agentGet(run.agentName).catch((e: any) => { throw new ApplicationError('herdr_unavailable', e.message); });
      if (!agent) return { runKey, agent: run.agentName, alive: false, text: null };
      try { return { runKey, agent: run.agentName, alive: true, text: String(await engine.herdr.readAgent(run.agentName, lines)).trim() }; }
      catch (e: any) { return { runKey, agent: run.agentName, alive: true, text: null, error: e.message }; }
    },
  };
  return {
    async dispatch(cmd) {
      const h = handlers[cmd.type] as ((c: Command) => Promise<unknown>) | undefined;
      if (!h) return { ok: false, error: { code: 'unknown_command', message: `unknown command ${String((cmd as any)?.type)}` } };
      try { return { ok: true, result: await h(cmd) }; }
      catch (e: any) { return { ok: false, error: { code: e instanceof ApplicationError ? e.code : 'internal', message: e?.message || String(e) } }; }
    },
  };
}
