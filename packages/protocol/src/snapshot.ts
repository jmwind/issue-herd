// The canonical view of a factory, as its owner publishes it. Everything a console or a phone
// shows comes from here; nothing in a client re-derives lifecycle facts from raw records.
//
// Shapes are kept close to what the console has always rendered — a task with its role runs,
// alerts ranked, production windows — with the envelope that CLI authority needs on top: who
// published it, how fresh each observation is, and the event cursor it is consistent with.
import { s } from './schema.js';
import type { Infer } from './schema.js';

export const OWNER_STATUSES = ['online', 'offline', 'stale'] as const;

/** Who produced the snapshot and how current its observations are. */
export const ownerSchema = s.object({
  status: s.enum(OWNER_STATUSES),
  pid: s.maybe(s.number()),
  version: s.maybe(s.string()),
  hostname: s.maybe(s.string()),
  /** The owner's last heartbeat (online), or the registration's last poll (offline/stale). */
  heartbeatAt: s.maybe(s.string()),
  /** When this snapshot's facts were observed: now for an owner, the last known state for an offline one. */
  observedAt: s.string(),
});

export const freshnessSchema = s.object({
  herdrAt: s.maybe(s.string()),
  trackerAt: s.maybe(s.string()),
  trackerError: s.maybe(s.string()),
});

export const sizeSchema = s.object({ added: s.number(), removed: s.number(), files: s.number(), paths: s.array(s.string()), commits: s.array(s.object({ sha: s.string(), subject: s.string() })), complexity: s.maybe(s.object({ grade: s.string(), why: s.string() })) });

export const segmentSchema = s.object({ from: s.number(), to: s.number(), kind: s.enum(['working', 'blocked', 'question', 'done']) });

/** One role's run on a task: the display facts, never the persistence record. */
export const runViewSchema = s.object({
  key: s.string(),
  role: s.maybe(s.string()),
  rule: s.string(),
  pass: s.number(),
  status: s.string(),
  ownsPr: s.boolean(),
  agent: s.maybe(s.string()),
  agentKind: s.string(),
  agentStatus: s.maybe(s.string()),
  agentAlive: s.boolean(),
  workspaceId: s.maybe(s.string()),
  /** The label the run gave its workspace: what a close is checked against, since herdr reuses ids across restarts. */
  workspaceLabel: s.maybe(s.string()),
  workspaceOpen: s.maybe(s.boolean()),
  branch: s.maybe(s.string()),
  /** Display metadata only: a client never reads local files. */
  worktree: s.maybe(s.string()),
  startedAt: s.maybe(s.string()),
  finishedAt: s.maybe(s.string()),
  elapsedMs: s.number(),
  light: s.enum(['green', 'yellow', 'red', 'grey']),
  phrase: s.string(),
  needsYou: s.maybe(s.string()),
  settling: s.maybe(s.string()),
  result: s.maybe(s.object({ status: s.string(), prUrl: s.maybe(s.string()), summary: s.string(), notes: s.string(), live: s.boolean(), verdict: s.maybe(s.string()), verdictSource: s.maybe(s.string()), verdictHead: s.maybe(s.string()) })),
  prUrl: s.maybe(s.string()),
  error: s.maybe(s.string()),
  segments: s.array(segmentSchema),
  /** What the run's state says was waited for. With `evidence: 'partial'` (no recorded events) it is a floor: dialogs inside the run are unknown, not zero. */
  humanWaitMs: s.number(),
  evidence: s.enum(['events', 'partial']),
  size: s.maybe(sizeSchema),
  waitingSince: s.maybe(s.number()),
  mergeWait: s.maybe(s.object({ from: s.number(), to: s.maybe(s.number()) })),
  recipeRevision: s.maybe(s.number()),
  attemptId: s.maybe(s.string()),
});

export const taskViewSchema = s.object({
  key: s.string(),
  taskId: s.maybe(s.string()),
  title: s.string(),
  url: s.maybe(s.string()),
  bucket: s.enum(['inflight', 'done', 'merged']),
  light: s.string(),
  phrase: s.string(),
  prUrl: s.maybe(s.string()),
  merged: s.boolean(),
  prState: s.string(),
  issueState: s.maybe(s.string()),
  cleared: s.boolean(),
  slots: s.array(s.object({ role: s.string(), light: s.string(), phrase: s.string() })),
  startedAt: s.string(),
  elapsedMs: s.number(),
  humanWaitMs: s.number(),
  evidence: s.maybe(s.enum(['events', 'partial'])),
  size: s.maybe(sizeSchema),
  runs: s.array(runViewSchema),
  finishedAt: s.maybe(s.string()),
  /** What a person should do, if anything, decided by the engine. */
  attention: s.maybe(s.string()),
});

export const alertSchema = s.object({
  kind: s.string(), issueKey: s.string(), title: s.string(), runKey: s.string(), role: s.maybe(s.string()), agent: s.maybe(s.string()), agentKind: s.maybe(s.string()),
  workspaceId: s.maybe(s.string()), prUrl: s.maybe(s.string()), url: s.maybe(s.string()), text: s.string(), sinceMs: s.number(), light: s.string(), verdicts: s.maybe(s.string()),
});

export const productionSchema = s.object({ finished: s.number(), merged: s.number(), workingMs: s.number(), humanMs: s.number() });

export const factorySnapshotSchema = s.object({
  protocolVersion: s.literal(1),
  factoryId: s.string(),
  id: s.string(),
  name: s.string(),
  repo: s.string(),
  tracker: s.string(),
  generatedAt: s.string(),
  /** The event sequence this snapshot is consistent with; resume events after it. */
  revision: s.number(),
  owner: ownerSchema,
  freshness: freshnessSchema,
  recipeRevision: s.maybe(s.number()),
  roles: s.array(s.string()),
  rules: s.array(s.object({ name: s.string(), role: s.maybe(s.string()), match: s.string(), agent: s.string(), model: s.maybe(s.string()), effort: s.maybe(s.string()), basedOn: s.maybe(s.string()), passes: s.number(), maxConcurrent: s.maybe(s.number()) })),
  maxConcurrent: s.maybe(s.number()),
  pollSeconds: s.maybe(s.number()),
  watcher: s.object({ version: s.maybe(s.string()), lastPoll: s.maybe(s.string()), stale: s.boolean(), workspaceId: s.maybe(s.string()), pid: s.maybe(s.number()) }),
  counts: s.object({ running: s.number(), working: s.number(), alerts: s.number(), inflight: s.number(), merged: s.number(), done: s.number() }),
  humanWaitMs: s.number(),
  production: s.object({ today: productionSchema, week: productionSchema, month: productionSchema }),
  alerts: s.array(alertSchema),
  issues: s.array(taskViewSchema),
  live: s.maybe(s.object({ tracker: s.boolean(), github: s.boolean(), why: s.maybe(s.string()) })),
  capabilities: s.maybe(s.array(s.string())),
});
export type FactorySnapshot = Infer<typeof factorySnapshotSchema>;
export type TaskView = Infer<typeof taskViewSchema>;
export type RunView = Infer<typeof runViewSchema>;
export type Alert = Infer<typeof alertSchema>;
export type OwnerInfo = Infer<typeof ownerSchema>;

/** What `weawr serve` publishes: every factory on this host, plus the host itself. */
export const hostSnapshotSchema = s.object({
  protocolVersion: s.literal(1),
  hostname: s.string(),
  version: s.maybe(s.string()),
  herdr: s.object({ connected: s.boolean(), version: s.maybe(s.string()) }),
  generatedAt: s.string(),
  factories: s.array(factorySnapshotSchema),
});
export type HostSnapshot = Infer<typeof hostSnapshotSchema>;
