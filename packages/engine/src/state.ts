// The watcher's memory: `runs` by run key, `nudges` by issue key. Behind an interface so the
// JSON file it has always been can be replaced by a durable store without the engine noticing.
import fs from 'node:fs';
import path from 'node:path';

export interface NudgeEntry { from: string | null; to: string; at: string; outcome: string; message: string }
export interface FactoryState {
  runs: Record<string, any>;
  nudges: Record<string, NudgeEntry[]>;
}

export interface StateStore {
  load(): FactoryState;
  save(state: FactoryState): void;
}

export function readJson<T>(p: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

/** Written whole, to a sibling first and then renamed over the old file, so a reader never sees half of it. */
export function writeJsonAtomic(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

export class JsonStateStore implements StateStore {
  constructor(private readonly file: string) {}
  load(): FactoryState {
    const s = readJson<Partial<FactoryState>>(this.file, { runs: {} });
    return { runs: s.runs ?? {}, nudges: s.nudges ?? {} };
  }
  save(state: FactoryState): void { writeJsonAtomic(this.file, state); }
}
