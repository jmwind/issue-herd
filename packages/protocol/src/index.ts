// @weawr/protocol — the contracts every weawr client speaks. Portable: no Node-only imports.

/** The CLI interface version. Separate from the package version: additive changes stay within v1. */
export const PROTOCOL_VERSION = 1 as const;

export { s, validate, describeIssues } from './schema.js';
export type { Schema, Issue, Result, Infer } from './schema.js';
export { RESULT_SCHEMA_VERSION, RESULT_STATUSES, REVIEW_VERDICTS, ROLE_PATTERN, SHA_PATTERN, resultSchema, reviewSchema, validateResult, verdictOf } from './result.js';
export type { AgentResult, Review, ReviewVerdict, ResultStatus } from './result.js';
export { OWNER_STATUSES, alertSchema, teamSnapshotSchema, freshnessSchema, hostSnapshotSchema, ownerSchema, productionSchema, runViewSchema, segmentSchema, sizeSchema, taskViewSchema } from './snapshot.js';
export type { Alert, TeamSnapshot, HostSnapshot, OwnerInfo, RunView, TaskView } from './snapshot.js';
export { ERROR_CODES, OPERATION_STATUSES, capabilitiesSchema, commandSchemas, cursorSchema, errorSchema, eventSchema, operationSchema } from './envelope.js';
export type { Capabilities, ClientCommandName, Cursor, Envelope, ErrorCode, ErrorEnvelope, EventView, OkEnvelope, OperationView } from './envelope.js';
