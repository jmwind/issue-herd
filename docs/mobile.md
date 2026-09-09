# A mobile client

[← back to the README](../README.md)

Everything a phone app needs is the CLI's own interface. There is no second source of truth, no
credential to carry, and no lifecycle rule to reimplement.

## What you talk to

`weawr serve` on the machine that runs the factories (Tailscale reaches it; a passcode gates it).
The interface is `/api/v1`, described in
[architecture.md](architecture.md#the-cli-interface-weawr-serve-the-protocol-and-the-client);
the contracts are `packages/protocol`, and `packages/client` (`WeawrClient`) is a portable
implementation you can use as is — it needs only `fetch` and a readable byte stream.

## How you authenticate

A browser has a session cookie and an origin; a phone has neither. It has a **device token**:

```bash
weawr console device add my-phone     # prints the token once
weawr console device list
weawr console device revoke my-phone
```

Send it as `Authorization: Bearer <token>`. Only its salted hash is stored. Every command a device
sends is scoped to that device for request-id deduplication.

## What you show

1. `GET /api/v1/capabilities` — what this host speaks (protocol versions, commands, auth).
2. `GET /api/v1/snapshot` — every factory; or `/api/v1/factories/<id>/snapshot` for one.
3. `GET /api/v1/events?cursors=<factoryId>:<seq>,…` — keep one cursor per factory (each
   factory snapshot's `revision` is the first), resume after it on reconnect, refetch a factory
   when the stream says `resnapshot`.

Show `owner.status` (`online` / `stale` / `offline`) and `freshness` on every factory, and your
own link state: a lost connection means what you show is old, never that something happened.
`issues[].attention` says what a person should do about a task; `runs[].result.verdict` is a
reviewer's verdict as data. Do not derive either yourself.

## What you can do

`POST /api/v1/commands/<name>` with the bodies in `packages/protocol/src/envelope.ts`:
`task.done`, `task.undo`, `task.stop`, `task.reset`, `task.tail`, `run.exit`, `run.tail`,
`factory.tidy`. Always send a `requestId` you generated; resend the same one after a lost answer.
The response is the operation (poll `/api/v1/factories/<id>/operations/<opId>` until
`completed`, `failed` or `partial`) and its result. A factory whose owner is offline refuses every
mutation with `owner_offline`; show that, do not retry in a loop.

## What you never do

Read local files (worktree paths in a snapshot are display metadata), hold GitHub or tracker
tokens, or invent a lifecycle fact. If the host answers `unsupported_protocol`, tell the person to
update whichever is older.
