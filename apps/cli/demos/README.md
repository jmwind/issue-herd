# weawr demos

Try weawr end to end against a repository made for it: https://github.com/jmwind/weawr-demo.
Each folder here is one scenario: a team config, the briefs it needs, and the issues to file.

| scenario | who works |
|---|---|
| `basic` | one developer (Sonnet). You merge. |
| `basic-auto` | one developer and a test gate (Sonnet, low effort); PRs merge themselves when the tests are green. |
| `squad` | a developer (Sonnet), a tech lead (codex, low effort), a designer (Sonnet). The `auto-merge` issue merges itself. |
| `bake-off` | two developers (Sonnet and codex), and a judge (Sonnet) that picks one PR. You merge. |

## Run one from this checkout (the branch you are on)

One command builds the branch, sets the demo up with it, and starts the watcher and the console
on it, restarting on every edit:

```bash
pnpm demo squad          # build, clone the demo repo, file the issues, run watcher + console
pnpm demo reset          # done: close the issues and PRs, clear the state
pnpm demo                # list the scenarios
```

Ctrl-C stops the watcher and the console. If `pnpm dev` is already running in another terminal,
stop it first: both want port 8498 (or give this one `WEAWR_DEV_PORT=8499`).

## Run one with an installed weawr

```bash
weawr demo squad                                   # 1. clone the demo repo, write .weawr/, file the issues
cd ~/.config/weawr/demos/weawr-demo && weawr       # 2. run the watcher on it (needs herdr running)
weawr console                                      # 3. watch it in the browser (from anywhere)
weawr demo reset                                   # 4. done: close the issues and PRs, clear the state
```

## Good to know

- The first run pushes a small app (`tally`) to the demo repo; the issues are about it.
- The scenario's `.weawr/` lives in the clone and never gets committed.
- `reset` only touches what the ledger says this team filed, and puts the app back to the
  starter with a new commit on `main` (so a feature a demo merged is missing again for the next
  run); `--keep-code` leaves `main` alone. `reset --all --yes` wipes every open `ai` issue, PR and
  branch in the demo repo.
- The demos run on the cheapest models that can run unattended: Sonnet, and codex at low effort.
  Haiku cannot run in auto mode, so it is never used.
- `--into DIR` puts the team elsewhere; `--dry-run` shows what would be filed and files nothing.
- Be signed in to each agent you use (`claude`, `codex login`). The first run in a fresh demo
  clone stops on each agent's "trust this folder?" dialog: answer it once in the agent's pane
  (the console shows the run as waiting on you); weawr sends the brief once the dialog is gone.
