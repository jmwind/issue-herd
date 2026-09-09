// The terminal: timestamps, the one-line heartbeat that is rewritten in place on a TTY, and the
// usage text. Nothing here knows about factories.
export const HELP = `weawr — watch an issue tracker (Linear or GitHub Issues); when an issue matches a rule, open
a git worktree and a herdr workspace, start a coding agent in it, brief it, and report back.

  weawr                   run the watcher (foreground; run it inside a herdr pane)
  weawr once              one poll, then exit
  weawr dry-run           show what would be picked up, touch nothing
  weawr match "<expr>"    evaluate an expression against live open issues
  weawr status            show tracked runs
  weawr reset <KEY>       forget a run so the issue can be picked up again
  weawr login [tracker]   sign in (browser when possible) and save the token for this machine
  weawr logout [tracker]  forget the saved token
  weawr smoke             end-to-end test against herdr with a fake issue (no tracker calls)
  weawr init [--tracker linear|github]  scaffold .weawr/ in this repo
  weawr serve [--port N] [--host ADDR] [--no-web]  the CLI interface (/api/v1, events) for every factory here, with the web console
  weawr console [--port N] [--host ADDR] [--theme factorio|clean|linear|github|tokyo-night|solarized-light]  the same, by its older name: the factory floor in a browser (phone first)
  weawr console set-passcode  set the passcode (digits) the console asks for; also serves it over Tailscale
  weawr console clear-passcode  forget the passcode; the console goes back to loopback only
  weawr console device add|list|revoke <name>  device tokens for native clients (a phone)
  weawr migrate [--dry-run] move a factory's state.json into the durable store (the watcher does this on start)
  weawr recipe [show|upgrade [--to N] [--dry-run]]  which briefs agents get; move to a newer bundled revision (new tasks only)
  weawr merge <run-key>   merge a run's PR if the issue carries the merge label and every reviewer approved its current head
  weawr result <run-key> --file F | --json J  hand in an agent's result through weawr (checked, written whole)
  weawr task reconfigure <run-key>  move an active run onto the current policy; weawr task attempts <run-key> shows its record
  weawr plugins [examples]  which plugins this factory enables (intake, roles, scheduled tasks), and what ships
  weawr demo [list|<scenario>|reset]  a factory to try weawr on, against the demo repository: file the scenario's issues, run, reset
  weawr update [--to vX.Y.Z]  reinstall from an immutable release tag (the newest by default) and say how to roll back
  weawr --version

Run it from inside the git repository it should work on. Everything is project-local:
  <repo>/.weawr/config.json        which tracker, rules and defaults (committed)
  <repo>/.weawr/config.local.json  per-machine overrides of config.json, same shape (gitignored)
  <repo>/.weawr/instructions.md    repo brief appended to every agent prompt (committed)
  <repo>/.weawr/prompts/default.md optional override of the built-in prompt template
  <repo>/.weawr/state/             state.json, runs/<KEY>/, logs/, the owner lock (gitignored)
  <repo>/.env, <repo>/.env.local   LINEAR_API_KEY / GITHUB_TOKEN (gitignored), if you prefer a file
  ~/.config/weawr/credentials.json tokens saved by \`weawr login\` (per user, mode 600)
  ~/.config/weawr/factories/       one registration per factory running on this machine (per user)
`;

export function ts(d = new Date()): string { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }

export interface Ui {
  /** An event line. The engine stamps its own; this prints whatever it is given. */
  print(line: string): void;
  /** A stamped event line of the CLI's own. */
  log(...a: unknown[]): void;
  /** The heartbeat: overwritten in place on a TTY, printed every 10th time otherwise. */
  live(text: string): void;
}

export function terminal(out: NodeJS.WriteStream = process.stdout): Ui {
  const TTY = !!out.isTTY;
  let liveLine = false;
  let heartbeats = 0;
  const print = (line: string) => { if (liveLine && TTY) { out.write('\r\x1b[2K'); liveLine = false; } out.write(line + '\n'); };
  return {
    print,
    log: (...a) => print(`[${ts()}] ${a.join(' ')}`),
    live: (text) => { heartbeats++; if (TTY) { out.write(`\r\x1b[2K${text}`); liveLine = true; } else if (heartbeats % 10 === 1) out.write(text + '\n'); },
  };
}
