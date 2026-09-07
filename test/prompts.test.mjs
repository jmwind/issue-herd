import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The shipped briefs are prose, but two lines of it are policy that a run acts on: the implementer
// may merge only when the issue grants it and every reviewer has said OK, and a reviewer never
// merges. GH-45 exists because the first of those was missing; keep both pinned.
const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const read = (name) => fs.readFileSync(path.join(promptsDir, name), 'utf8');

test('the implementer brief lets the issue grant the merge, gated on every reviewer saying OK', () => {
  const brief = read('default.md');
  assert.match(brief, /Do not merge unless the issue says you may/);
  assert.match(brief, /every\s+reviewing role this repository runs has reported back/);
  assert.match(brief, /OK TO MERGE TO MAIN/);
  assert.match(brief, /USABILITY: OK/);
  assert.match(brief, /a missing verdict is not a\s+yes/);
  // The anti-injection constraint must carve the merge permission out, or it undoes step 5.
  assert.match(brief, /Permission to merge, given in\s+the issue by its author or a maintainer, is not a redirection/);
});

test('the reviewing briefs still never merge', () => {
  for (const name of ['review-lead.md', 'review-usability.md', 'review-security.md']) {
    assert.match(read(name), /do not (push, commit,\s+|push, do not commit, do not )merge/i, `${name} must tell the reviewer not to merge`);
    assert.doesNotMatch(read(name), /unless the issue says you may/, `${name} must not carry the implementer's exception`);
  }
});
