// @weawr/client — how a browser or a phone talks to `weawr serve`. Portable: fetch and streams
// only, no Node, no DOM beyond what a fetch gives back. The client caches what it was told and
// says how stale it is; it never invents a lifecycle fact and never treats a lost connection as
// success.
import { PROTOCOL_VERSION } from '@weawr/protocol';
import type { Capabilities, ClientCommandName, Envelope, EventView, TeamSnapshot, HostSnapshot, OperationView, TaskView } from '@weawr/protocol';

export { PROTOCOL_VERSION };

export class WeawrError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number | null = null, public readonly retryable: boolean = false) { super(message); }
}

export interface ClientOptions {
  /** Where `weawr serve` answers; '' for the page's own origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** A device token for a native client. A browser relies on its session cookie and origin instead. */
  token?: string | null;
  /** How long one request may take before it is reported as a transport failure. */
  timeoutMs?: number;
}

export interface Subscription { close(): void; readonly cursors: ReadonlyMap<string, number>; readonly connected: boolean }

export interface SubscribeHandlers {
  /** Every team on the host, whenever what is shown changed. */
  onSnapshot?: (snapshot: HostSnapshot) => void;
  /** One structured event, in order, per team. */
  onEvent?: (event: EventView) => void;
  /** A team's cursor expired: the client has refetched its snapshot for you; here is the new one. */
  onResnapshot?: (snapshot: TeamSnapshot, reason: string) => void;
  /** Connection state: connected, or disconnected with the retry delay. What a UI shows as "stale". */
  onStatus?: (status: { connected: boolean; retryInMs?: number; error?: string }) => void;
  /** Any other event the host sends (a development `reload`, say), with its parsed data. */
  onOther?: (event: string, data: unknown) => void;
}

export class WeawrClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  /** The last host snapshot received, and when. A UI shows it with its age; it never pretends it is live. */
  last: { snapshot: HostSnapshot; receivedAt: number } | null = null;

  constructor({ baseUrl = '', fetch: f = globalThis.fetch, token = null, timeoutMs = 20_000 }: ClientOptions = {}) {
    if (!f) throw new Error('WeawrClient needs a fetch implementation');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    // A browser's fetch must be called on its window; a bare reference throws "Illegal invocation".
    this.fetchImpl = f === globalThis.fetch ? f.bind(globalThis) : f;
    this.token = token; this.timeoutMs = timeoutMs;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', 'x-weawr-protocol': String(PROTOCOL_VERSION), ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  /** One request, one envelope. Transport failures and non-envelope answers become WeawrErrors with a code. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}), body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl?.signal, credentials: 'same-origin' } as RequestInit);
    } catch (e: any) {
      throw new WeawrError('transport', `could not reach weawr serve: ${e?.message || e}`, null, true);
    } finally { if (timer) clearTimeout(timer); }
    let env: Envelope<T> | null = null;
    try { env = await res.json() as Envelope<T>; } catch { /* not an envelope */ }
    if (!env || typeof env !== 'object' || !('ok' in env)) throw new WeawrError(res.status === 401 ? 'unauthorized' : 'bad_response', `weawr serve answered ${res.status} without an envelope`, res.status, res.status >= 500);
    if (!env.ok) throw new WeawrError(env.error.code, env.error.message, res.status, !!env.error.retryable);
    return env.result;
  }

  capabilities(): Promise<Capabilities> { return this.request('GET', '/api/v1/capabilities'); }
  teams(): Promise<{ teams: Array<Pick<TeamSnapshot, 'teamId' | 'id' | 'name' | 'repo' | 'tracker' | 'owner' | 'capabilities'>> }> { return this.request('GET', '/api/v1/teams'); }
  async hostSnapshot(): Promise<HostSnapshot> { const s = await this.request<HostSnapshot>('GET', '/api/v1/snapshot'); this.last = { snapshot: s, receivedAt: Date.now() }; return s; }
  snapshot(teamId: string): Promise<TeamSnapshot> { return this.request('GET', `/api/v1/teams/${encodeURIComponent(teamId)}/snapshot`); }
  task(teamId: string, taskKey: string): Promise<TaskView & { attempts: unknown[] }> { return this.request('GET', `/api/v1/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskKey)}`); }
  tail(teamId: string, taskKey: string, lines = 100): Promise<{ blocks: Array<{ run: string; role: string | null; agent: string | null; alive: boolean; phrase: string; text: string | null; source: string; observedAt: string }> }> { return this.request('GET', `/api/v1/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskKey)}/tail?lines=${lines}`); }
  operation(teamId: string, id: string): Promise<OperationView> { return this.request('GET', `/api/v1/teams/${encodeURIComponent(teamId)}/operations/${encodeURIComponent(id)}`); }

  /**
   * A command. Every mutation carries a request id: repeating the call with the same id returns the
   * same operation, so a retry after a lost answer cannot do the thing twice. The answer is the
   * operation record (already terminal for a quick action) plus its result when it has one.
   */
  command<T = unknown>(name: ClientCommandName, body: Record<string, unknown> & { requestId?: string }): Promise<{ operation: OperationView | null; result: T | null }> {
    const requestId = body.requestId ?? newRequestId();
    return this.request('POST', `/api/v1/commands/${name}`, { ...body, requestId });
  }

  /** Poll an operation until it is terminal, or give up after `timeoutMs` (the operation may still finish). */
  async waitForOperation(teamId: string, id: string, { pollMs = 1000, timeoutMs = 120_000 } = {}): Promise<OperationView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const op = await this.operation(teamId, id);
      if (op.status === 'completed' || op.status === 'failed' || op.status === 'partial') return op;
      if (Date.now() >= deadline) return op;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // ---- the actions a console offers, each one command
  taskDone(team: string, task: string, opts: { requestId?: string; expectedRevision?: number } = {}) { return this.command<{ done: boolean; outcomes: unknown[]; error: string | null }>('task.done', { team, task, ...opts }); }
  taskUndo(team: string, task: string, opts: { requestId?: string } = {}) { return this.command<{ done: boolean }>('task.undo', { team, task, ...opts }); }
  taskStop(team: string, task: string, opts: { requestId?: string } = {}) { return this.command<{ outcomes: unknown[] }>('task.stop', { team, task, ...opts }); }
  taskReset(team: string, task: string, opts: { requestId?: string } = {}) { return this.command<{ forgot: string[] }>('task.reset', { team, task, ...opts }); }
  runExit(team: string, run: string, opts: { requestId?: string } = {}) { return this.command<{ outcome: string }>('run.exit', { team, run, ...opts }); }
  tidy(team: string | null = null, opts: { requestId?: string } = {}) { return this.command<{ outcomes: unknown[] }>('team.tidy', { ...(team ? { team } : {}), ...opts }); }

  /**
   * Live updates over server-sent events, with reconnection and per-team cursors. On reconnect
   * the stream resumes after the last cursor seen; when the host says a cursor expired, the client
   * refetches that team's snapshot and tells you. Implemented over fetch's body stream so the
   * same code runs in a browser, in Node, and in a native shell.
   */
  subscribe(handlers: SubscribeHandlers, { initialCursors = new Map<string, number>() }: { initialCursors?: Map<string, number> } = {}): Subscription {
    const cursors = new Map(initialCursors);
    let closed = false; let connected = false; let backoff = 1000; let controller: AbortController | null = null;
    const status = (s: { connected: boolean; retryInMs?: number; error?: string }) => { connected = s.connected; handlers.onStatus?.(s); };
    const connect = async () => {
      if (closed) return;
      controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const q = [...cursors].map(([f, s]) => `${encodeURIComponent(f)}:${s}`).join(',');
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/api/v1/events${q ? `?cursors=${q}` : ''}`, { headers: this.headers({ accept: 'text/event-stream' }), signal: controller?.signal, credentials: 'same-origin' } as RequestInit);
        if (!res.ok || !res.body) throw new WeawrError(res.status === 401 ? 'unauthorized' : 'bad_response', `event stream answered ${res.status}`, res.status, res.status !== 401);
        status({ connected: true }); backoff = 1000;
        for await (const msg of parseSse(res.body)) {
          if (closed) break;
          if (msg.event === 'snapshot') { const snap = JSON.parse(msg.data) as HostSnapshot; this.last = { snapshot: snap, receivedAt: Date.now() }; for (const f of snap.teams) if (!cursors.has(f.teamId) || (cursors.get(f.teamId) ?? 0) < f.revision) cursors.set(f.teamId, f.revision); handlers.onSnapshot?.(snap); }
          else if (msg.event === 'event') { const ev = JSON.parse(msg.data) as EventView; cursors.set(ev.teamId, ev.seq); handlers.onEvent?.(ev); }
          else if (msg.event === 'resnapshot') { const { teamId, reason } = JSON.parse(msg.data); try { const snap = await this.snapshot(teamId); cursors.set(teamId, snap.revision); handlers.onResnapshot?.(snap, reason); } catch (e: any) { status({ connected: true, error: e.message }); } }
          else { let data: unknown = msg.data; try { data = JSON.parse(msg.data); } catch { /* as is */ } handlers.onOther?.(msg.event, data); }
        }
        if (!closed) throw new WeawrError('transport', 'the event stream ended', null, true);
      } catch (e: any) {
        if (closed) return;
        const retryable = !(e instanceof WeawrError) || e.retryable;
        status({ connected: false, retryInMs: retryable ? backoff : undefined, error: e?.message || String(e) });
        if (!retryable) { closed = true; return; }
        await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(backoff * 2, 30_000);
        void connect();
      }
    };
    void connect();
    return { close() { closed = true; controller?.abort(); }, get cursors() { return cursors; }, get connected() { return connected; } };
  }
}

/** A request id a client makes for itself: unique enough, and the same one is reused on a retry. */
export function newRequestId(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Server-sent events off a byte stream: { event, data, id } per message. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string; id: string | null }> {
  const reader = body.getReader(); const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let event = 'message'; let id: string | null = null; const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        const k = line.indexOf(':'); const field = k < 0 ? line : line.slice(0, k); const val = k < 0 ? '' : line.slice(k + 1).replace(/^ /, '');
        if (field === 'event') event = val; else if (field === 'data') data.push(val); else if (field === 'id') id = val;
      }
      if (data.length) yield { event, data: data.join('\n'), id };
    }
  }
}
