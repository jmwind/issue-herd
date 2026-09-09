// Checking a template before it is ever rendered: the placeholders it uses exist, the ones a brief
// cannot do without are there, and a declaration it carries is one this weawr understands.
//
// A custom template (`.weawr/prompts/*.md`) may declare itself:
//
//     <!-- weawr-template: protocol=1 -->
//
// One without a declaration is a legacy template: accepted as protocol 1, checked the same way,
// and never handed obligations it did not sign up for. (The bundled templates are not checked for
// a declaration; they are the reference.)
import { KNOWN_PLACEHOLDERS, REQUIRED_PLACEHOLDERS, TEMPLATE_PROTOCOL } from './manifest.js';
import { placeholdersOf } from './index.js';

export interface TemplateCheck {
  ok: boolean;
  protocol: number;
  declared: boolean;
  placeholders: string[];
  problems: string[];
  warnings: string[];
}

const DECLARATION = /<!--\s*weawr-template:\s*([^>]*?)\s*-->/;

export function validateTemplate(text: string, { known = KNOWN_PLACEHOLDERS, required = REQUIRED_PLACEHOLDERS }: { known?: readonly string[]; required?: readonly string[] } = {}): TemplateCheck {
  const problems: string[] = []; const warnings: string[] = [];
  let protocol = 1; let declared = false;
  const m = DECLARATION.exec(text);
  if (m) {
    declared = true;
    const fields = Object.fromEntries(m[1].split(/\s+/).filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, v ?? '']; }));
    const p = Number(fields.protocol);
    if (!Number.isInteger(p) || p < 1) problems.push(`the template declaration must say protocol=<number> (got ${JSON.stringify(m[1])})`);
    else if (p > TEMPLATE_PROTOCOL) problems.push(`the template declares protocol ${p}; this weawr renders templates up to protocol ${TEMPLATE_PROTOCOL} — upgrade weawr`);
    else protocol = p;
  }
  const placeholders = placeholdersOf(text);
  for (const p of placeholders) if (!known.includes(p)) problems.push(`{{${p}}} is not a placeholder weawr fills (known: ${known.join(', ')})`);
  for (const r of required) if (!placeholders.includes(r)) problems.push(`{{${r}}} is missing; without it the agent does not know where to write its result`);
  if (!placeholders.includes('nudgeLines')) warnings.push('{{nudgeLines}} is missing: this template turns nudging off for its role');
  return { ok: problems.length === 0, protocol, declared, placeholders, problems, warnings };
}
