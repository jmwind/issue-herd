// Envelopes, events, operations and capabilities: the shapes every transport shares.
import { s } from './schema.js';
import type { Infer } from './schema.js';

export const ERROR_CODES = [
  'bad_request', 'unauthorized', 'forbidden', 'not_found', 'unsupported_protocol', 'owner_offline', 'herdr_unavailable', 'tracker_unavailable',
  'conflict', 'request_reused', 'no_such_run', 'no_such_task', 'no_such_operation', 'not_tracked', 'unknown_command', 'internal',
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

export const errorSchema = s.object({ code: s.string(), message: s.string(), retryable: s.maybe(s.boolean()), details: s.maybe(s.any()) });

export interface OkEnvelope<T> { protocolVersion: 1; ok: true; result: T; generatedAt: string }
export interface ErrorEnvelope { protocolVersion: 1; ok: false; error: { code: string; message: string; retryable?: boolean | null; details?: unknown } }
export type Envelope<T> = OkEnvelope<T> | ErrorEnvelope;

export const OPERATION_STATUSES = ['accepted', 'running', 'completed', 'failed', 'partial'] as const;
export const operationSchema = s.object({
  id: s.string(),
  kind: s.string(),
  status: s.enum(OPERATION_STATUSES),
  requestId: s.maybe(s.string()),
  teamId: s.maybe(s.string()),
  input: s.maybe(s.any()),
  result: s.maybe(s.any()),
  error: s.maybe(s.string()),
  createdAt: s.string(),
  updatedAt: s.string(),
  /** Whether a failed or partial operation may be re-issued safely, and how. */
  retry: s.maybe(s.object({ safe: s.boolean(), how: s.string() })),
});
export type OperationView = Infer<typeof operationSchema>;

export const eventSchema = s.object({
  teamId: s.string(),
  seq: s.number(),
  at: s.string(),
  kind: s.string(),
  runKey: s.maybe(s.string()),
  issueKey: s.maybe(s.string()),
  data: s.any(),
});
export type EventView = Infer<typeof eventSchema>;

/** A per-team resume point for the event stream. */
export const cursorSchema = s.object({ teamId: s.string(), seq: s.number({ integer: true, min: 0 }) });
export type Cursor = Infer<typeof cursorSchema>;

export const capabilitiesSchema = s.object({
  protocolVersions: s.array(s.number()),
  version: s.string(),
  commands: s.array(s.string()),
  /** Named features a client may probe for before offering a button. */
  features: s.record(s.boolean()),
  auth: s.object({ gated: s.boolean(), mechanisms: s.array(s.string()) }),
});
export type Capabilities = Infer<typeof capabilitiesSchema>;

// ---------------------------------------------------------------- commands a client may send

const requestId = s.string({ min: 1, max: 200 });
const key = s.string({ min: 1, max: 200 });

export const commandSchemas = {
  'task.done': s.object({ team: key, task: key, requestId, expectedRevision: s.maybe(s.number()) }, { extra: 'refuse' }),
  'task.undo': s.object({ team: key, task: key, requestId }, { extra: 'refuse' }),
  'task.stop': s.object({ team: key, task: key, requestId }, { extra: 'refuse' }),
  'task.tail': s.object({ team: key, task: key, lines: s.maybe(s.number({ integer: true, min: 1, max: 2000 })) }, { extra: 'refuse' }),
  'task.reset': s.object({ team: key, task: key, requestId }, { extra: 'refuse' }),
  'run.exit': s.object({ team: key, run: key, requestId }, { extra: 'refuse' }),
  'run.tail': s.object({ team: key, run: key, lines: s.maybe(s.number({ integer: true, min: 1, max: 2000 })) }, { extra: 'refuse' }),
  'team.tidy': s.object({ team: s.maybe(key), requestId }, { extra: 'refuse' }),
} as const;
export type ClientCommandName = keyof typeof commandSchemas;
