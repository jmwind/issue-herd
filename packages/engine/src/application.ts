// The application interface: every command a UI or a terminal can ask of a factory, as data, with
// one dispatcher behind it. Human commands and machine transports both come through here, so there
// is one implementation of each lifecycle action and the terminal's text is a rendering of its
// result. Grows with the versioned CLI interface; this is the seam.
import type { FactoryEngine } from './factory.js';
import * as _claim from './claim.mjs';
const { issueKeyOf } = _claim as Record<string, any>;

export type Command =
  | { type: 'factory.status' }
  | { type: 'runs.list' }
  | { type: 'run.reset'; key: string }
  | { type: 'agent.tail'; runKey: string; lines?: number }
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
    async 'run.reset'({ key }) {
      // Naming the issue forgets every role's run on it (GH-7 clears GH-7, GH-7@impl, GH-7@review);
      // naming one run key forgets only that one. The nudges are the issue's, not one role's:
      // forgetting the issue hands the budget back too.
      const gone = resetTargets(engine.state.runs, key);
      for (const k of gone) delete engine.state.runs[k];
      if (engine.state.nudges?.[key]) delete engine.state.nudges[key];
      engine.saveState();
      if (gone.length) engine.log(`reset: forgot ${gone.join(', ')}`);
      return { forgot: gone };
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
