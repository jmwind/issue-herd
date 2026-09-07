# Maintainers

[← back to the README](../README.md)

## Release a change

Edit, commit as usual, then:

```bash
npm run release
```

**Rename the GitHub repository to `issue-herd` before the first release under this name.** The
update check and `issue-herd update` both point at `jmwind/issue-herd`; until that repository
exists they get a 404, which `newerVersion` cannot tell from "no newer version", so every install
would silently believe it is up to date forever.

That runs the tests, bumps the patch version in `package.json`, commits it, tags `vX.Y.Z`, and
pushes commits and tags. Everyone picks it up with `issue-herd update`. Use
`npm run release:minor` for a feature. To hack on the tool without installing:

```bash
git clone git@github.com:jmwind/issue-herd.git && cd issue-herd && npm link
```

Requires Node 22+, the `herdr` CLI with its server running, `claude` on PATH and logged in, and
`gh` logged in for PRs (with GitHub Issues as the tracker, that login is also the token). No npm
dependencies.


## Hacking on it

```bash
git clone git@github.com:jmwind/issue-herd.git && cd issue-herd && npm link
```

`npm test` runs the tool's own unit tests (Node's built-in runner, no dependencies).
