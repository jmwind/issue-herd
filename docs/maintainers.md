# Maintainers

[← back to the README](../README.md)

## Release a change

Edit, commit as usual, then:

```bash
npm run release
```

**Rename the GitHub repository to `weawr` before the first release under this name.** The
update check and `weawr update` both point at `jmwind/weawr`; until that repository
exists they get a 404, which `newerVersion` cannot tell from "no newer version", so every install
would silently believe it is up to date forever.
The rename itself — every path, variable and file that changed name, and the order to move an
install over — is in [Migrating from issue-herd](migrating.md).

That lints, type-checks, builds, runs the tests uncached, installs the packed artifact into a clean
prefix and exercises it from a fresh repository (`scripts/verify-install.mjs`), then bumps the patch
version in `package.json`, commits it, tags `vX.Y.Z`, and pushes commits and tags. Everyone picks it
up with `weawr update`. Use `npm run release:minor` for a feature.

Requires Node 22.13+, the `herdr` CLI with its server running, `claude` on PATH and logged in, and
`gh` logged in for PRs (with GitHub Issues as the tracker, that login is also the token). The
installed tool still has no runtime dependencies; the workspace has development ones (TypeScript,
esbuild, Turborepo), pinned.


What a release must prove, and what CI (`.github/workflows/ci.yml`) proves on the Node floor
(22.13) and on a newer runtime: `pnpm lint` (the import direction), `typecheck`, `build`, `turbo
run test --force` (uncached — the tests spawn git, a fake herdr, sockets and ports), and both
install paths of `scripts/verify-install.mjs` (the packed tarball, and `git+file://` which is the
`npm install -g github:…` flow with `prepare` under npm).

### Recipe revisions

The briefs are versioned. `packages/recipes/prompts/<n>/` is revision *n*, and a revision is never
edited once it has shipped: a factory pinned to it keeps getting exactly those words. To change a
brief, copy the latest revision to `prompts/<n+1>/`, edit there, add the revision to
`packages/recipes/src/manifest.ts` with its `changes` (they are what `weawr recipe upgrade` shows),
extend `KNOWN_PLACEHOLDERS` if the engine now fills something new, and pin the wording that is
policy in `packages/recipes/test/prompts.test.mjs` for both the old and the new revision. New
factories take the latest; existing ones move only on `weawr recipe upgrade`.

### Compatibility

| Change | What holds |
| --- | --- |
| Newer weawr, older factory | its store is opened as is (schema version checked; a newer schema is refused, never rewritten); its recipe revision is kept; every attempt keeps its recorded brief and policy |
| Newer weawr, older `state.json` | migrated once under the owner's lock, with a backup; a corrupt file is refused |
| Older client, newer host | protocol v1 is additive: a v1 client reads a v1 host; a client asking for another major gets `unsupported_protocol` |
| Newer client, older host | `GET /api/v1/capabilities` says what the host speaks; the client does not offer what is not there |
| Result files | `schemaVersion` above what weawr reads is refused, the file kept, the owner told |
| Custom templates | checked at config load; undeclared ones are protocol 1 |

### Owner recovery and rollback limits

One process owns a factory at a time (the SQLite lock in `.weawr/state/`), released by the OS
when it dies. A new owner finishes what the last one left: pending external work (comments,
label removals, workspace closes, agent exits) is retried up to three times, comments reconciled
against the issue first; in-flight runs are re-attached to their agents. Nothing is resent
blindly into an agent session. Rolling a factory back to `state.json` is sound only before new
work has started under the store; afterwards the store is the truth. Rolling the *tool* back is
`weawr update --to v<old>`; an older tool refuses a store or a result it does not understand
rather than guessing.

## Hacking on it

The repository is a pnpm workspace built with Turborepo: `apps/cli` (the executable), `apps/web`
(the console page), and `packages/{engine,recipes,protocol,client}`. See
[architecture.md](architecture.md) for who owns what.

```bash
git clone git@github.com:jmwind/weawr.git && cd weawr
pnpm install            # also builds, through `prepare`
pnpm build              # turbo run build → apps/cli/dist/weawr.mjs, the one file users run
pnpm test               # every package's tests, against their built output
pnpm lint               # the import-direction check (scripts/check-imports.mjs)
node apps/cli/dist/weawr.mjs --help
```

`npm install -g github:jmwind/weawr` keeps working without pnpm or Turborepo on the user's
machine: npm clones, installs the dev dependencies and runs `prepare`, which is
`scripts/build.mjs` — every package's own `build` script in dependency order, the same artifact
`turbo run build` makes. `node scripts/verify-install.mjs --git` exercises exactly that path.
