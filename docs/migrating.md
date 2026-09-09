# Migrating from issue-herd

[← back to the README](../README.md)

weawr is issue-herd renamed ([#71](https://github.com/jmwind/weawr/issues/71)). The config shape,
the state files, the rule language and the tracker labels are what they were; what changed is the
name, and with it every path, variable and file that carried the name. This page is the whole list
and the order to do it in. It assumes one person and one machine, and it asks for a factory with
**nothing in flight** before anything moves — step 1 says why, and it is the one hard rule.

## What changed name

| Was | Is |
| --- | --- |
| package `issue-herd`, command `issue-herd` | package `weawr`, command `weawr` |
| `github:jmwind/issue-herd` | `github:jmwind/weawr` |
| `<repo>/.issue-herd/` — `config.json`, `config.local.json`, `instructions.md`, `prompts/`, `state/`, `worktrees/` | `<repo>/.weawr/`, same contents |
| `~/.config/issue-herd/` — `credentials.json` (tokens and the console passcode), `factories.json`, `console.json` | `~/.config/weawr/`, same contents |
| `ISSUE_HERD_*` environment variables | `WEAWR_*`, same suffixes: `CONSOLE_NOTES`, `CONSOLE_PORT`, `CREDENTIALS`, `DEBUG`, `GITHUB_CLIENT_ID`, `GITHUB_HOST`, `LINEAR_CLIENT_ID`, `NO_UPDATE_CHECK`, `OAUTH_PORT`, `REGISTRY` |
| `.issue-herd/state/logs/issue-herd.log` | `.weawr/state/logs/weawr.log` |
| the console's session cookie `issue_herd_console` | `weawr_console` — you enter the passcode once more |
| the pickup comment `🐑 **issue-herd** picked this up …` | `🧵 **weawr** picked this up …` — the old wording still counts as a claim, so an issue taken under the old name is not taken twice |
| the update check, `https://raw.githubusercontent.com/jmwind/issue-herd/main/package.json` | `…/jmwind/weawr/main/package.json` |

Unchanged: everything named after **herdr** — the `herdr` claim label, the `herdr:<role>` labels,
the workspaces and agent names; the `ready-for-review` label; branch names and pull requests;
`.env` / `.env.local` and `GITHUB_TOKEN` / `LINEAR_API_KEY`; the version number; and the path of
the checkout itself, which this migration does not move.

## The order

1. **Finish every run first.** A run records where its things are as absolute paths — its
   worktree, its run directory, its `result.json`, its brief — and step 4 moves the directories
   those paths point into. When the watcher starts again it reads each live run's result at the
   recorded path; a path that no longer exists reads as "no result yet", and a live run whose
   agent is gone is then marked `stopped` with its real result never consumed. (Reproduced twice
   while reviewing the rename: once by moving `state/`, once by moving the checkout.) So before
   anything moves,

   ```bash
   issue-herd status
   ```

   must show no run in `starting`, `running` or `awaiting_merge`. `done`, `merged`, `failed` and
   `stopped` are finished: nothing reads their paths again, and they stay in `state.json` as the
   console's history. For a run that is still live, either let it finish and its PR merge, or open
   its workspace and finish it by hand, or, when it is not worth keeping, exit the agent, close the
   workspace and `issue-herd reset <KEY>`. Reset forgets the state entry and nothing else; it does
   not touch the worktree.

   Then remove the old worktrees yourself. The watcher removes one on merge only when the rule's
   `onMerged.removeWorktree` is on, and it is off by default, so they are normally all still there:

   ```bash
   git worktree list                                  # every checkout under .issue-herd/worktrees/
   git worktree remove .issue-herd/worktrees/<slug>   # one at a time; --force drops uncommitted work
   ```

   `git worktree remove` refuses a checkout with uncommitted changes, which is the point: commit or
   move aside what you want to keep, then remove. The branches stay; only the checkouts go. Last,
   stop the watcher (close its herdr pane) and stop `issue-herd console` if it is up.

2. **Rename the repository on GitHub.** Settings → General → Repository name → `weawr`. GitHub
   redirects the old URL for clones, issues and pull requests, so nothing already linked breaks.
   Do this before the first release under the new name: the update check and `weawr update` read
   `jmwind/weawr`, and until that exists they get a 404, which looks to them like "nothing newer".

3. **Point the clone at the new name**, and leave it where it is:

   ```bash
   git remote set-url origin git@github.com:jmwind/weawr.git
   ```

   Renaming the checkout directory (`~/Code/issue-herd` → `~/Code/weawr`) is not part of this
   migration. The console's registry (`factories.json`) and its marked-done notes (`console.json`)
   are keyed by the checkout's path, so a moved checkout is a new factory with no history to the
   console, and every worktree git knows is registered by absolute path. If you want the directory
   renamed anyway, do it as a separate job later under the same rule as step 1 — nothing in
   flight, watcher and console down — then `git worktree repair` from the new location, and expect
   the console to list it as a new factory.

4. **Merge the rename and pull it.** The tracked half of the config directory arrives as `.weawr/`
   (`config.json`, `instructions.md`, `.gitignore`) and git removes the tracked files from
   `.issue-herd/`. Move the untracked half yourself — safe now, because step 1 left no run that
   will be read again at its old path:

   ```bash
   mv .issue-herd/state .weawr/state
   [ -f .issue-herd/config.local.json ] && mv .issue-herd/config.local.json .weawr/
   [ -d .issue-herd/prompts ] && mv .issue-herd/prompts .weawr/
   rmdir .issue-herd/worktrees 2>/dev/null; rmdir .issue-herd
   ```

   The finished runs in `state.json` keep their old paths as a record; nothing follows them. New
   runs record `.weawr/…` paths and put their worktrees in `.weawr/worktrees/`. If the last `rmdir`
   refuses, something is still inside — a worktree step 1 missed (`git worktree list` names it) or a
   file of yours. Until it is gone the directory shows as untracked, because the `.gitignore` that
   hid it moved with the config; `echo .issue-herd/ >> .git/info/exclude` hides it meanwhile.

5. **Reinstall the command.**

   ```bash
   npm uninstall -g issue-herd
   npm install -g --allow-scripts=weawr github:jmwind/weawr     # or, from the clone: npm link
   weawr --version
   ```

6. **Move the per-user files.** Tokens, the console passcode, the factory registry and the
   console's own notes all live in one directory; moving it keeps every login and every "marked
   done".

   ```bash
   mv ~/.config/issue-herd ~/.config/weawr
   ```

   Skip this and `weawr login` signs you in again, `weawr console set-passcode` sets the passcode
   again, and the console forgets which tasks you had marked done.

7. **Rename any `ISSUE_HERD_*` you export in your shell** to `WEAWR_*`. The suffixes are the same
   (the table above lists them). A repository's `.env` never carried these, so there is nothing to
   change there.

8. **Start the watcher again**, under the new name, from the repository:

   ```bash
   herdr tab create --label weawr --cwd "$PWD" --no-focus
   herdr pane run <pane-id> "weawr"
   ```

   Its first line says `weawr <version> in <repo>: watching N rule(s)`, and `weawr status` shows
   the finished runs it carried over. The console is `weawr console`, on the same port, with the
   same passcode if you moved the directory in step 6.

9. **Release.** `npm run release` once the GitHub rename is done, so that the version the update
   check finds is one that exists.

## If something is off afterwards

- `no .weawr/config.json` — step 4 has not happened in this repository, or you are in a worktree
  cut before the rename (those have `.issue-herd/`; they are not factories and never were).
- `no GitHub credentials` — step 6 was skipped; run `weawr login github`.
- The console lists no factory — the registry is stamped by the watcher every poll; start the
  watcher (step 8) and it appears on the first one.
- A run that came back `stopped` on the restart although its PR is open — it was live when
  step 4 ran, and its result sat at a path that moved. The PR and the issue's claim are untouched;
  finish it by hand (merge the PR, `weawr reset <KEY>` to forget the run).
- A worktree left under `.issue-herd/worktrees/` — nothing removes one by itself unless the rule
  had `onMerged.removeWorktree` on; `git worktree remove <path>` (with `--force` to drop
  uncommitted work) takes it out, and `git worktree prune` forgets one already deleted by hand.
