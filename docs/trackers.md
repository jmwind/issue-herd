# Issue trackers and signing in

[← back to the README](../README.md)

## Issue trackers

`"tracker"` in `config.json` says which one. Everything else (rules, guards, the brief, the
comments) is the same for all of them.

**Linear** (`"tracker": "linear"`, the default). Issues are known by their key (`DEV-123`), the
branch is Linear's own branch name, `state` is the team workflow, comments and state changes go to
the issue. The claim label must exist in Linear.

**GitHub Issues** (`"tracker": "github"`). The repository is the `origin` remote of the repo you run
in; name it explicitly with `{ "type": "github", "repo": "owner/name" }`. Issues are known as `GH-7`
(change the prefix with `"prefix"`), referenced as `#7` in PR text so `Fixes #7` closes them, and
the default branch is `7-fix-the-thing`. Mapping:

- `team` is the repository (`team:issue-herd`) and `project` is the milestone.
- `state` is `open` or `closed`. There are no workflow states, so `init` sets `onPickup.state` and
  `onDone.state` to `null`. Any other state name is **refused**, with an error naming what GitHub
  has: it will not invent a label or close your issue on a guess.
- `priority` comes from labels named `P0`–`P3` or `urgent` / `high` / `medium` / `low`
  (`priority: high` works too). The most urgent label on the issue wins. With no such label the
  priority is "none", so a `priority<=2` rule matches nothing in a repository that does not use them.
- `estimate` and `cycle` are always empty, so any rule using them matches nothing.
- `assignee` and `creator` match `@login`. An issue assigned to several people is left alone unless
  every assignee is you.
- The claim label is created if missing. Pull requests are never treated as issues.

For GitHub Enterprise, set `ISSUE_HERD_GITHUB_HOST=ghe.corp.com` in your shell. That is deliberately
a machine setting rather than a config key: `config.json` is committed, and this value decides where
your token is sent, so a repository you clone may *name* the host it expects but not introduce one.
For the same reason a repository's `.env` cannot set any `ISSUE_HERD_*` variable, and `prompt` and
`instructionsFile` must point inside `.issue-herd/`.

**Adding a tracker** is one file. Write `src/trackers/<name>.mjs` against the contract documented
at the top of [`src/tracker.mjs`](../src/tracker.mjs) — a class with `me`, `openIssues`,
`issueByKey`, `comment`, `addLabel`, `removeLabel`, `assign`, `setState` and a static `login` —
returning the normalized issue shape, then add it to `src/trackers/index.mjs`.
[`github.mjs`](../src/trackers/github.mjs) is the model: one read query and a few writes, no
dependencies. `test/trackers.test.mjs` checks every registered tracker against the
contract; `checkIssue()` tells a new tracker exactly which field it got wrong.

## Signing in

`issue-herd login [linear|github]` obtains a token, proves it works with a `me` call, and saves it
in `~/.config/issue-herd/credentials.json` (mode 600). Runs before `init` too, when the tracker is
named. `issue-herd logout` forgets it. At startup the banner says which account is in use and where
the token came from. Lookup order:

1. the environment: `LINEAR_API_KEY`, or `GITHUB_TOKEN` / `GH_TOKEN`, read from the process, then
   `<repo>/.env.local`, then `<repo>/.env`
2. the saved credential
3. GitHub only: `gh auth token`, so a machine with `gh` logged in needs no login at all

`login` never copies a token another tool owns: with `gh` logged in it saves nothing and re-reads
`gh auth token` on every run, so a token `gh` rotates keeps working.

How `login` gets the token, per tracker:

- **GitHub**: a device-flow browser sign-in when the tool has a GitHub OAuth app client id;
  otherwise the token `gh` is logged in with, or `gh auth login` (browser) if `gh` is present but
  logged out; otherwise it opens the new-token page (scope `repo`) and asks you to paste the token.
- **Linear**: a browser sign-in (authorization code + PKCE, loopback redirect on
  `http://localhost:8497/callback`, token refreshed automatically before it expires) when the tool
  has a Linear OAuth client id; otherwise it opens Settings → Security & access → Personal API keys
  and asks you to paste the key. `--paste` forces the paste route on either tracker.

The browser flows need an OAuth application registered with the provider, which ships as a client
id in the code (no secret: PKCE for Linear, device flow for GitHub). Maintainers: register one,
then set `LINEAR_CLIENT_ID` in `src/trackers/linear.mjs` (Linear → Settings → API → OAuth
applications, callback `http://localhost:8497/callback`, public client) and `GITHUB_CLIENT_ID` in
`src/trackers/github.mjs` (GitHub → Settings → Developer settings → OAuth Apps, enable device flow).
Until then the same flows can be tried with the `ISSUE_HERD_LINEAR_CLIENT_ID` and
`ISSUE_HERD_GITHUB_CLIENT_ID` environment variables, or per repository with a `clientId` in the
tracker object. `ISSUE_HERD_OAUTH_PORT` moves the loopback port, `ISSUE_HERD_CREDENTIALS` the
credentials file, and `ISSUE_HERD_GITHUB_HOST` names a GitHub Enterprise host. All of these are read
from your shell only, never from a repository's `.env`.

