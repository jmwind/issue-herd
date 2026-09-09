// A small runtime schema language, portable and dependency-free. TypeScript types describe what
// we intend; this is what checks what actually arrived — a result file an agent wrote, a request
// a phone sent. Errors name the path and the problem, so the message is the fix.

export type Issue = { path: string; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export interface Schema<T> {
  readonly kind: string;
  check(value: unknown, path: string, issues: Issue[]): T;
  /** For documentation: a one-line description of the shape. */
  describe(): string;
}

class Base<T> implements Schema<T> {
  constructor(readonly kind: string, readonly fn: (v: unknown, p: string, i: Issue[]) => T, readonly desc: string) {}
  check(v: unknown, p: string, i: Issue[]): T { return this.fn(v, p, i); }
  describe(): string { return this.desc; }
}

const at = (p: string) => (p ? p : '(root)');

export const s = {
  string: (opts: { min?: number; max?: number; pattern?: RegExp } = {}) => new Base<string>('string', (v, p, i) => {
    if (typeof v !== 'string') { i.push({ path: at(p), message: `must be a string, not ${typeName(v)}` }); return '' as string; }
    if (opts.min !== undefined && v.length < opts.min) i.push({ path: at(p), message: `must be at least ${opts.min} character(s)` });
    if (opts.max !== undefined && v.length > opts.max) i.push({ path: at(p), message: `must be at most ${opts.max} characters` });
    if (opts.pattern && !opts.pattern.test(v)) i.push({ path: at(p), message: `must match ${opts.pattern}` });
    return v;
  }, 'string'),
  number: (opts: { integer?: boolean; min?: number; max?: number } = {}) => new Base<number>('number', (v, p, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) { i.push({ path: at(p), message: `must be a number, not ${typeName(v)}` }); return 0; }
    if (opts.integer && !Number.isInteger(v)) i.push({ path: at(p), message: 'must be a whole number' });
    if (opts.min !== undefined && v < opts.min) i.push({ path: at(p), message: `must be at least ${opts.min}` });
    if (opts.max !== undefined && v > opts.max) i.push({ path: at(p), message: `must be at most ${opts.max}` });
    return v;
  }, 'number'),
  boolean: () => new Base<boolean>('boolean', (v, p, i) => { if (typeof v !== 'boolean') i.push({ path: at(p), message: `must be true or false, not ${typeName(v)}` }); return !!v; }, 'boolean'),
  literal: <L extends string | number | boolean>(lit: L) => new Base<L>('literal', (v, p, i) => { if (v !== lit) i.push({ path: at(p), message: `must be ${JSON.stringify(lit)}` }); return lit; }, JSON.stringify(lit)),
  enum: <E extends string>(values: readonly E[]) => new Base<E>('enum', (v, p, i) => {
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) i.push({ path: at(p), message: `must be one of ${values.map((x) => JSON.stringify(x)).join(', ')}${typeof v === 'string' ? `, not ${JSON.stringify(v)}` : ''}` });
    return v as E;
  }, `one of ${values.join(' | ')}`),
  optional: <T>(inner: Schema<T>) => new Base<T | undefined>('optional', (v, p, i) => (v === undefined ? undefined : inner.check(v, p, i)), `${inner.describe()}?`),
  nullable: <T>(inner: Schema<T>) => new Base<T | null>('nullable', (v, p, i) => (v === null ? null : inner.check(v, p, i)), `${inner.describe()} | null`),
  /** Present, absent or null all mean "not given". The common shape of a result file's optional fields. */
  maybe: <T>(inner: Schema<T>) => new Base<T | null | undefined>('maybe', (v, p, i) => (v === null || v === undefined ? v : inner.check(v, p, i)), `${inner.describe()}?`),
  array: <T>(inner: Schema<T>, opts: { max?: number } = {}) => new Base<T[]>('array', (v, p, i) => {
    if (!Array.isArray(v)) { i.push({ path: at(p), message: `must be a list, not ${typeName(v)}` }); return []; }
    if (opts.max !== undefined && v.length > opts.max) i.push({ path: at(p), message: `must have at most ${opts.max} entries` });
    return v.map((x, n) => inner.check(x, `${p}[${n}]`, i));
  }, `${inner.describe()}[]`),
  /** One of several shapes: the first that checks without issues wins. */
  union: <T>(alternatives: Array<Schema<T>>) => new Base<T>('union', (v, p, i) => {
    // The first alternative that checks wins. Otherwise report the one whose shape the value has
    // (an issue at the alternative's own root means "wrong shape altogether", not "close").
    let best: Issue[] | null = null; let bestScore = Infinity; let out: T = undefined as T;
    for (const alt of alternatives) {
      const mine: Issue[] = []; const val = alt.check(v, p, mine);
      if (!mine.length) return val;
      const score = mine.some((x) => x.path === at(p)) ? 1e6 + mine.length : mine.length;
      if (score < bestScore) { bestScore = score; best = mine; out = val; }
    }
    i.push(...(best || [])); return out;
  }, alternatives.map((a) => a.describe()).join(' | ')),
  record: <T>(inner: Schema<T>) => new Base<Record<string, T>>('record', (v, p, i) => {
    if (!isObject(v)) { i.push({ path: at(p), message: `must be an object, not ${typeName(v)}` }); return {}; }
    const out: Record<string, T> = {};
    for (const [k, x] of Object.entries(v)) out[k] = inner.check(x, p ? `${p}.${k}` : k, i);
    return out;
  }, `{ [key]: ${inner.describe()} }`),
  /**
   * An object with these fields. Unknown fields are kept (`extra: 'keep'`, the default — a file an
   * agent wrote may carry notes we do not read) or refused (`extra: 'refuse'`, for commands).
   */
  object: <F extends Record<string, Schema<any>>>(fields: F, opts: { extra?: 'keep' | 'refuse' } = {}) => new Base<{ [K in keyof F]: F[K] extends Schema<infer T> ? T : never }>('object', (v, p, i) => {
    if (!isObject(v)) { i.push({ path: at(p), message: `must be an object, not ${typeName(v)}` }); return {} as any; }
    const out: any = {};
    for (const [k, sch] of Object.entries(fields)) out[k] = sch.check((v as any)[k], p ? `${p}.${k}` : k, i);
    for (const k of Object.keys(v)) {
      if (k in fields) continue;
      if (opts.extra === 'refuse') i.push({ path: p ? `${p}.${k}` : k, message: 'is not a field here' });
      else out[k] = (v as any)[k];
    }
    return out;
  }, `{ ${Object.entries(fields).map(([k, f]) => `${k}: ${f.describe()}`).join(', ')} }`),
  any: () => new Base<unknown>('any', (v) => v, 'anything'),
};

export function validate<T>(schema: Schema<T>, value: unknown): Result<T> {
  const issues: Issue[] = [];
  const out = schema.check(value, '', issues);
  return issues.length ? { ok: false, issues } : { ok: true, value: out };
}

/** The issues as one line each, for a log or an error message. */
export function describeIssues(issues: Issue[]): string { return issues.map((i) => `${i.path}: ${i.message}`).join('; '); }

export type Infer<S> = S extends Schema<infer T> ? T : never;

function isObject(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function typeName(v: unknown): string { return v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v; }
