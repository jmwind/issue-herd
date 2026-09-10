// How weawr writes on an issue or a pull request. Two voices: a role's agent reporting its own
// work (pickup, result), and the coordinator — the watcher — reporting what it saw (an agent
// blocked, gone, capped; a merge it performed). Every comment says which it is. Facts go in a
// table the tracker renders; prose stays prose.

/** The coordinator's byline. A comment that starts with it was not written by any agent. */
export const COORDINATOR = '**Weawr Coordinator**';

/** How a role signs: "**weawr** as `review`", or plain **weawr** for a team with one role. */
export function roleByline(role: string | null | undefined): string {
  return role ? `**weawr** as \`${role}\`` : '**weawr**';
}

/** One cell: pipes and line breaks would break the table, so they are escaped and folded. */
export function cell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
}

/**
 * A two-column facts table. Rows with an empty value are left out, so callers list what might be
 * known and the table shows what is. Markdown tables need a header row; it is blank here.
 */
export function table(rows: Array<[string, unknown]>): string {
  const kept = rows.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');
  if (!kept.length) return '';
  return ['| | |', '|---|---|', ...kept.map(([k, v]) => `| **${cell(k)}** | ${cell(v)} |`)].join('\n');
}

/** A coordinator comment: the byline, then the text. */
export function coordinator(text: string): string {
  const m = /^(\S+)\s+([\s\S]*)$/.exec(text);
  // Keep the leading icon in front of the byline: "✋ **Weawr Coordinator** — …".
  return m && /^[^\w`*]/.test(m[1]) && m[1].length <= 3 ? `${m[1]} ${COORDINATOR} — ${m[2]}` : `${COORDINATOR} — ${text}`;
}

/** What a rule runs, for a Role row: "rule `tech-lead` · codex `gpt-6-astra` (effort high)". */
export function agentOf(rule: { name?: string; agentKind?: string; model?: string | null; effort?: string | null } | null | undefined): string {
  if (!rule) return '';
  const parts = [`rule \`${rule.name}\``, `${rule.agentKind || 'claude'}${rule.model ? ` \`${rule.model}\`` : ''}${rule.effort ? ` (effort ${rule.effort})` : ''}`];
  return parts.join(' · ');
}
