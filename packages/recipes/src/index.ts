// @weawr/recipes — what a factory tells its agents, as versioned templates.
//
// A recipe is the effective prompt setup of a factory: role templates, the shared result/nudge
// protocol they teach, and the policy that went with them. This package renders and inspects
// templates; it never touches a filesystem, so the same code serves the CLI and a fixture.
import { createHash } from './hash.js';

/** The prompt templates bundled with weawr, by file name under dist/prompts. */
export const BUNDLED_PROMPTS = ['default.md', 'review-lead.md', 'review-security.md', 'review-usability.md', 'smoke.md', 'instructions.example.md'] as const;

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
