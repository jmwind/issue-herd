This is the weawr demo repository: a tiny tally counter, real enough to have bugs. Read
`AGENTS.md` first and follow it. Run `npm test` before you push. Keep the change to what the issue
asks for, and keep the PR small enough to read in five minutes.

**Dispatching the test gate.** One reviewing role waits for your PR: a gate that runs the tests on
your exact head and approves it when they are green. It is dispatched by a label. As soon as your
PR is open — before you write the result file — add it to the issue:

    gh issue edit <issue number> --add-label ready-for-review

The label is what dispatches it — do not nudge it with your first result; it has no run to be
nudged into yet. A failure reaches you later as a nudge: a new turn with the failing output in its
brief. Fix it, run the tests, push, and *then* nudge `ci` back. When the gate has approved, the
coordinator gives you a turn that names the merge command. Do not close the issue yourself.
