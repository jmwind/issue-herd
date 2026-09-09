# Migrating from issue-herd

[← back to the README](../README.md)

weawr is issue-herd renamed ([#71](https://github.com/jmwind/weawr/issues/71)). The config shape,
the state files, the rule language and the tracker labels are what they were; what changed is the
name, and with it every path, variable and file that carried the name. This page is the whole list
and the order to do it in. It assumes one person, one machine, and a factory that may have runs in
flight.

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
the workspaces and agent names; the `ready-for-review` label; the branch names and pull requests of
runs in flight; `.env` / `.env.local` and `GITHUB_TOKEN` / `LINEAR_API_KEY`; the version number.

## The order

1. **Let what is running finish, or be ready to finish it by hand.** Runs in flight keep working
   through the move (their worktrees and result files are recorded by absolute path in `state.json`),
   but the watcher has to come down to be restarted under the new name, and it is simpler with
   nothing to supervise. Then stop the watcher: in herdr, close the pane that runs `issue-herd`.
   Stop `issue-herd console` if it is up.

2. **Rename the repository on GitHub.** Settings → General → Repository name → `weawr`. GitHub
   redirects the old URL for clones, issues and pull requests, so nothing already linked breaks.
   Do this before the first release under the new name: the update check and `weawr update` read
   `jmwind/weawr`, and until that exists they get a 404, which looks to them like "nothing newer".

3. **Point the clone at the new name.** In the repository (worktrees share the remote):

   ```bash
   git remote set-url origin git@github.com:jmwind/weawr.git
   ```

   Renaming the directory (`mv ~/Code/issue-herd ~/Code/weawr`) is optional. If you do, run
   `git worktree repair` from the new location afterwards, because git registers worktrees by
   absolute path and the old ones under `.issue-herd/worktrees/` would be lost track of.

4. **Merge the rename and pull it.** The tracked half of the config directory arrives as `.weawr/`
   (`config.json`, `instructions.md`, `.gitignore`) and git removes the tracked files from
   `.issue-herd/`. Move the untracked half yourself:

   ```bash
   mv .issue-herd/state .weawr/state
   [ -f .issue-herd/config.local.json ] && mv .issue-herd/config.local.json .weawr/
   [ -d .issue-herd/prompts ] && mv .issue-herd/prompts .weawr/
   ```

   Leave `.issue-herd/worktrees/` where it is. The runs that own those worktrees know them by
   absolute path, and weawr removes each one when its PR merges (or `weawr reset <KEY>` does); new
   runs go to `.weawr/worktrees/`. Until the old directory is empty it shows as untracked, because
   the `.gitignore` that hid it moved with the config — `echo .issue-herd/ >> .git/info/exclude`
   keeps it out of `git status` without committing anything. Delete `.issue-herd/` when it is empty.

5. **Reinstall the command.**

   ```bash
   npm uninstall -g issue-herd
   npm install -g github:jmwind/weawr     # or, from the clone: npm link
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

   Its first line says `weawr <version> in <repo>: watching N rule(s)`. The console is
   `weawr console`, on the same port, with the same passcode if you moved the directory in step 6.

9. **Release.** `npm run release` once the GitHub rename is done, so that the version the update
   check finds is one that exists.

## If something is off afterwards

- `no .weawr/config.json` — step 4 has not happened in this repository, or you are in a worktree
  cut before the rename (those have `.issue-herd/`; they are not factories and never were).
- `no GitHub credentials` — step 6 was skipped; run `weawr login github`.
- The console lists no factory — the registry is stamped by the watcher every poll; start the
  watcher (step 8) and it appears on the first one.
- An old worktree under `.issue-herd/worktrees/` that nothing removes — its run is gone from
  `state.json`; `git worktree remove <path>` takes it out.
