# Weawr implementation plan: authoritative CLI and Turborepo clients

Status: implementation handoff; no implementation changes made by this plan.

Baseline reviewed: commit `e344c25`, package version `0.2.8`. The existing 246 tests passed during the architecture review, with local HTTP listeners permitted. Recheck the baseline before implementation because the repository may have advanced.

## 1. Objective and fixed decisions

Make Weawr easier to evolve across CLI, web, and mobile while preserving its existing factory workflows, repository configuration, and human-readable collaboration through issues and PRs.

The owner has explicitly selected these architectural decisions:

- **The CLI is the authoritative interface for every UI.** Web and mobile obtain factory information and request actions exclusively through Weawr's versioned CLI interface.
- **Move to Turborepo**, using `apps/` for executable clients and `packages/` for shared modules. This is required work, not an optional future optimization.
- Keep Node and adopt strict TypeScript incrementally. Distribute compiled JavaScript.
- Preserve the simple installation experience: one installed `weawr` command includes the local web console.

“CLI authority” includes a long-running process launched by the CLI. A browser or phone cannot execute a local binary directly, so `weawr serve` exposes the CLI's application interface over HTTP and server-sent events (SSE). It is shipped and operated as part of the CLI. It has no independent product policy or lifecycle implementation.

GitHub/Linear remain authoritative for their own issue and PR facts; herdr remains authoritative for observed agent state. The CLI reconciles those facts into Weawr's canonical state. UIs never independently query those systems to construct a competing answer.

Use the supplied codebase-design vocabulary: modules hide implementation behind small interfaces at explicit seams. Keep adapter differences local. Avoid packages that merely forward calls, a generic plugin framework, or an interface for every file.

## 2. Scope

Deliver the Turborepo structure, extracted engine, durable lifecycle bookkeeping, versioned CLI interface, prompt compatibility, and migration of the existing web console to that interface.

Prepare the shared client interface for mobile. Building a native mobile application, push delivery, cloud hosting, and coordination of simultaneous owners on different machines are follow-up work. Reserve `apps/mobile/` in the documented layout; create an executable mobile package when that work starts.

Preserve current role workflows, claim labels, branch/worktree safeguards, nudges, merge observation, authentication flows, and console features. Changes to observable semantics must be documented and tested rather than introduced incidentally by moving files.

## 3. Target repository and dependency direction

Use pnpm workspaces with a pinned `packageManager` version and committed lockfile. Pin a compatible Turborepo version during implementation; do not rely on floating development tools.

```text
apps/
  cli/                      # published executable and all process/transport entry points
    src/commands/           # human commands, JSON commands, console, serve
    src/transports/         # local IPC, HTTP/SSE, authentication, serialization
    src/main.ts             # dependency assembly and process startup only
  web/                      # existing console, browser build, rendering and interaction
  mobile/                   # future client; documented until implementation begins

packages/
  engine/                   # factory lifecycle, commands, observations and canonical projections
    src/adapters/           # existing tracker, herdr, Git and persistence implementations
  recipes/                  # versioned prompts, resolution and immutable rendered briefs
  protocol/                 # serializable contracts, runtime validation and compatibility
  client/                   # browser/mobile transport, reconnect and operation tracking

docs/
  architecture.md           # ownership, interfaces, process model, compatibility policy
  proposals/

pnpm-workspace.yaml
turbo.json
package.json                # private workspace/tooling root
```

Allowed source dependencies:

| Module | May depend on |
| --- | --- |
| `protocol` | Portable validation dependencies; no Node-only imports |
| `recipes` | `protocol`; filesystem access stays on the CLI side |
| `engine` | `recipes`, `protocol`, its private adapters |
| `client` | `protocol`, portable HTTP/stream transport |
| `apps/cli` | `engine`, `recipes`, `protocol` |
| `apps/web`, future `apps/mobile` | `client`, `protocol` |

Applications do not import another application's source. The release assembly copies the web build into the CLI artifact as assets. A build dependency on those assets does not permit CLI imports from web source.

Enforce these rules with package exports and an automated import-graph check that includes relative paths. In particular, web/mobile cannot import the engine, recipes, filesystem, child processes, tracker adapters, herdr, or credential loaders. Do not export persistence records as transport types.

Keep the existing browser UI during extraction. A UI framework rewrite is not a prerequisite for this architecture.

## 4. Runtime ownership and process model

Retain one watcher process per repository initially. Each is a CLI process hosting one factory engine and exposing a private local command/query endpoint. This preserves the current herdr watcher-pane workflow and limits the failure scope of a factory.

`weawr serve` is the CLI's transport host for all registered local factories. It forwards commands and aggregates canonical snapshots returned by the factory owners. It does not parse human logs, infer lifecycle policy, or perform tracker/herdr enrichment independently. `weawr console` starts or attaches to this host and makes the bundled web client available. `serve` also supports interface-only operation without opening a browser.

```text
Web console / future mobile client
                 |
       @weawr/client + protocol
                 |
       CLI-owned weawr serve
                 |
       private local dispatch
                 |
       authoritative factory owner
                 |
          engine implementation
       /          |             \
  durable store  Git/trackers   herdr
```

Machine-readable terminal commands and HTTP handlers dispatch the same application commands and return the same result envelopes. They must not implement parallel lifecycle logic. Human-readable terminal text is a presentation of those results.

Ownership requirements:

- Acquire exclusive local factory ownership before scheduling, accepting mutations, or reconciling external observations. A second watcher reports the existing owner rather than writing concurrently.
- Use an OS-backed lock or another crash-safe exclusive ownership mechanism. A PID file alone is insufficient because PIDs can be reused. Validate owner identity when recovering stale registrations.
- A transport host restart must not stop factories. A watcher restart must recover unfinished operations before accepting conflicting new work.
- When a factory owner is offline, the CLI may load its last canonical snapshot through the engine's read-only interface. Return `offline` and observation timestamps. Reject operational mutations until an owner is available; never silently start agents because a UI requested a snapshot.
- Replace the shared read-modify-write registry with independently written per-factory registration records, atomically replaced. Registry metadata discovers owners; it does not substitute for the ownership lock.
- Keep local IPC private to the user. Authenticate remote UI access through the CLI transport. Retain local/Tailscale operation during migration; public internet exposure is outside this milestone.
- Separate watcher liveness from successful tracker polling. A slow upstream must not make a healthy owner indistinguishable from a dead process.

Introduce stable identities: installation/host ID, factory ID, task ID, role-run ID, and attempt ID. Include tracker repository/project identity in task identity. Scope caches and agent names to the factory; use a short stable hash where herdr's name-length limit requires it. Keep `GH-7` and role names as display labels.

Do not rename live herdr agents during migration. Record their existing names and use the new naming scheme for newly created sessions.

## 5. Versioned CLI interface

The following is the proposed v1 command surface. Validate spelling against existing commands before implementation, but preserve these semantics. New commands listed here do not exist yet.

| CLI operation | Meaning |
| --- | --- |
| `weawr factories list --json` | Registered factories, reachability and capabilities |
| `weawr status --factory <id> --json` | Canonical factory snapshot |
| `weawr task show <task-id> --factory <id> --json` | Task, attempts, reports and current review facts |
| `weawr events --factory <id> --after <cursor> --jsonl` | Structured events with resumable cursors |
| `weawr task tail <task-id> --factory <id> --json` | CLI-mediated agent output, with source/freshness metadata |
| `weawr task done <task-id> --factory <id> --request-id <id> --json` | Existing Mark done behavior, tracked as an operation |
| `weawr task stop <task-id> --factory <id> --request-id <id> --json` | Explicit stop; does not imply successful completion |
| `weawr operation show <operation-id> --json` | Accepted, running, completed, failed or partially completed action |
| `weawr serve` | CLI-owned HTTP/SSE transport and optional bundled web assets |

Retain existing human commands, including `weawr`, `once`, `dry-run`, `match`, `status`, `reset`, `login`, `logout`, `init`, `console`, `smoke`, and `update`. Route existing lifecycle mutations such as `reset` through the owner. Preserve existing console undo, tidy, per-agent exit, and tail behavior in explicit command handlers as well.

Contract requirements:

- Include `protocolVersion`, stable IDs, snapshot revision, generated time, owner status, and observation freshness. Package version is separate from protocol version.
- JSON stdout contains only the result envelope. Diagnostics go to stderr. Streaming output is JSON Lines; document errors and exit codes.
- Use portable runtime schemas for commands, results, snapshots, and events. Reject invalid input before accepting an operation. TypeScript types alone do not validate external data.
- HTTP exposes `/api/v1/...` routes mapped to the same handlers. Retain old console routes temporarily as compatibility adapters while the current UI is migrated; publish their removal policy.
- Every mutation carries a request ID and, where needed, an expected snapshot revision. Repeating a request returns the original operation; reusing an ID for different input is rejected. Scope deduplication to factory and authenticated caller.
- Long actions return an accepted operation ID. Do not hold a phone request open while several agents shut down. Report partial failure explicitly and expose retry behavior.
- Publish capabilities and supported protocol versions. Keep additive changes within v1; reject unsupported major versions with an actionable error.
- SSE events have durable per-factory sequence cursors. Obtain a snapshot and cursor consistently; resume events after that cursor. On expired cursors, tell the client to refresh the snapshot. Multi-factory clients maintain a cursor per factory.
- Clients may reconnect and cache snapshots, but must display stale/offline state. They cannot infer success from a lost connection or from an optimistic UI update.
- Authentication and authorization belong to the CLI transport. Preserve browser origin checks, and define an authenticated device mechanism before enabling native-client actions. Do not use an Origin header as native-client authentication.
- Snapshot and tail responses exclude credentials. Worktree paths are display metadata where needed, never instructions for clients to read local files.

The engine supplies canonical lifecycle facts, review verdicts, attention reasons, and operation outcomes. The UI owns layout, colors, local filtering, and formatting. Domain rules such as “this task needs human input” must not be reimplemented in `client` or web code.

## 6. Durable lifecycle and observations

Introduce SQLite persistence behind an internal engine module. Select and pin a driver compatible with the declared Node support floor; verify that choice using an installed CLI artifact. Native `node:sqlite` availability must not be assumed for every version covered by the current `node >=22` declaration.

Persist factory identity, immutable attempt specifications, lifecycle facts, validated results, structured events, command operations, pending external actions, and acknowledgement/cleanup outcomes. Keep large briefs and transcripts as artifacts referenced by stable IDs and hashes. Do not store secrets in events or attempt specifications.

Commit a state transition, its event, and pending external work in one database transaction. Perform external work after commit and record its observed outcome. Recovery resumes pending work instead of assuming that a terminal run status means every side effect finished.

Handle uncertain external outcomes explicitly:

- Use stable markers and reconciliation where possible to avoid duplicate pickup/result comments.
- Deduplicate internal nudge delivery by durable message/attempt identity; save the full accepted message before sending it.
- After an uncertain herdr prompt response, do not blindly resend an action with irreversible implications. Reconcile what can be observed and surface uncertainty if delivery cannot be established. Exactly-once delivery across an external CLI is not promised.
- Separate execution completion, PR state, review state, human acknowledgement, and resource cleanup. A finished attempt may still have a pending PR or cleanup operation.
- Preserve current Mark done behavior through a composed command that performs the requested shutdown and only acknowledges completion after required steps succeed. Keep stop, acknowledgement, and cleanup as distinct internal facts.
- Serialize conflicting commands per task. Nudged turns use the same admission and concurrency accounting as ordinary pickups, including starting/reserved attempts.

Move canonical projections and external enrichment out of `src/console/console.mjs` into the engine. Retain pure display calculations where appropriate, but derive history and metrics from structured events. Human log wording is no longer a data protocol. Historical records with incomplete evidence remain explicitly unknown rather than fabricated as zero wait time.

Use asynchronous Git/process execution with deadlines, cancellation, and bounded output. Add upstream request deadlines and bounded retry/backoff. Shutdown should stop scheduling, checkpoint pending work, and release ownership; it must not automatically kill agent sessions the owner expects to inspect.

Tracker labels and comments remain human-visible claim records. Document their actual guarantee: a fresh read followed by adding a label is not an atomic cross-machine claim. This milestone enforces local exclusivity and supports one designated owner machine per factory. A coordinated cross-machine lease requires separate design work.

## 7. Prompt and policy compatibility

Treat the effective factory setup as a versioned recipe: role instructions, shared result/nudge protocol, and execution policy.

Every attempt stores an immutable resolved specification containing:

- Recipe ID/revision, prompt content hashes, and the exact rendered brief.
- Resolved rule and lifecycle policy, result-schema version, and effective role/reviewer configuration.
- Agent kind, model, non-secret arguments, Weawr version, and detected agent CLI version.
- Repository revision, base/head facts relevant to the task, and instruction-file hashes.

Archive every attempt from the first attempt onward. Preserve prior metadata instead of overwriting the only run entry. Record new facts as events or revisions without mutating the historical specification.

Compatibility rules:

| Change | Required behavior |
| --- | --- |
| Update installed Weawr | Existing attempts retain their specification; supported old decoders remain available |
| Ship a newer bundled recipe | Existing factories retain their selected recipe revision |
| Upgrade a factory recipe | Explicit command produces a reviewable diff; upgrade affects new work |
| Nudge within an existing task | Retain the task's pinned recipe by default; fresh issue observations are still included |
| Change scheduling limits | Apply live under a documented allowlist |
| Disable a role | Prevent new scheduling; make treatment of existing work explicit, never silently replace its policy |
| Change cleanup/model/merge policy | Apply to new attempts; an explicit reconfiguration command is required for active work |
| Remove an active run's rule | Continue from its saved specification; no fallback to current defaults |
| Encounter unknown future schema | Refuse unsafe consumption; preserve the original data and explain the required upgrade |

Preserve precedence of repository instructions, but distinguish recipe/policy compatibility from fresh task context. Model behavior and external agent instructions cannot be perfectly frozen; the stored evidence makes changes inspectable.

Custom templates declare compatible protocol versions and required placeholders. Missing required fields or unsupported variables are reported during configuration validation. Keep a legacy decoder/resolver for supported existing templates rather than silently injecting arbitrary new obligations into them.

Validate result status, fields, task/attempt identity, and nudge payloads. A structurally invalid JSON result must not finalize an attempt. Document atomic publication of result files or provide a CLI result-submission command with an acknowledgement.

Add structured review verdicts: `approved`, `changes_requested`, or `unable_to_review`, associated with the PR and reviewed head SHA. Keep these distinct from whether the agent's turn completed. Legacy prose verdicts remain legacy/unknown unless a documented conversion is unambiguous. A new PR head invalidates approval for the previous head.

Any promised automatic-merge guarantee must run through a deterministic merge command that checks current authorization, required verdicts, and current PR head, with repository protections as enforcement where available. Update the recipe to request that command. An agent holding unrestricted merge credentials can bypass prompts; do not claim that prompt wording alone enforces this guarantee. Defer unattended merge for migrated tasks whose authorization/review evidence cannot be established.

## 8. Turborepo build and distribution

Create real workspace packages with explicit exports and dependency declarations. Start with existing JavaScript implementations where necessary; convert extracted contracts and touched modules to TypeScript with strict checking. Keep migration commits reviewable.

Configure root tasks for `build`, `typecheck`, `test`, `lint`, and `dev`:

- Build tasks declare upstream build dependencies and actual artifact outputs.
- Type checking and tests run with their required upstream artifacts available.
- Development processes are persistent and uncached.
- Pure tests/builds may be cached. Tests against running tools, local ports, mutable repositories, or external systems run uncached with isolated fixtures. Release verification includes an uncached test run.
- Include prompts, schemas, and other runtime assets in dependency/cache inputs. Changing a recipe must invalidate the CLI distribution that includes it.
- Credentials, run state, local configuration, live factory artifacts, and production logs never enter build outputs or caches.

Publish one assembled CLI package named `weawr`; keep the workspace root private. Bundle internal executable modules or include their compiled implementation so installation has no unresolved `workspace:` dependencies. Include versioned recipes and the web build. Do not require end users to install pnpm or Turborepo.

Preserve `npm install -g github:jmwind/weawr` using a tested root install/prepare compatibility path that produces the same CLI artifact. If the maintainer chooses to retire that path, document the replacement and obtain that distribution decision before release; an `apps/cli` move alone must not break the documented install command.

Update `weawr update` to select an immutable release/tag or release artifact, with a documented rollback target. It must not silently mix currently executing code with newly overwritten prompt files. Keep versioned recipes available for active runs and define the required owner restart/upgrade sequence.

A release is acceptable only after installing the produced artifact into a clean temporary prefix and exercising it from a separate temporary repository. Workspace execution alone is insufficient evidence.

## 9. Migration of existing installations

Keep committed `.weawr/config.json`, `.weawr/config.local.json`, and repository instruction files compatible initially. Introduce explicit configuration/state schema versions with a supported legacy reader.

Provide a migration command with inspect/dry-run and apply modes:

1. Inventory state, runs/artifacts, console notes, registry entries, custom templates, and existing sessions. Report missing files and ambiguous identities.
2. Back up legacy data before conversion. Never treat a corrupt state file as an empty factory.
3. Stop old watcher and console processes during the handover. Existing agents/worktrees remain in place; preserve their stored paths and names.
4. Import legacy state and console acknowledgements transactionally. Preserve results and artifact references. Mark unavailable historical prompt/policy provenance as unknown.
5. Resolve a one-time policy for live legacy runs from the available brief/config evidence, display any ambiguity, and require explicit selection where safe continuation cannot be inferred. Do not pretend the original resolved specification can be reconstructed exactly.
6. Start the new owner, reconcile sessions/results/PRs, and verify recovery before new pickups are enabled.
7. Retain the backup and a documented rollback procedure. Do not dual-write legacy JSON and SQLite. Once new work has started, an old binary cannot simply resume from the pre-migration snapshot; rollback then requires reconciliation or draining the new work first.

The folder restructure itself must not move user worktrees or rename repository-local state paths. Host relocation and cross-machine factory ownership are separate operations. Keep the existing rename migration documentation, updating links when source files move.

## 10. Implementation stages and acceptance criteria

Implement in order; each stage should land in reviewable changes. Temporary compatibility adapters are allowed when named, tested, and removed by the specified later stage.

### Stage 1 — Establish the workspace and preserve installation

Create pnpm/Turborepo configuration, move executable/browser entry points into `apps/`, and establish package exports. Maintain behavior with temporary imports while extracting modules in Stage 2. Add architecture/import rules and clean-artifact installation verification immediately.

Acceptance:

- The existing 246-test baseline remains green, allowing equivalent relocated tests.
- Root build/test/typecheck tasks operate through Turborepo.
- The assembled CLI installs outside the workspace and serves its bundled web assets.
- No published artifact references source directories or unresolved workspace dependencies.

### Stage 2 — Extract the engine and define ownership

Move config resolution, lifecycle decisions, tracker/herdr/Git access, and canonical observations into the engine. Inject repository paths, clock, and dependencies; remove import-time `process.cwd()` coupling. Introduce stable identities, owner locking, per-factory registration, and private dispatch. Fix cross-factory agent/cache collisions.

Acceptance:

- Two engines for different temporary repositories can coexist in one test process without changing cwd.
- Two repositories with `GH-7@impl` have distinct new agent names, caches, and task identities.
- A second owner cannot mutate the same local factory.
- Existing agents retain their recorded identities during adoption.
- CLI commands dispatch through one application interface; transport failures are distinguishable from agent absence.

### Stage 3 — Make lifecycle work recoverable

Add SQLite state, structured events, operation tracking, immutable attempt records, pending external actions, and the legacy migration command. Move reset, nudges, shutdown, acknowledgement, and cleanup under owner control. Add deadlines and bounded retries.

Acceptance:

- Crash injection before/after finalization, result reporting, nudge delivery, and transition to merge watching leaves recoverable pending work.
- Duplicate requests cannot create two turns or repeat a completed cleanup decision.
- Two reviewers nudging one implementer produce durable, ordered work within configured concurrency limits.
- Corrupt/unsupported state is reported and preserved, never silently reset.
- Console acknowledgement history imports correctly; migration is repeatable or explicitly refuses an already migrated store.

### Stage 4 — Pin recipes and validate execution results

Add versioned recipe selection, resolved attempt specifications, strict result schemas, structured review facts, upgrade previews, and compatibility fixtures. Retain supported legacy configuration/results. Define the deterministic merge path before advertising an enforced automatic-merge policy.

Acceptance:

- An active run survives a package upgrade with its original recipe and policy.
- Removing or editing its rule does not silently alter cleanup, agent kind, or merge policy.
- A task's nudged turn retains its pinned recipe while receiving current issue context.
- Every attempt's original brief and metadata remain inspectable.
- Malformed results do not finalize work; unsupported custom templates produce actionable validation errors.
- A review approval for head A cannot authorize merging head B.

### Stage 5 — Publish the CLI interface and migrate the console

Implement JSON/JSONL commands, versioned HTTP/SSE, portable client contracts, and operation tracking. Move existing console enrichment/projections into the owner. Replace all web data access and actions with `client` calls. Preserve current features and remove the temporary console backend implementation.

Acceptance:

- CLI JSON and HTTP return equivalent canonical facts for the same revision.
- Web runs against a fixture CLI endpoint with no local repository, herdr, or tracker access.
- Import checks prevent clients from accessing engine/private adapters.
- Killing `weawr serve` does not stop agents or owners; restarting it restores monitoring.
- An offline owner produces a stale snapshot and rejects operational mutations clearly.
- Reconnecting during an operation does not duplicate the command and eventually shows its real outcome.
- SSE cursor replay/resnapshot behavior is tested, including multiple factories and expired cursors.
- Mark done, undo, tidy, tail, per-agent exit, alerts, factory switching, and production views retain their documented behavior.

### Stage 6 — Release and document the new architecture

Complete strict checking for the public contracts and extracted modules, remove temporary imports/adapters scheduled for removal, publish the compatibility matrix, and verify installation/update/migration outside the workspace. Document future mobile integration against the released interface.

Acceptance:

- Build, typecheck, lint, uncached tests, and clean installation checks pass in CI on the declared Node support floor and a supported newer runtime.
- A fixture legacy factory with live sessions can be migrated and resumed without duplicate pickup or lost results.
- An older supported client can read a newer compatible host; incompatible versions fail clearly.
- Maintainer docs cover releases, packaged assets, recipe upgrades, owner recovery, and rollback limits.
- The mobile handoff needs no new source of factory truth and no access to GitHub/herdr credentials.

## 11. Evidence and starting points

Paths below are relative to the repository at the reviewed baseline; locate the corresponding functions if they move.

| Current location | Relevant implementation concern |
| --- | --- |
| `bin/weawr.mjs`: globals, `loadConfig`, `Weawr` | Engine lives in CLI; repository paths captured at import |
| `bin/weawr.mjs`: `renderBrief`, `pickUp`, `resume`, `checkMerges` | Mutable template resolution and rule-name policy lookup |
| `bin/weawr.mjs`: `finalize`, `planNudges`, `deliverQueuedNudges` | Durable state does not preserve every unfinished external action |
| `bin/weawr.mjs`: `reset`, `readJson`, `writeJson` | Independent writers, non-atomic replacement, corruption fallback |
| `src/console/console.mjs` | Console reconstructs state, performs enrichment, and executes lifecycle actions |
| `src/console/model.mjs`: `parseLog`, `runState` | Human logs as protocol; prose/status-based review interpretation |
| `src/console/registry.mjs` | Concurrent read-modify-write of shared registry |
| `src/herdr.mjs`: `agentNameFor` | Agent identity lacks repository scope |
| `src/console/console.mjs`: `sizeFor` | Size cache keyed only by run key |
| `src/tracker.mjs`, `src/trackers/` | Existing real tracker seam and two adapters to preserve |
| `test/herd.test.mjs`, `test/pickup.test.mjs` | Existing recovery/nudge regression scenarios to retain and extend |
| `test/prompts.test.mjs` | Existing wording checks; add protocol and behavioral coverage |

Tooling references: [Turborepo repository structure](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository), [task configuration](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks), and [application package guidance](https://turborepo.dev/docs/core-concepts/package-types). Recheck supported tool versions at implementation time.

## 12. Definition of done

The project is a working Turborepo with separately built CLI and web applications. The installed CLI remains self-contained for users. Every UI reads canonical facts and requests actions through the CLI-owned, versioned interface. Factory ownership is exclusive locally; lifecycle transitions and pending work recover after restart; recipe upgrades cannot silently reinterpret active runs. Existing factories have a tested migration path, and another client can be implemented using the public protocol alone.
