// @weawr/engine — the factory: lifecycle, commands and observations, with injected dependencies.
export { FactoryEngine, defaultGit, trackerBanner, watchLabel } from './factory.js';
export type { EngineOptions, EngineHooks, GitRunner, RegistrationTarget } from './factory.js';
export { DEFAULTS, EVENTS, configStamp, expandConfigPath, loadConfig, loadEnvFiles } from './config.js';
export type { ConfigSources, FactoryConfig, Rule } from './config.js';
export { briefVars, passLine, renderBrief } from './brief.js';
export { factoryPaths, findRepoRoot, shortHash, userDir } from './paths.js';
export type { FactoryPaths } from './paths.js';
export { agentNameFor, attemptId, factoryId, hostId, roleRunId, taskId, trackerScope } from './identity.js';
export type { Identities } from './identity.js';
export { JsonStateStore, readJson, writeJsonAtomic } from './state.js';
export type { FactoryState, StateStore, NudgeEntry } from './state.js';
export { acquireOwnership, currentOwner, describeHolder, processStartedAt, readCard } from './ownership.js';
export type { AcquireResult, OwnerCard, Ownership } from './ownership.js';
export { isStale, listRegistrations, readLegacyRegistry, registrationsDir, removeRegistration, writeRegistration } from './registration.js';
export type { Registration } from './registration.js';
export { ApplicationError, createApplication, resetTargets } from './application.js';
export type { Application, Command, CommandResult } from './application.js';
