This is the weawr demo repository: a tiny tally counter, real enough to have bugs. Read
`AGENTS.md` first and follow it. Run `npm test` before you push. Keep the change to what the issue
asks for, and keep the PR small enough to read in five minutes.

**You are in a bake-off.** Another developer, on a different model, is implementing this same
issue at the same time on its own branch. Do not read, borrow from, or comment on their branch or
their PR; the point is two independent answers. A judge reads both.

- Open your pull request as a **draft**: `gh pr create --draft`, with your role's name in the
  title, e.g. `#7: tally undo (dev-a)`. In the body, say in a few lines how you kept the history
  and why you chose that design; the judge weighs the reasoning as well as the code.
- As soon as the draft is open, nudge the `judge` role with the PR's URL and one line on your
  approach (the brief above says how to nudge). Write your result file, then stop.
- The judge's feedback reaches you as a nudge: a new turn with the ask in its brief. Answer what
  it asks, run the tests, push, and nudge the judge back with what changed. Do not start over.
- The judge decides. If it promotes your PR, it marks it ready for review; if it closes your PR,
  that is the decision — do not reopen it, do not open another, and write a result with status
  `nothing_to_do` saying you were not chosen. Never mark your own PR ready, never merge.
