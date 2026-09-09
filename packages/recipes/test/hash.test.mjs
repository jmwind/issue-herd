import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { contentHash, placeholdersOf, renderTemplate } from '../dist/index.js';

test('contentHash is SHA-256, checked against Node\'s', () => {
  for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'brief '.repeat(300), 'ünïcödé — ✓']) {
    assert.equal(contentHash(s), crypto.createHash('sha256').update(s).digest('hex'), JSON.stringify(s.slice(0, 20)));
  }
});

test('renderTemplate substitutes, and placeholdersOf lists what a template needs', () => {
  assert.equal(renderTemplate('Hi {{ name }}, {{missing}}!', { name: 'x' }), 'Hi x, !');
  assert.deepEqual(placeholdersOf('{{a}} {{ b }} {{a}}'), ['a', 'b']);
});
