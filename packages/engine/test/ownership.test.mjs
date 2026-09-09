// Exclusive ownership: one owner per factory per machine, the lock released by the OS when the
// owner dies, and a calling card that says who holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireOwnership, currentOwner, describeHolder, readCard } from '../dist/ownership.js';

const OWN = fileURLToPath(new URL('../dist/ownership.js', import.meta.url));
const card = (factoryId, over = {}) => ({ factoryId, hostId: 'h1', startedAt: '2026-09-08T00:00:00Z', version: '0.2.8', socketPath: null, ...over });

function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-own-')); return { lockPath: path.join(d, 'owner.lock'), ownerPath: path.join(d, 'owner.json'), dir: d }; }

test('the first owner wins; a second in the same process is refused and told who holds it', () => {
  const { lockPath, ownerPath } = tmp();
  assert.deepEqual(currentOwner({ lockPath, ownerPath }), { owned: false, holder: null });
  const first = acquireOwnership({ lockPath, ownerPath, card: card('f1') });
  assert.equal(first.ok, true);
  assert.equal(readCard(ownerPath).pid, process.pid);
  const second = acquireOwnership({ lockPath, ownerPath, card: card('f1') });
  assert.equal(second.ok, false);
  assert.equal(second.holder.pid, process.pid);
  assert.match(describeHolder(second.holder), new RegExp(`pid ${process.pid}`));
  assert.equal(currentOwner({ lockPath, ownerPath }).owned, true);
  first.ownership.release();
  assert.equal(currentOwner({ lockPath, ownerPath }).owned, false);
  assert.equal(readCard(ownerPath), null, 'a released owner takes its card with it');
  assert.equal(acquireOwnership({ lockPath, ownerPath, card: card('f1') }).ok, true);
});

test('a lock held by another process is busy until that process dies — even when killed outright', async () => {
  const { lockPath, ownerPath } = tmp();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireOwnership } from ${JSON.stringify(OWN)};
    const r = acquireOwnership({ lockPath: ${JSON.stringify(lockPath)}, ownerPath: ${JSON.stringify(ownerPath)}, card: { factoryId: 'f1', hostId: 'h1', startedAt: 'x', version: 'v', socketPath: '/tmp/s' } });
    process.stdout.write(r.ok ? 'held\\n' : 'busy\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(); }));
  const mine = acquireOwnership({ lockPath, ownerPath, card: card('f1') });
  assert.equal(mine.ok, false, 'the child holds it');
  assert.equal(mine.holder.pid, child.pid, 'the card names the child');
  assert.equal(currentOwner({ lockPath, ownerPath }).owned, true);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  // No release ran in the child; the kernel dropped its lock. The stale card is only a card.
  assert.equal(currentOwner({ lockPath, ownerPath }).owned, false);
  assert.equal(readCard(ownerPath)?.pid, child.pid, "the dead owner's card is still there…");
  const after = acquireOwnership({ lockPath, ownerPath, card: card('f1') });
  assert.equal(after.ok, true, '…and does not stop a new owner');
  assert.equal(readCard(ownerPath).pid, process.pid);
  after.ownership.release();
});
