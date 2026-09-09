// The gate: passcodes, sessions, lockout, device tokens, and the Tailscale address filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate, hashPasscode, verifyPasscode, newDeviceToken, deviceFor } from '../build/transports/gate.mjs';
import { tailscaleAddresses } from '../build/transports/http.js';

test('passcode: hash verifies, wrong code fails, gate locks after five misses and sessions expire', () => {
  const h = hashPasscode('2468');
  assert.ok(verifyPasscode('2468', h)); assert.ok(!verifyPasscode('2469', h)); assert.ok(!verifyPasscode('2468', 'garbage'));
  assert.throws(() => hashPasscode('12'), /at least 4 digits/); assert.throws(() => hashPasscode('abcd'), /at least 4 digits/);
  let now = 1_000_000;
  const g = new Gate({ hash: h, sessionMs: 1000, maxAttempts: 5, lockoutMs: 60_000, now: () => now });
  assert.equal(g.enabled, true);
  for (let i = 0; i < 4; i++) assert.equal(g.tryUnlock('0000', 'a').ok, false);
  assert.equal(g.tryUnlock('0000', 'a').attemptsLeft, 0);
  assert.ok(g.lockedFor('a') > 0);
  assert.equal(g.tryUnlock('2468', 'a').ok, false, 'locked out even with the right code');
  assert.equal(g.tryUnlock('2468', 'b').ok, true, 'another address is not locked');
  now += 61_000;
  const r = g.tryUnlock('2468', 'a'); assert.equal(r.ok, true);
  assert.ok(g.check(r.token)); now += 1001; assert.ok(!g.check(r.token), 'expired');
  assert.ok(new Gate({ hash: null }).check(undefined), 'no passcode: nothing is gated');
});

test('device tokens: made once, stored as a hash, matched by bearer, revocable', () => {
  const { token, record } = newDeviceToken('phone');
  assert.match(token, /^wd_/); assert.match(record.hash, /^scrypt\$/); assert.ok(!record.hash.includes(token));
  const devices = { phone: record, tablet: newDeviceToken('tablet').record };
  assert.equal(deviceFor(token, devices).name, 'phone');
  assert.equal(deviceFor('wd_nope', devices), null); assert.equal(deviceFor(null, devices), null); assert.equal(deviceFor(token, {}), null);
});

test('tailscale addresses are the 100.64/10 IPv4 ones only', () => {
  assert.deepEqual(tailscaleAddresses({ ts: [{ family: 'IPv4', address: '100.101.1.2' }], en: [{ family: 'IPv4', address: '192.168.1.5' }, { family: 'IPv6', address: 'fd7a::1' }], x: [{ family: 'IPv4', address: '100.200.1.1' }] }), ['100.101.1.2']);
});
