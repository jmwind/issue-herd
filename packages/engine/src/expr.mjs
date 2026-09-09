// Rule expression language for weawr.
//
//   label:ai and project:Webapp and not assignee:none
//   (label:ai or label:agent) team:ENG priority>=3
//   state:started assignee:me
//
// Grammar
//   expr    := or
//   or      := and ( "or" and )*
//   and     := not ( ["and"] not )*        -- adjacency is an implicit AND
//   not     := "not" not | primary
//   primary := "(" expr ")" | term
//   term    := FIELD OP VALUE
//   OP      := ":" | "=" | "!=" | "<" | "<=" | ">" | ">="
//   VALUE   := bareword | "quoted string" | 'quoted string'
//
// Matching is case-insensitive. `*` in a value is a glob wildcard.
//
// Fields (all read from the normalized issue a tracker produces, see src/tracker.mjs; GitHub maps
// its milestone to `project` and the repository to `team`, and has only open/closed states):
//   label        any label name                         label:ai   label:"needs *"
//   project      project name                           project:Webapp
//   team         team key or team name                  team:ENG   team:Engineering
//   assignee     me | none | name | displayName | email | @login   assignee:me   assignee:none
//   creator      me | name | displayName | email | @login
//   state        workflow state name or type            state:Todo  state:started
//                types: triage backlog unstarted started completed canceled
//   priority     0 none 1 urgent 2 high 3 medium 4 low  priority:urgent  priority<=2
//                (numeric comparisons use Linear's scale, where 1 is most urgent
//                and 0 is "no priority"; 0 is treated as 5 so priority<=2 excludes it)
//   estimate     points                                 estimate<=3
//   title        substring or glob on the title         title:*crash*
//   id | key     issue identifier                       key:ENG-123
//   cycle        current | none | number                cycle:current
//   age          time since createdAt, e.g. 2h 3d 1w    age>1d
//   updated      time since updatedAt                   updated<2h
//   any          matches every issue                    any:true

const PRIORITY_WORDS = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 };
const OPS = new Set([':', '=', '!=', '<', '<=', '>', '>=']);

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { tokens.push({ t: c }); i++; continue; }
    if (c === '"' || c === "'") {
      const q = c; let j = i + 1; let s = '';
      while (j < n && src[j] !== q) { s += src[j]; j++; }
      if (j >= n) throw new SyntaxError(`unterminated quote at ${i} in: ${src}`);
      tokens.push({ t: 'value', v: s }); i = j + 1; continue;
    }
    if (c === '!' && src[i + 1] === '=') { tokens.push({ t: 'op', v: '!=' }); i += 2; continue; }
    if ((c === '<' || c === '>') && src[i + 1] === '=') { tokens.push({ t: 'op', v: c + '=' }); i += 2; continue; }
    if (c === ':' || c === '=' || c === '<' || c === '>') { tokens.push({ t: 'op', v: c }); i++; continue; }
    // bareword: up to whitespace, paren, or operator start
    let j = i; let s = '';
    while (j < n && !/[\s()]/.test(src[j]) && !(src[j] === ':' || src[j] === '=' || src[j] === '<' || src[j] === '>' || (src[j] === '!' && src[j + 1] === '='))) { s += src[j]; j++; }
    if (s === '') throw new SyntaxError(`unexpected character '${c}' at ${i} in: ${src}`);
    const lower = s.toLowerCase();
    if (lower === 'and' || lower === 'or' || lower === 'not') tokens.push({ t: lower });
    else tokens.push({ t: 'word', v: s });
    i = j;
  }
  return tokens;
}

export function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === 'or') { next(); left = { k: 'or', l: left, r: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.t === 'and') { next(); left = { k: 'and', l: left, r: parseNot() }; continue; }
      if (t.t === 'word' || t.t === 'not' || t.t === '(') { left = { k: 'and', l: left, r: parseNot() }; continue; }
      break;
    }
    return left;
  }
  function parseNot() {
    if (peek() && peek().t === 'not') { next(); return { k: 'not', e: parseNot() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = next();
    if (!t) throw new SyntaxError(`unexpected end of expression: ${src}`);
    if (t.t === '(') {
      const e = parseOr();
      const close = next();
      if (!close || close.t !== ')') throw new SyntaxError(`expected ')' in: ${src}`);
      return e;
    }
    if (t.t !== 'word') throw new SyntaxError(`expected a field, got '${t.v ?? t.t}' in: ${src}`);
    const field = t.v.toLowerCase();
    const op = next();
    if (!op || op.t !== 'op' || !OPS.has(op.v)) throw new SyntaxError(`expected an operator after '${field}' in: ${src}`);
    const val = next();
    if (!val || (val.t !== 'word' && val.t !== 'value')) throw new SyntaxError(`expected a value after '${field}${op.v}' in: ${src}`);
    return { k: 'term', field, op: op.v === '=' ? ':' : op.v, value: val.v };
  }

  const ast = parseOr();
  if (p < toks.length) throw new SyntaxError(`unexpected '${toks[p].v ?? toks[p].t}' in: ${src}`);
  return ast;
}

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

function strMatch(candidates, value) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter((x) => x != null).map(String);
  if (value.includes('*') || value.includes('?')) { const re = globToRegExp(value); return list.some((c) => re.test(c)); }
  const v = value.toLowerCase();
  return list.some((c) => c.toLowerCase() === v);
}

function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d|w)?$/i.exec(s.trim());
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'h').toLowerCase();
  const ms = { m: 60e3, min: 60e3, h: 3600e3, hr: 3600e3, d: 86400e3, w: 7 * 86400e3 }[unit];
  return n * ms;
}

function numCompare(op, actual, expected) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  switch (op) {
    case ':': return actual === expected;
    case '!=': return actual !== expected;
    case '<': return actual < expected;
    case '<=': return actual <= expected;
    case '>': return actual > expected;
    case '>=': return actual >= expected;
    default: return false;
  }
}

function person(p, value, ctx) {
  const v = value.toLowerCase();
  if (v === 'none' || v === 'unassigned' || v === 'nobody') return !p;
  if (!p) return false;
  if (v === 'me') {
    const me = ctx.viewer;
    return Boolean(me && (p.id === me.id || (p.login && p.login === me.login) || (p.email && p.email.toLowerCase() === (me.email || '').toLowerCase())));
  }
  return strMatch([p.name, p.displayName, p.email, p.login], value.replace(/^@/, ''));
}

/** Evaluate a term against a normalized issue. `ctx.viewer` is {id,email}; `ctx.now` is ms. */
function evalTerm(term, issue, ctx) {
  const { field, op, value } = term;
  const eq = (actual) => { const r = strMatch(actual, value); return op === '!=' ? !r : r; };
  const now = ctx.now ?? Date.now();
  switch (field) {
    case 'any': return true;
    case 'label': case 'labels': case 'tag': case 'tags': return eq(issue.labels);
    case 'project': return eq(issue.project ? [issue.project.name] : []);
    case 'team': return eq(issue.team ? [issue.team.key, issue.team.name] : []);
    case 'assignee': case 'assigned': { const r = person(issue.assignee, value, ctx); return op === '!=' ? !r : r; }
    case 'creator': case 'author': { const r = person(issue.creator, value, ctx); return op === '!=' ? !r : r; }
    case 'state': case 'status': return eq(issue.state ? [issue.state.name, issue.state.type] : []);
    case 'title': {
      const t = issue.title || '';
      let r;
      if (value.includes('*') || value.includes('?')) r = globToRegExp(value).test(t);
      else r = t.toLowerCase().includes(value.toLowerCase());
      return op === '!=' ? !r : r;
    }
    case 'id': case 'key': case 'identifier': return eq([issue.identifier]);
    case 'priority': {
      let expected = PRIORITY_WORDS[value.toLowerCase()];
      if (expected === undefined) expected = parseInt(value, 10);
      let actual = issue.priority ?? 0;
      if (op === ':' || op === '!=') return numCompare(op, actual, expected);
      // ordering: treat "no priority" (0) as lowest so priority<=2 means urgent or high
      if (actual === 0) actual = 5;
      if (expected === 0) expected = 5;
      return numCompare(op, actual, expected);
    }
    case 'estimate': case 'points': return numCompare(op, issue.estimate ?? NaN, parseFloat(value));
    case 'cycle': {
      const v = value.toLowerCase();
      let r;
      if (v === 'none') r = !issue.cycle;
      else if (v === 'current' || v === 'active') r = !!issue.cycle && !!issue.cycle.isActive;
      else r = !!issue.cycle && String(issue.cycle.number) === v;
      return op === '!=' ? !r : r;
    }
    case 'age': return numCompare(op, now - Date.parse(issue.createdAt), parseDuration(value));
    case 'updated': return numCompare(op, now - Date.parse(issue.updatedAt), parseDuration(value));
    default: throw new SyntaxError(`unknown field '${field}'`);
  }
}

export function evaluate(ast, issue, ctx = {}) {
  switch (ast.k) {
    case 'or': return evaluate(ast.l, issue, ctx) || evaluate(ast.r, issue, ctx);
    case 'and': return evaluate(ast.l, issue, ctx) && evaluate(ast.r, issue, ctx);
    case 'not': return !evaluate(ast.e, issue, ctx);
    case 'term': return evalTerm(ast, issue, ctx);
    default: throw new Error(`bad node ${ast.k}`);
  }
}

/** Compile once, match many. Throws SyntaxError on a bad expression. */
export function compile(src) {
  const ast = parse(src);
  return { src, ast, test: (issue, ctx) => evaluate(ast, issue, ctx) };
}
