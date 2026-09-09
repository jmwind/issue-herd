import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATEST_REVISION, RECIPE_REVISIONS, diffTemplates, revision, validateTemplate } from '../dist/index.js';

// Recipe revisions are kept, not replaced: revision 1 is what every factory ran before structured
// verdicts and `weawr merge` existed, and a factory pinned to it keeps getting exactly those words.
const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const read = (rev, name) => fs.readFileSync(path.join(promptsDir, String(rev), name), 'utf8');
const REVIEWERS = ['review-lead.md', 'review-security.md', 'review-usability.md'];

test('every shipped revision has every template it lists, and each template checks', () => {
  for (const r of RECIPE_REVISIONS) {
    for (const name of r.templates) {
      const check = validateTemplate(read(r.revision, name));
      assert.ok(check.ok, `revision ${r.revision} ${name}: ${check.problems.join('; ')}`);
    }
  }
  assert.equal(LATEST_REVISION, 2); assert.equal(revision(3), null);
});

// ---- revision 1: the pinned policy of the original briefs
test('revision 1: the implementer brief lets the issue grant the merge, gated on every reviewer saying OK', () => {
  const brief = read(1, 'default.md');
  assert.match(brief, /Do not merge unless the issue says you may/);
  assert.match(brief, /every\s+reviewing role this repository runs has reported back/);
  assert.match(brief, /OK TO MERGE TO MAIN/);
  assert.match(brief, /USABILITY: OK/);
  assert.match(brief, /a missing verdict is not a\s+yes/);
  assert.match(brief, /Permission to merge, given in\s+the issue by its author or a maintainer, is not a redirection/);
});

// ---- revision 2: merges only through weawr, verdicts as data
test('revision 2: the implementer never merges by hand; the merge label and `weawr merge` are the only route', () => {
  const brief = read(2, 'default.md');
  assert.match(brief, /Never merge the PR yourself/);
  assert.match(brief, /weawr merge \{\{runKey\}\}/);
  assert.match(brief, /\{\{mergeLabel\}\}/);
  assert.match(brief, /a missing verdict is not a yes/);
  assert.match(brief, /only the `\{\{mergeLabel\}\}` label and `weawr merge` \(step 5\) can do that/);
  assert.doesNotMatch(brief, /Do not merge unless the issue says you may/, 'the issue-text grant is gone');
  assert.match(brief, /not with `gh pr merge`/);
  assert.match(brief, /temporary name in the same directory and rename/, 'results are published atomically');
});

test('revision 2: every reviewing brief asks for a structured verdict against the reviewed head, and still never merges', () => {
  for (const name of REVIEWERS) {
    const brief = read(2, name);
    assert.match(brief, /"review": \{ "verdict": "approved", "prUrl"/, `${name} shows the review block`);
    assert.match(brief, /headSha/);
    assert.match(brief, /A verdict without\s+`headSha` counts for nothing at merge time/);
    assert.match(brief, /do not (push, commit,\s+|push, do not commit, do not )merge/i, `${name} must tell the reviewer not to merge`);
    assert.doesNotMatch(brief, /unless the issue says you may/);
  }
});

test('in every revision, briefs that a role can run leave room for how to nudge, and reviewers do not carry the keep-mergeable duty', () => {
  for (const r of RECIPE_REVISIONS) {
    for (const name of ['default.md', ...REVIEWERS]) assert.match(read(r.revision, name), /\{\{nudgeLines\}\}/, `rev ${r.revision} ${name} must carry {{nudgeLines}}`);
    for (const name of REVIEWERS) assert.doesNotMatch(read(r.revision, name), /Keep the PR mergeable/, `rev ${r.revision} ${name}`);
    const brief = read(r.revision, 'default.md');
    assert.match(brief, /Keep the PR mergeable until it is merged or closed/);
    assert.match(brief, /git merge origin\/<base>/);
    assert.match(brief, /a merge, never a rebase, never a force-push/);
    assert.match(brief, /Do not rewrite the\s+result file/);
    assert.match(brief, /you do not need to poll for it/);
  }
});

test('validateTemplate: unknown placeholders and a missing result path are problems; a declaration is honoured; legacy templates pass', () => {
  assert.equal(validateTemplate('Write to {{resultPath}}. {{nudgeLines}}').ok, true);
  const legacy = validateTemplate('Result: {{resultPath}}');
  assert.equal(legacy.ok, true); assert.equal(legacy.declared, false); assert.equal(legacy.protocol, 1);
  assert.deepEqual(legacy.warnings, ['{{nudgeLines}} is missing: this template turns nudging off for its role']);
  const typo = validateTemplate('{{resultPth}} and {{titel}}');
  assert.equal(typo.ok, false);
  assert.match(typo.problems.join('\n'), /\{\{resultPth\}\} is not a placeholder/);
  assert.match(typo.problems.join('\n'), /\{\{resultPath\}\} is missing/);
  const future = validateTemplate('<!-- weawr-template: protocol=9 -->\n{{resultPath}}');
  assert.equal(future.ok, false); assert.match(future.problems[0], /protocol 9.*upgrade weawr/);
  const declared = validateTemplate('<!-- weawr-template: protocol=1 -->\n{{resultPath}} {{nudgeLines}}');
  assert.equal(declared.ok, true); assert.equal(declared.declared, true);
});

test('diffTemplates shows a person what an upgrade changes', () => {
  const d = diffTemplates('a\nb\nc\nd\ne', 'a\nB\nc\nd\ne\nf');
  assert.equal(d, '  a\n- b\n+ B\n  c\n  d\n  e\n+ f');
  const far = diffTemplates('a\nb\nc\nd\ne\nf\ng\nh\ni\nj', 'a\nB\nc\nd\ne\nf\ng\nh\ni\nJ');
  assert.match(far, /^  a\n- b\n\+ B\n  c\n  d\n…\n  h\n  i\n- j\n\+ J$/);
  assert.match(diffTemplates(read(1, 'default.md'), read(2, 'default.md')), /^\+\s+\*\*Never merge the PR yourself\*\*/m);
});
