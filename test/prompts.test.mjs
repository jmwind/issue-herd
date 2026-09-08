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

// GH-59: a PR that drifts into conflicts while a person gets round to reviewing is one nobody can
// merge. The implementer owns keeping it mergeable, and the safe way to do that on a pushed branch
// is a merge of the base — never a rewrite. Keep that in the brief; the watcher's conflict message
// (src/pr.mjs conflictPrompt) points back at it.
test('the implementer brief keeps the PR mergeable until it is merged or closed, by merging the base, never rewriting', () => {
  const brief = read('default.md');
  assert.match(brief, /Keep the PR mergeable until it is merged or closed/);
  assert.match(brief, /git merge origin\/<base>/);
  assert.match(brief, /a merge, never a rebase, never a force-push/);
  assert.match(brief, /Do not rewrite the\s+result file/);
  // The watcher does the noticing; the brief must say so or the model polls GitHub for hours.
  assert.match(brief, /you do not need to poll for it/);
});

test('the reviewing briefs do not carry the implementer\'s keep-mergeable duty', () => {
  for (const name of ['review-lead.md', 'review-usability.md', 'review-security.md']) {
    assert.doesNotMatch(read(name), /Keep the PR mergeable/, `${name} must not tell a reviewer to push merges`);
  }
});
