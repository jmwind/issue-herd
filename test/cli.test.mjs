// The CLI as a process, in a throwaway repository. bin/issue-herd.mjs runs main() on import, so the
// guards that live there — what a repository's config and .env are allowed to do — can only be
// tested this way. These are the checks that stop a repository you cloned from stealing your token,
// so they are worth the cost of a subprocess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/issue-herd.mjs', import.meta.url));

/** A git repository with the given files, cleaned up when the test ends. */
function repo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-herd-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

/** Run the CLI in `dir`. Returns { status, out } with stdout and stderr merged. */
function run(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, ISSUE_HERD_NO_UPDATE_CHECK: '1', ...env },
  });
  return { status: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const config = (extra = {}) => JSON.stringify({ tracker: 'linear', rules: [{ name: 'r', match: 'any:true' }], ...extra });

test('a repository .env cannot move where credentials are read and written', (t) => {
  // Reproduced before the fix: `logout` reported the path the repository chose. .env is committed,
  // so honouring it would let a clone redirect a freshly minted token into its own working tree.
  const dir = repo(t, { '.issue-herd/config.json': config(), '.env': 'ISSUE_HERD_CREDENTIALS=./stolen.json\nLINEAR_API_KEY=lin_api_fromenv\n' });
  const mine = path.join(dir, 'mine.json');
  const r = run(dir, ['logout', 'linear'], { ISSUE_HERD_CREDENTIALS: mine });
  assert.equal(r.status, 0);
  assert.match(r.out, /mine\.json/);
  assert.doesNotMatch(r.out, /stolen\.json/);
  assert.match(r.out, /ignoring ISSUE_HERD_CREDENTIALS/);
});

test('a repository .env still supplies the tracker token, which is what it is for', (t) => {
  const dir = repo(t, { '.issue-herd/config.json': config(), '.env': 'LINEAR_API_KEY=lin_api_fromenv\n' });
  // `match` gets as far as calling Linear, which fails on the fake key — proof the key was read.
  const r = run(dir, ['match', 'any:true']);
  assert.match(r.out, /Linear HTTP 4\d\d|fetch failed/);
  assert.doesNotMatch(r.out, /no Linear credentials/);
});

test('a config cannot read a file outside .issue-herd into the agent brief', (t) => {
  // `"instructionsFile": "~/.config/issue-herd/credentials.json"` used to resolve and be pasted
  // into brief.md, inside the working tree the unattended agent commits from.
  for (const bad of ['/etc/hosts', '../../secrets.txt', '../.git/config']) {
    const dir = repo(t, { '.issue-herd/config.json': config({ defaults: { instructionsFile: bad } }) });
    const r = run(dir, ['status']);
    assert.equal(r.status, 1, bad);
    assert.match(r.out, /must stay inside \.issue-herd/, bad);
  }
});

test('a leading ~ is a directory name, not the home directory', (t) => {
  // The interesting half of the same guard: "~/.config/issue-herd/credentials.json" resolves to a
  // literal "~" folder under .issue-herd/, so it reads nothing and the run carries on with no
  // instructions — rather than pasting the real credentials file into the brief.
  const dir = repo(t, { '.issue-herd/config.json': config({ defaults: { instructionsFile: '~/.config/issue-herd/credentials.json' } }) });
  const r = run(dir, ['status']);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.out, /token/i);
});

test('a config path inside .issue-herd is still fine', (t) => {
  const dir = repo(t, { '.issue-herd/config.json': config(), '.issue-herd/instructions.md': 'be careful\n' });
  assert.equal(run(dir, ['status']).status, 0);
});

test('a tracker name that is an Object property is not a tracker', (t) => {
  for (const bad of ['constructor', '__proto__', 'toString']) {
    const dir = repo(t, { '.issue-herd/config.json': config({ tracker: bad }) });
    const r = run(dir, ['status']);
    assert.equal(r.status, 1, bad);
    assert.match(r.out, /unknown tracker/, bad);
  }
});

test('init refuses --tracker with no value instead of silently choosing Linear', (t) => {
  const dir = repo(t, {});
  const r = run(dir, ['init', '--tracker']);
  assert.equal(r.status, 1);
  assert.match(r.out, /--tracker needs a name/);
});

test('init run again keeps the tracker the repository already uses', (t) => {
  const dir = repo(t, {});
  assert.equal(run(dir, ['init', '--tracker', 'github']).status, 0);
  const again = run(dir, ['init']);
  assert.match(again.out, /already initialised/);
  // the second run must not append a Linear stanza to .env.example
  const example = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
  assert.match(example, /GITHUB_TOKEN=/);
  assert.doesNotMatch(example, /LINEAR_API_KEY/);
});

test('init warns when the .env.local it just recommended would be committed', (t) => {
  const dir = repo(t, {});
  const bare = run(dir, ['init', '--tracker', 'linear']);
  assert.match(bare.out, /\.env\.local is not gitignored/);
  const dir2 = repo(t, { '.gitignore': '.env.local\n' });
  assert.doesNotMatch(run(dir2, ['init', '--tracker', 'linear']).out, /not gitignored/);
});

test('a role that could not be a label, a branch and a directory is refused by name', (t) => {
  const dir = repo(t, { '.issue-herd/config.json': JSON.stringify({ tracker: 'linear', rules: [{ name: 'rev', match: 'any:true', role: 'code review' }] }) });
  const r = run(dir, ['status']);
  assert.equal(r.status, 1);
  assert.match(r.out, /rule "rev": role "code review"/);
});

test('two roles pointed at one branch template fail at load, not on the second pickup', (t) => {
  // git cannot check one branch out into two worktrees. Reported here, where the fix is one line.
  const rules = [
    { name: 'impl', match: 'label:ai', role: 'impl' },
    { name: 'rev', match: 'label:ai', role: 'review' },
  ];
  const bad = repo(t, { '.issue-herd/config.json': JSON.stringify({ tracker: 'linear', defaults: { branch: '{{issueBranchName}}' }, rules }) });
  const r = run(bad, ['status']);
  assert.equal(r.status, 1);
  assert.match(r.out, /both work on branch/);
  // the default template names the role, so the same two rules are fine on it
  const ok = repo(t, { '.issue-herd/config.json': JSON.stringify({ tracker: 'linear', rules }) });
  assert.equal(run(ok, ['status']).status, 0);
});

test('"roles" switches roles on and off for the project without deleting the rules', (t) => {
  const rules = [{ name: 'impl', match: 'label:ai', role: 'impl' }, { name: 'rev', match: 'label:ai', role: 'review' }];
  const dir = repo(t, { '.issue-herd/config.json': JSON.stringify({ tracker: 'linear', roles: ['impl'], rules }) });
  // `match` reaches the tracker, so the config was accepted and the disabled rule is still a rule.
  const r = run(dir, ['match', 'any:true'], { LINEAR_API_KEY: 'lin_api_nope' });
  assert.match(r.out, /Linear HTTP 4\d\d|fetch failed/);
  const bad = repo(t, { '.issue-herd/config.json': JSON.stringify({ tracker: 'linear', roles: 'impl', rules }) });
  assert.match(run(bad, ['status']).out, /"roles" must be an array/);
});

test('reset by issue key forgets every role\'s run on it; by run key, only that one', (t) => {
  const runs = {
    'GH-7': { rule: 'r', status: 'done', startedAt: '2026-01-01T00:00', title: 'a' },
    'GH-7@review': { rule: 'r', role: 'review', status: 'done', startedAt: '2026-01-01T00:00', title: 'a' },
    'GH-7@impl': { rule: 'r', role: 'impl', status: 'done', startedAt: '2026-01-01T00:00', title: 'a' },
    'GH-70': { rule: 'r', status: 'done', startedAt: '2026-01-01T00:00', title: 'b' },
  };
  const state = () => JSON.stringify({ runs });
  const one = repo(t, { '.issue-herd/config.json': config(), '.issue-herd/state/state.json': state() });
  const r = run(one, ['reset', 'GH-7@review']);
  assert.match(r.out, /forgot GH-7@review/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(one, '.issue-herd/state/state.json'), 'utf8')).runs).sort(),
    ['GH-7', 'GH-70', 'GH-7@impl']);

  const all = repo(t, { '.issue-herd/config.json': config(), '.issue-herd/state/state.json': state() });
  const r2 = run(all, ['reset', 'GH-7']);
  assert.match(r2.out, /forgot GH-7, GH-7@review, GH-7@impl/);
  // GH-70 is a different issue, not a role of GH-7
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(all, '.issue-herd/state/state.json'), 'utf8')).runs), ['GH-70']);

  assert.match(run(all, ['reset', 'GH-9']).out, /no run called GH-9/);
});

test('"basedOn" names another role, checked at config load', (t) => {
  const rules = (basedOn) => [
    { name: 'impl', match: 'label:ai', role: 'impl' },
    { name: 'rev', match: 'label:ai', role: 'review', basedOn },
  ];
  const ok = repo(t, { '.issue-herd/config.json': JSON.stringify({ tracker: 'linear', rules: rules('impl') }) });
  assert.equal(run(ok, ['status']).status, 0);

  const bad = repo(t, { '.issue-herd/config.json': JSON.stringify({ tracker: 'linear', rules: rules('code review') }) });
  assert.match(run(bad, ['status']).out, /rule "rev" \("basedOn"\): role "code review"/);

  // a worktree cannot start from itself
  const self = repo(t, { '.issue-herd/config.json': JSON.stringify({ tracker: 'linear', rules: rules('review') }) });
  assert.match(run(self, ['status']).out, /"basedOn" is its own role/);
});

test('"basedOn" is refused where issue-herd does not make the worktree', (t) => {
  // It can only decide where a worktree starts if it is the one creating it. Accepted quietly in
  // the other modes, it would give you a reviewer on the default branch and a config saying
  // otherwise — the config is wrong, and this is the only moment that is cheap to say so.
  for (const mode of ['herdr', 'none']) {
    const dir = repo(t, {
      '.issue-herd/config.json': JSON.stringify({
        tracker: 'linear',
        rules: [{ name: 'impl', match: 'label:ai', role: 'impl' },
          { name: 'rev', match: 'label:ai', role: 'review', basedOn: 'impl', worktree: mode }],
      }),
    });
    const r = run(dir, ['status']);
    assert.equal(r.status, 1, mode);
    assert.match(r.out, /"basedOn" needs "worktree": "self"/, mode);
  }
});
