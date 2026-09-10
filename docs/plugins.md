# Plugins

[← back to the README](../README.md)

A plugin is one ES module whose default export says what it provides. Three seams, each one
weawr already had:

| Seam | What a plugin gives | How a team uses it |
| --- | --- | --- |
| **intake** | a tracker class on the contract in `packages/engine/src/adapters/tracker.mjs` — issues from anywhere | `"tracker": "<id>"` in `config.json` |
| **roles** | a role preset: a brief, and rule defaults to go with it | a rule with `"use": "<preset>"` |
| **tasks** | scheduled work, run by the watcher on its own cadence with the team's snapshot | nothing to configure; it runs while the watcher runs |

```js
// my-plugin.mjs
export default {
  name: 'my-plugin', version: '1.0.0', api: 1,
  intake: [MyTracker],
  roles: { docs: { prompt: '…{{resultPath}}…{{nudgeLines}}', defaults: { basedOn: 'impl', passes: 3 } } },
  tasks: [{ name: 'digest', every: '1h', async run({ snapshot, notify, log, memory, now }) { /* … */ return { seen: … }; } }],
};
```

A plugin imports nothing from weawr: intake is a class, a role is data, a task is a function.
`api` is the plugin API this weawr provides (1); a plugin that needs a newer one is refused with
the reason.

## Enabling plugins, and why paths are per machine

```jsonc
// .weawr/config.json (committed)
{ "plugins": ["examples/file-intake", "weawr-plugin-linear-projects"], "tracker": "file", … }

// .weawr/config.local.json (yours, gitignored)
{ "plugins": ["./plugins/my-plugin.mjs"] }
```

A plugin is code the watcher runs, and `config.json` is committed, so a repository you clone must
not get to run a file on your machine by naming it. A **path** (`./…`, `/…`) is therefore honoured
only from `config.local.json`; from `config.json` it is reported and ignored. A **name** resolves
to a shipped example (`examples/<name>`) or to a package you installed yourself:

```bash
npm install --prefix ~/.config/weawr/plugins weawr-plugin-linear-projects
```

`weawr plugins` shows what is enabled, where each plugin came from, what it provides and what is
in use; `weawr plugins examples` lists what ships. A tracker id or a preset that nothing enabled
provides is a config error that names the plugin problem, so a teammate without the plugin sees
why rather than a mystery.

## The three that ship

- `examples/file-intake` — issues from `.weawr/issues.json` (`[{ "id": 1, "title": "…",
  "labels": ["ai"] }]`), with the claim label, comments and state written back into the same file.
  An offline team, a demo, or a source of work that is not a tracker: anything that can write
  JSON can feed a team. `"tracker": "file"`.
- `examples/docs-review` — a `docs` role preset: a reviewer that reads the change against the
  documentation and puts its verdict on the reviewed commit (`review: { verdict, headSha }`).
  `{ "name": "docs", "use": "docs", "match": "label:ai and label:ready-for-review" }`.
- `examples/waiting-nudge` — a task every 15 minutes: one herdr notification per task that has
  waited on a person for over an hour, once, using the memory the task returns.

## What a task gets

`run({ team, snapshot, log, notify, now, memory })`: the team's canonical snapshot (the same
one the console shows — `issues[]`, `alerts[]`, `production`), a logger into the watcher's log, a
notifier through herdr, the clock, and whatever the task returned last time (`memory`), so a task
can avoid repeating itself across runs. A task that throws is a log line; the watcher carries on.
Tasks run after each poll, when their `every` has passed.

## What a role preset gets

The preset's `defaults` sit under the rule's own fields (the rule wins), its `prompt` is the brief
(checked like any template: placeholders, `{{resultPath}}`, `{{nudgeLines}}`), and the rule's role
is the preset's name unless the rule says otherwise. Every attempt records
`templateOrigin: "plugin:<name>@<version>"` and the brief's hash, so what a plugin's brief said
when is inspectable (`weawr task attempts <run key>`). Upgrading the plugin changes new attempts;
a running one keeps its brief.
