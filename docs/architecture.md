# Architecture

[← back to the README](../README.md)

weawr is a pnpm workspace built with Turborepo. One installed `weawr` command is the whole product:
the watcher, the terminal commands, the local console and, as the versioned interface lands, the
server that web and mobile clients talk to. Everything else here exists to keep that one artifact
honest about who owns what.

## Layout and dependency direction

```text
apps/
  cli/        the executable: commands, process/transport entry points, dependency assembly
  web/        the console page (rendering and interaction only), built as static assets
  mobile/     reserved; a future client written against @weawr/client alone
packages/
  engine/     the factory: lifecycle, commands, observations; adapters for trackers, herdr, git, persistence
  recipes/    versioned prompts and brief rendering (no filesystem access)
  protocol/   serializable contracts, runtime validation, compatibility — portable, no Node imports
  client/     browser/mobile transport for the CLI interface — portable
```

| Module | May depend on |
| --- | --- |
| `protocol` | nothing internal; no Node-only imports |
| `recipes` | `protocol` |
| `engine` | `recipes`, `protocol`, its private adapters |
| `client` | `protocol` |
| `apps/cli` | `engine`, `recipes`, `protocol` |
| `apps/web`, `apps/mobile` | `client`, `protocol` |

`scripts/check-imports.mjs` (`pnpm lint`) enforces the table, refuses relative imports that leave a
package, refuses Node built-ins in the portable packages, and refuses an assembled artifact that
mentions a source directory or a `workspace:` dependency. Applications never import another
application's source: the CLI build copies the web build in as assets.

## Build and distribution

`turbo run build` builds every package to its `dist/` (the CLI compiles to `build/` and then
`apps/cli/build.mjs` bundles it with esbuild into `apps/cli/dist/weawr.mjs`, copying the web build,
the prompt templates and `config.example.json` next to it). The root `package.json` is the
installable package: `bin` points at that file, `files` ships only `apps/cli/dist`, docs and the
licence, and `prepare` runs `scripts/build.mjs` — every package's own `build` script in dependency
order, with plain Node — so `npm install -g github:jmwind/weawr` works without pnpm or Turborepo
on the user's machine. `scripts/verify-install.mjs` packs, installs into a clean prefix and drives
the installed command from a fresh repository; `--git` does the same through `git+file://`.

Tests run against built output (`turbo run test` depends on `build`) and are uncached: they spawn
git, a fake `herdr`, and local sockets and ports. Builds and type checks are cached with the
prompts and brand assets counted as inputs, so a changed recipe invalidates the CLI artifact.

The Node floor is 22.13, where `node:sqlite` became available without a flag; the installed tool
still has no runtime dependencies.

## Process model and ownership

One watcher process per repository (`weawr` in a herdr pane) hosts one `FactoryEngine`. Before it
schedules, mutates or reconciles anything it takes **exclusive local ownership** of the factory:
an SQLite `BEGIN IMMEDIATE` held open on `<repo>/.weawr/state/owner.lock`. That is the operating
system's advisory lock, released the instant the process dies however it dies, so a crash never
leaves a stale lock and a reused PID is never mistaken for a live owner. `owner.json` next to it
is the owner's calling card (pid, host, version, socket) and is read only to report who holds the
lock. `packages/engine/src/ownership.ts`.

The owner answers commands on a **private local socket** (`owner.sock` in the state directory, or
under the user's temp directory when the path would be too long; mode 600). Every command — a
terminal `weawr status`, a `weawr reset`, later every HTTP route — is data dispatched through one
application interface (`packages/engine/src/application.ts`), so there is one implementation of
each action and the terminal's text is a rendering of its result. A command from another process
goes to the running owner when there is one; a read with no owner builds a read-only engine of its
own; a mutation with no owner takes the lock for the duration of the write. An owner that holds
the lock but does not answer is reported as exactly that (`owner_offline`), which is a different
thing from an agent being gone. `apps/cli/src/transports/ipc.ts`, `apps/cli/src/context.ts`.

Each owner **registers itself** in its own file, `~/.config/weawr/factories/<factoryId>.json`,
replaced atomically every poll — no shared read-modify-write registry. The record carries where the
factory is, where its owner answers, and, separately, when the tracker last answered
(`lastSuccessfulPoll`, `lastPollError`): a slow upstream is not a dead watcher. The legacy shared
`factories.json` is still read for the transition. `packages/engine/src/registration.ts`.

## Durable state

A factory's state is an SQLite database, `<repo>/.weawr/state/factory.sqlite` (`node:sqlite`, no
dependency; WAL mode so readers read while the owner writes). It holds what `state.json` held —
runs by key, the nudge log — and what a JSON file could never hold safely:

| Table | What |
| --- | --- |
| `runs`, `nudges` | the run records and the nudge log, as before |
| `events` | structured events with a durable sequence number — the cursor a client resumes from |
| `attempts` | one immutable record per turn: the exact brief and its hash, the template's hash, the rule's resolved policy, the agent and model, the weawr version, the repository head |
| `operations` | tracked commands, deduplicated by `(scope, request id)`: repeating a request returns the original, reusing an id for different input is refused |
| `pending_actions` | external work a committed transition owes: tracker comments, state changes, label removal, workspace closes, agent exits, worktree removal |
| `acknowledgements` | tasks a person marked done |

A transition is committed with its event and the work it owes in **one transaction**
(`FactoryEngine.commit`); the external work is performed after the commit and its outcome
recorded. An owner that dies in between leaves the work pending, and the next owner performs it on
resume (`drainPending`) — at most three tries, and a comment is reconciled against the issue before
it is repeated, so an uncertain send is not a duplicate. Agent exits go through herdr's own "is it
still there" check, so nothing is typed into a session that already left. Exactly-once across an
external CLI is not promised; what is promised is that nothing owed is forgotten and nothing
observable is blindly repeated. `packages/engine/src/store/sqlite.ts`, `factory.ts`.

Admission is the same for every turn: a nudged turn takes a slot like a pickup, counting running,
starting and reserved runs, and is held on the run (`queuedNudges`) until a poll finds room. A
signal stops scheduling after the current poll, checkpoints, releases the lock and returns —
agents are never killed by a stop; they are the owner's to inspect.

### Migration from state.json

The first owner to find a `state.json` and no store migrates it under its lock: backs the file (and
the console's notes) up to `state/backup-<time>/`, imports runs and nudges in one transaction with
one legacy attempt record per run (provenance `legacy`: the original resolved policy was never
recorded and is not invented), imports the console's acknowledgements, marks the store migrated,
and renames `state.json` to `state.json.migrated`. `weawr migrate --dry-run` shows the inventory
and what would happen; `weawr migrate` does it explicitly. A `state.json` that does not parse is
refused and left untouched — never read as an empty factory — and a reader shows that state too.
There is no dual write: after migration the JSON file is a backup. Rollback (move it back, remove
`factory.sqlite*`) is only sound before new work has started; afterwards the store is the truth.
`packages/engine/src/store/migrate.ts`.

## Recipes, results and the merge

The effective prompt setup of a factory is a **recipe revision**: a set of templates and the
result/nudge protocol they teach. Revisions are bundled side by side
(`packages/recipes/prompts/<revision>/`) and kept: a factory is pinned to one (`recipe_revision`
in its store — revision 1 for a migrated factory, the latest for a new one), and a task keeps the
revision it started under for every later turn, nudged or not, while still getting the issue as it
is now. `weawr recipe upgrade --dry-run` shows the difference per template; `weawr recipe upgrade`
moves *new* tasks to it. A repository's own template in `.weawr/prompts/` is the repository's and
is not touched by an upgrade. `packages/recipes/src/manifest.ts`, `FactoryEngine.upgradeRecipe`.

| Revision | Verdicts | Merge |
| --- | --- | --- |
| 1 | prose first line (`OK TO MERGE TO MAIN`, `USABILITY: OK`, …) | the implementer merges itself when the issue's text grants it |
| 2 | `review: { verdict, prUrl, headSha }` in the result, as well as the words | only `weawr merge <run key>`, when the issue carries the merge label |

Every template is checked at config load (`validateTemplate`): unknown placeholders, a missing
`{{resultPath}}`, or a declared protocol newer than this weawr are errors that name the file. A
custom template without a declaration is a legacy template: accepted as protocol 1, never handed
obligations it did not sign up for.

Every attempt records what it was given: recipe id and revision, template origin and hash, the
rendered brief's hash, the rule's resolved policy, agent/model/args, the weawr version, the
repository head (`weawr task attempts <run key>`). A run keeps that policy for its lifecycle
decisions (`FactoryEngine.ruleFor`): editing its rule's cleanup, agent or merge settings does not
reach a running attempt, and removing the rule leaves the run its saved policy rather than today's
defaults. Scheduling limits (`maxConcurrent`, `pollSeconds`, `lookbackDays`, `maxNudges`,
`enabled`, `roles`) apply live. `weawr task reconfigure <run key>` is the explicit move onto the
current policy, recorded as an event.

A **result file** is checked against `packages/protocol/src/result.ts` before it finishes anything:
a file that parses but does not check is reported to the owner once per distinct content and the
turn stays open; a half-written file is simply not there yet; a `schemaVersion` newer than this
weawr is refused, not guessed at. Agents write the file whole (temporary name, then rename), or hand
it in with `weawr result <run key> --file …`, which checks it and writes it the same way.

The **merge** (`weawr merge <run key>`, `FactoryEngine.mergeRun`) is the one route to an unattended
merge and checks, at the moment it is asked: the issue carries the configured `mergeLabel` now;
every reviewing role's latest result carries a *structured* `approved` verdict for the PR's
*current* head (a prose verdict names no head and authorises nothing; an approval of head A never
merges head B); the PR is open with no conflicts. Then it asks GitHub to merge *that* head
(`sha` in the request, so a push in between is refused by GitHub itself), with the repository's
branch protection enforced on top, and says on the issue what allowed it. Nothing in a brief
claims to enforce this; the command does.

## The CLI interface: `weawr serve`, the protocol and the client

Every UI reads canonical facts and asks for actions through the CLI. A browser or a phone cannot
run a local binary, so `weawr serve` (and `weawr console`, the same command by its older name) is
the CLI's transport host: HTTP and server-sent events over `/api/v1`, mapped onto the same
application commands the terminal uses, plus the bundled web console unless `--no-web`. It
forwards commands to each factory's owner over the private socket and gathers their snapshots; it
parses no logs, decides no lifecycle policy and enriches nothing. Killing it stops nothing —
owners keep running — and starting it again restores the view. `apps/cli/src/transports/http.ts`,
`hub.ts`, `commands/serve.ts`.

| Route | Answer |
| --- | --- |
| `GET /api/v1/capabilities` | protocol versions, commands, features, how to authenticate (ungated) |
| `GET /api/v1/snapshot` | the host snapshot: every factory, each the owner's snapshot or the store's last word marked `offline`/`stale` |
| `GET /api/v1/factories`, `…/:id/snapshot`, `…/:id/tasks/:key`, `…/tasks/:key/tail`, `…/runs/:key/tail`, `…/operations/:id`, `…/events?after=` | one factory's facts, always with `owner` and `freshness` |
| `GET /api/v1/events?cursors=<factoryId>:<seq>,…` | SSE: a `snapshot` whenever what is shown changed, `event`s per factory in order with `id: <factoryId>:<seq>`, `resnapshot` when a cursor is older than the events an owner keeps |
| `POST /api/v1/commands/<name>` | `task.done`, `task.undo`, `task.stop`, `task.reset`, `task.tail`, `run.exit`, `run.tail`, `factory.tidy` — bodies checked against `packages/protocol/src/envelope.ts`; every mutation carries a `requestId` |

Answers are envelopes (`{ protocolVersion, ok, result | error }`); errors carry a code
(`owner_offline`, `unauthorized`, `bad_request`, …) and whether a retry is sensible. A mutation
returns the tracked operation (accepted → running → completed/failed/partial) and its result; a
repeated request id returns the original operation, and an id reused for different input is
refused. Request ids are scoped to the factory and the caller. Every mutation against a factory
whose owner is away is refused with `owner_offline` — the UI shows the last recorded state and
says so; nothing is started because a phone asked for a snapshot. A client that asks for another
major protocol version (`x-weawr-protocol`) gets `unsupported_protocol` with the fix.

Authentication belongs to the transport. A browser is a session (the passcode cookie) and may
mutate only from the console's own origin; a native client is a **device**: `weawr console device
add <name>` mints a token once, stores only its salted hash, and the client sends it as
`Authorization: Bearer …` with no origin. Devices are listed and revoked by name. An Origin header
is never native-client authentication. Snapshots and tails carry no credentials; worktree paths are
display metadata.

`@weawr/client` (`packages/client`) is the portable transport for those clients: envelopes and
error codes, commands with request ids, operations polled to a terminal state, and a subscription
over fetch's byte stream (no `EventSource`, so it runs in a browser, in Node and in a native
shell) that keeps a cursor per factory, resumes after it on reconnect, refetches a factory when
told its cursor expired, and reports its link state — a lost connection is shown as staleness,
never read as success. The console page (`apps/web`) uses it as a classic script (`client.js`)
and holds no lifecycle rule of its own: attention, verdicts and phrases come from the snapshot.

The pre-v1 console routes (`/api/state`, `/api/events`, `/api/tail`, `/api/done`, `/api/undone`,
`/api/tidy`, `/api/exit`) are served as compatibility adapters over the same handlers and will be
removed in the next minor release.

## Identities

Records are keyed by stable ids; `GH-7` and role names stay what a person reads.

| Id | Made from |
| --- | --- |
| host | random, created once in `~/.config/weawr/host.json` |
| factory | host + repository path |
| task | factory + the tracker's own scope (`github:owner/repo`, `linear:TEAM`) + issue key |
| role run | task + role — what state has always called the run key |
| attempt | role run + pass |

herdr agent names are the run key plus the factory's short hash (`gh-7-impl-a1b2c3`), so two
repositories on one machine with `GH-7@impl` are two agents. A run that already has an agent keeps
its recorded name: live sessions are never renamed. `packages/engine/src/identity.ts`.

## A mobile client

A phone app needs nothing this document has not already described: `@weawr/client` (or any HTTP
client speaking the same envelopes), a device token from `weawr console device add`, and the
host's address on the tailnet. It reads `GET /api/v1/capabilities`, then the host snapshot, then
subscribes to `/api/v1/events` with a cursor per factory; it shows `owner.status`,
`freshness` and its own link state as staleness; it sends commands with request ids and follows
their operations. It never holds a GitHub or tracker credential, never reads a worktree, and
never decides what a task needs. `apps/mobile/` is reserved for it; `docs/mobile.md` is the
handoff.

## Where things are

| Concern | Module |
| --- | --- |
| Repository paths (never `process.cwd()` at import) | `packages/engine/src/paths.ts` |
| Config loading, path confinement, `.env` rules | `packages/engine/src/config.ts` |
| The brief | `packages/engine/src/brief.ts`, templates in `packages/recipes/prompts/` |
| The lifecycle (pickup, supervise, finalize, merges, nudges) | `packages/engine/src/factory.ts` |
| State: the store, migration, read-only views | `packages/engine/src/store/` (`state.ts` is the interface and the legacy JSON reader) |
| Trackers, herdr, git, PRs, credentials | `packages/engine/src/adapters/` |
| Terminal commands | `apps/cli/src/commands/` |
| The transport: `/api/v1`, SSE, the gate, the hub | `apps/cli/src/transports/` |
| The console page | `apps/web/src/` |
| The client library | `packages/client/src/` |
| Canonical projection, enrichment, task actions | `packages/engine/src/projection.ts`, `enrich.ts`, `actions.ts` |
