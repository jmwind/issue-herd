// Stable identities. `GH-7` and `impl` stay what a person reads; these are what records are keyed by.
//
//   host      this installation (a random id, created once, in the user's weawr directory)
//   team      one repository watched on one host
//   task      one issue within one team, scoped by the tracker's own repository or team
//   roleRun   one role's run on a task — what state.json has always called the run key
//   attempt   one turn of a role run
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { shortHash } from './paths.js';

export interface Identities { hostId: string; teamId: string }

/** The host id, created on first use. `dir` is the user's weawr directory. */
export function hostId(dir: string): string {
  const file = path.join(dir, 'host.json');
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); if (typeof v?.id === 'string' && v.id) return v.id; } catch { /* make one */ }
  const id = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  return id;
}

/** One repository on one host. Stable across renames of the team and across config edits. */
export function teamId(host: string, repo: string): string {
  return shortHash(`${host}|${repo}`, 12);
}

/** What a tracker spec scopes issues to: "github:owner/repo", "linear:TEAM", or the tracker alone. */
export function trackerScope(spec: { type: string; repo?: string; team?: string; host?: string } | null | undefined): string {
  if (!spec) return 'tracker';
  const bits = [spec.type];
  if (spec.host) bits.push(spec.host);
  if (spec.repo) bits.push(spec.repo);
  if (spec.team) bits.push(spec.team);
  return bits.join(':');
}

export function taskId(team: string, scope: string, issueKey: string): string {
  return `${team}/${scope}/${issueKey}`;
}

export function roleRunId(task: string, role: string | null): string {
  return role ? `${task}@${role}` : task;
}

export function attemptId(roleRun: string, pass: number, startedAt: string): string {
  return `${roleRun}#${pass}-${shortHash(startedAt, 6)}`;
}

/**
 * The herdr agent name for a run: the run key, slugified, with the team's short hash so two
 * repositories on one machine with `GH-7@impl` are two agents. herdr names match
 * [a-z][a-z0-9_-]{0,31}. A run that already has a name keeps it — live agents are never renamed.
 */
export function agentNameFor(runKey: string, team: string | null = null): string {
  let s = String(runKey).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(s)) s = 'i-' + s;
  if (!team) return s.slice(0, 32);
  const suffix = `-${team.slice(0, 6)}`;
  return s.slice(0, 32 - suffix.length).replace(/-+$/, '') + suffix;
}
