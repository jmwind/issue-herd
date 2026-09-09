# weawr demos

Try weawr end to end against a repository made for it: https://github.com/jmwind/weawr-demo.
Each folder here is one scenario: a factory config, the briefs it needs, and the issues to file.

| scenario | who works |
|---|---|
| `basic` | one developer. You merge. |
| `squad` | a developer, a tech lead (codex), a designer (Haiku). The `auto-merge` issue merges itself. |
| `bake-off` | two developers on different models, and a judge that picks one PR. You merge. |

## Run one

```bash
weawr demo squad                                   # 1. clone the demo repo, write .weawr/, file the issues
cd ~/.config/weawr/demos/weawr-demo && weawr       # 2. run the watcher on it (needs herdr running)
weawr console                                      # 3. watch it in the browser (from anywhere)
weawr demo reset                                   # 4. done: close the issues and PRs, clear the state
```

Then the next scenario: `weawr demo bake-off`, and so on. `weawr demo` alone lists them.

## From a weawr checkout, on the development build

```bash
node apps/cli/build/main.js demo squad             # same as step 1, with the dev build (pnpm build first)
WEAWR_DEV_FACTORY=~/.config/weawr/demos/weawr-demo pnpm dev   # steps 2 and 3: watcher + console, restarting on every edit
node apps/cli/build/main.js demo reset             # step 4
```

## Good to know

- The first run pushes a small app (`tally`) to the demo repo; the issues are about it.
- The scenario's `.weawr/` lives in the clone and never gets committed.
- `reset` only touches what the ledger says this factory filed. `reset --all --yes` wipes every
  open `ai` issue, PR and branch in the demo repo.
- `--into DIR` puts the factory elsewhere; `--dry-run` shows what would be filed and files nothing.
- Before `squad` or `bake-off`: be signed in to each agent (`claude`, `codex login`) and answer
  codex's first "trust this directory?" prompt by hand once.
