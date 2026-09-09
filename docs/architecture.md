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

## Where things are

| Concern | Module |
| --- | --- |
| Repository paths (never `process.cwd()` at import) | `packages/engine/src/paths.ts` |
| Config loading, path confinement, `.env` rules | `packages/engine/src/config.ts` |
| The brief | `packages/engine/src/brief.ts`, templates in `packages/recipes/prompts/` |
| The lifecycle (pickup, supervise, finalize, merges, nudges) | `packages/engine/src/factory.ts` |
| State (runs, nudges) | `packages/engine/src/state.ts` |
| Trackers, herdr, git, PRs, credentials | `packages/engine/src/adapters/` |
| Terminal commands | `apps/cli/src/commands/` |
| The console (moving into the versioned interface) | `apps/cli/src/console/`, `apps/web/src/` |
