// What a run changed, from the worktree itself: free, instant, and there before any PR exists.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

async function git(args, cwd) {
  try { const { stdout } = await execFileP('git', args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }); return stdout.trim(); }
  catch { return null; }
}

/**
 * Lines added and removed, files touched and the commits on `branch` since it left `base`, measured
 * in `cwd` (the run's worktree, or the repository). Returns null when git cannot answer — the
 * worktree is gone, the branch never existed, no commits yet.
 * `head` is the branch tip, so callers can cache on it: nothing changes until it does.
 */
export async function runSize({ cwd, base = 'main', branch }) {
  if (!cwd || !branch) return null;
  const head = await git(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], cwd);
  if (!head) return null;
  const range = `${base}...${branch}`;
  const stat = await git(['diff', '--shortstat', range], cwd);
  const files = await git(['diff', '--name-only', range], cwd);
  const log = await git(['log', '--format=%h%x09%s', '--no-merges', '-n', '12', range], cwd);
  if (stat === null && log === null) return null;
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat || '');
  const list = (files || '').split('\n').filter(Boolean);
  const commits = (log || '').split('\n').filter(Boolean).map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; });
  return {
    head,
    added: m ? Number(m[2] || 0) : 0,
    removed: m ? Number(m[3] || 0) : 0,
    files: m ? Number(m[1]) : list.length,
    paths: list,
    commits,
  };
}

/**
 * A T-shirt size and the reason for it, from nothing but the size facts. Deterministic and
 * explainable; a model's opinion is a later, opt-in, thing.
 */
export function complexity(size) {
  if (!size) return null;
  const lines = size.added + size.removed;
  const dirs = new Set(size.paths.map((p) => p.split('/').slice(0, -1).join('/') || '.'));
  const tests = size.paths.filter((p) => /(^|\/)(test|tests|spec|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)).length;
  const code = size.paths.length - tests;
  const deps = size.paths.some((p) => /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|requirements.*\.txt|pyproject\.toml)$/.test(p));
  const why = [];
  why.push(`${dirs.size} ${dirs.size === 1 ? 'directory' : 'directories'}`);
  if (tests) why.push(`tests ${tests}:${Math.max(code, 0)}`); else if (code) why.push('no tests');
  if (deps) why.push('dependencies touched');
  let grade = 'S';
  if (lines > 120 || dirs.size > 2) grade = 'M';
  if (lines > 400 || dirs.size > 5 || deps) grade = 'L';
  if (lines > 1200 || dirs.size > 10) grade = 'XL';
  return { grade, why: why.join(', ') };
}
