import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, newerVersion } from '../src/version.mjs';

test('compareVersions orders numerically', () => {
  assert.ok(compareVersions('0.1.2', '0.1.1') > 0);
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0);
  assert.equal(compareVersions('0.1.1', '0.1.1'), 0);
  assert.ok(compareVersions('0.1.0', '0.1.1') < 0);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), 0);
});

const fake = (body, ok = true) => async () => ({ ok, json: async () => body });

test('newerVersion reports only a strictly newer version', async () => {
  assert.equal(await newerVersion('0.1.1', { fetchImpl: fake({ version: '0.1.2' }) }), '0.1.2');
  assert.equal(await newerVersion('0.1.2', { fetchImpl: fake({ version: '0.1.2' }) }), null);
  assert.equal(await newerVersion('0.2.0', { fetchImpl: fake({ version: '0.1.9' }) }), null);
});

test('newerVersion is silent on network or server trouble', async () => {
  assert.equal(await newerVersion('0.1.1', { fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await newerVersion('0.1.1', { fetchImpl: fake({}, false) }), null);
  assert.equal(await newerVersion('0.1.1', { fetchImpl: fake({ nope: true }) }), null);
});

test('newerVersion honours the opt-out', async () => {
  process.env.WEAWR_NO_UPDATE_CHECK = '1';
  try { assert.equal(await newerVersion('0.1.1', { fetchImpl: fake({ version: '9.9.9' }) }), null); }
  finally { delete process.env.WEAWR_NO_UPDATE_CHECK; }
});
