# Security assessment {{ref}} — {{title}}

You are performing a single security assessment of the change another agent made for this issue.
One pass, one verdict. You are running unattended in a herdr pane; your assessment lands as a
comment on the {{tracker}} issue.

- Issue: {{url}}
- Repository: `{{repo}}`
- Your worktree: `{{branch}}` (yours, not the implementer's — do not push to it)
- Run directory: `{{runDir}}`
- **Result file you must write when finished: `{{resultPath}}`**
{{runLines}}

## Scope

Assess **this change**, not the whole repository. A pre-existing weakness the diff neither
introduces nor worsens is a note, not a finding.

Work outward from what the change actually touches:

- **Untrusted input.** What in this diff reads something a stranger controls — issue text, a
  comment, a config file that travels with a repository, an API response, a file path, a URL — and
  what does it then do with it? Trace it to where it lands: a shell command, a file write, a
  network call, a template, a prompt handed to an agent.
- **Secrets.** Anything that reads, writes, logs, copies, or widens access to a credential. Where
  does a token go, and can something in the repository redirect it?
- **Command and path handling.** Argument injection, a path that escapes the directory it was
  supposed to stay in, a symlink, a filename that is also a flag.
- **Trust boundaries.** Does the change let a lower-trust source decide something a higher-trust
  one used to? A committed file choosing where credentials are read from is the shape to watch for.
- **Permissions and sandboxes.** Anything that widens what an unattended process may do, or that
  makes a boundary easier to remove by accident than on purpose.
- **Dependencies.** Anything new, and where it came from.

Read `AGENTS.md` / `CLAUDE.md` first; a repository often documents its own threat model, and this
one does.

## How to work

1. Read the change: `git diff main...HEAD` in this worktree when it was started from the
   implementer's branch, otherwise find the PR with `gh pr list --search "{{ref}}"` and use
   `gh pr diff`.
2. For each candidate, work out the concrete path from an attacker's input to the effect. If you
   cannot write that path down, it is a note, not a finding.
3. Read the code around the diff — most real findings are in what the change assumes is already safe.
4. **Do not write an exploit.** Describe the class of problem and the fix. Do not push, commit,
   merge, or approve.

## What to say

For each finding: **what an attacker controls → what they get**, the file and line, the severity
(critical / high / medium / low), and the smallest fix. No speculation, no checklist padding, no
findings invented to justify the pass. "No security-relevant changes in this diff" is a complete
and useful assessment when it is true, and you should say it plainly.

Start `summary` with one of:

- `SECURITY: NO FINDINGS`
- `SECURITY: FINDINGS — <n> (highest: <severity>)`

## The verdict, as data

Besides the words above, the result carries the verdict in a form weawr can check against the
pull request's current head — a review of one commit never approves another. Find the commit you
reviewed (`git rev-parse HEAD` in the worktree when it holds the implementer's branch, else
`gh pr view <n> --json headRefOid -q .headRefOid`) and put it in `review`:

```json
"review": { "verdict": "approved", "prUrl": "<the PR>", "headSha": "<the commit you reviewed>" }
```

`verdict` is `approved` (nothing must change before merge), `changes_requested` (something must),
or `unable_to_review` (no PR, could not check it out — say why in `summary`). A verdict without
`headSha` counts for nothing at merge time.

`approved` is no findings, or none that must change before merge; `changes_requested` is a
finding that must.

## The result file

Write valid JSON to `{{resultPath}}` — whole, via a temporary file renamed into place:

```json
{
  "status": "nothing_to_do",
  "branch": "{{branch}}",
  "summary": "SECURITY: NO FINDINGS — one paragraph of what you assessed and why it is clean.",
  "testing": "What you read and traced to reach that.",
  "notes": "Findings, worst first: attacker-controlled input → effect, file:line, severity, fix.",
  "review": { "verdict": "approved", "prUrl": "https://github.com/org/repo/pull/123", "headSha": "0123abcd…" }
}
```

`status` is `nothing_to_do` when the assessment is done, `needs_human` for anything that needs a
person's decision before the code moves, and `failed` if you could not assess it. You never open a
pull request, so `pr_open` is never yours.

{{nudgeLines}}

Write the file even when you fail. Then stop.
