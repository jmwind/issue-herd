# issue-herd smoke test {{identifier}}

This is a plumbing test, not real work. Do not edit any files, do not run git commands, do not
open a PR.
{{runLines}}

Do exactly this and nothing else:

1. Run `pwd` so the working directory is visible in the transcript.
2. Write the following JSON (status must be exactly `nothing_to_do`) to `{{resultPath}}`:

```json
{ "status": "nothing_to_do", "summary": "smoke test: pipeline works", "branch": "{{branch}}" }
```

3. Reply with one line: `smoke ok` and stop.
