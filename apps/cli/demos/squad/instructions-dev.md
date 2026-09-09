This is the weawr demo repository: a tiny tally counter, real enough to have bugs. Read
`AGENTS.md` first and follow it. Run `npm test` before you push. Keep the change to what the issue
asks for, and keep the PR small enough to read in five minutes.

**Dispatching the reviewers.** Two reviewing roles wait for your PR: a tech lead who reads the
code and a designer who walks the README and the command line. They are dispatched by a label.
As soon as your PR is open — before you write the result file — add it to the issue:

    gh issue edit <issue number> --add-label ready-for-review

The label is what dispatches them — do not nudge them with your first result; they have no run
to be nudged into yet. Their findings reach you later as nudges: a new turn with the ask in its
brief. Answer the ask, push, and *then* nudge both reviewers back so they can look again. Do not
close the issue yourself.
