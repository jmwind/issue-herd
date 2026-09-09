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
