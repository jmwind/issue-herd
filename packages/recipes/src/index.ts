// @weawr/recipes — what a factory tells its agents, as versioned templates.
//
// A recipe is the effective prompt setup of a factory: role templates, the shared result/nudge
// protocol they teach, and the policy that went with them. This package renders and inspects
// templates; it never touches a filesystem, so the same code serves the CLI and a fixture.
import { createHash } from './hash.js';

export { RECIPE_ID, RECIPE_REVISIONS, LATEST_REVISION, KNOWN_PLACEHOLDERS, REQUIRED_PLACEHOLDERS, TEMPLATE_PROTOCOL, revision } from './manifest.js';
export type { RecipeRevision } from './manifest.js';
export { validateTemplate } from './validate.js';
export type { TemplateCheck } from './validate.js';

/**
 * A line-level diff of two templates for a person to read before an upgrade: `-` lines are the
 * old revision's, `+` the new one's, context around them. Simple and honest rather than minimal.
 */
export function diffTemplates(before: string, after: string, context = 2): string {
  const a = before.split('\n'); const b = after.split('\n');
  // longest common subsequence over lines
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Array<[' ' | '-' | '+', string]> = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  const keep = new Set<number>();
  ops.forEach(([op], k) => { if (op !== ' ') for (let d = -context; d <= context; d++) keep.add(k + d); });
  const out: string[] = []; let last = -2;
  ops.forEach(([op, line], k) => { if (!keep.has(k)) return; if (k !== last + 1 && out.length) out.push('…'); out.push(`${op} ${line}`); last = k; });
  return out.join('\n');
}

/** The placeholders a template may use: `{{ name }}`. Unknown names render as nothing. */
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/** Substitute `{{name}}` with `vars[name]` (empty for a missing variable). */
export function renderTemplate(template: string, vars: Record<string, string | undefined | null>): string {
  return template.replace(PLACEHOLDER, (_, k: string) => (vars[k] ?? ''));
}

/** Every placeholder name a template uses, in order of first appearance. */
export function placeholdersOf(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) seen.add(m[1]);
  return [...seen];
}

/** A content hash for a template or a rendered brief: what an attempt records to say which words it was given. */
export function contentHash(text: string): string { return createHash(text); }
