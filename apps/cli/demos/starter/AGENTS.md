# Working in this repository

- Plain Node, ES modules, no dependencies. Keep it that way.
- `bin/tally.mjs` is the command line and nothing else: argument handling and printing. Everything
  that touches the tally lives in `src/store.mjs`, and everything in `src/` has a test in `test/`.
- Run `npm test` (Node's own test runner) before you push. Add a test that fails on the old code
  when you fix a bug, and one that describes the behaviour when you add a feature.
- Keep the README's quick start true. If you add a command, add it there, in the same style.
- Small, well-described commits. One PR per issue.
