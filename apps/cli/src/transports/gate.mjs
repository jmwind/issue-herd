// The gate in front of the console.
//
// The console is meant to be read from a phone over Tailscale, and it has a button that stops an
// agent, so nothing about any team is served before a passcode. Tailscale is the network
// boundary; the passcode is the person boundary. The passcode is stored as a salted scrypt hash in
// credentials.json (never in a repository); a correct entry issues an opaque session token carried
// in an HttpOnly cookie; comparisons are constant-time; too many wrong entries from one address
// lock the gate for a while and are reported, so a guess does not go unnoticed.
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPasscode(code) {
  const c = String(code ?? '');
  // The console's keypad is 0-9 and the phone shows a numeric pad, so a passcode is digits.
  if (!/^[0-9]{4,}$/.test(c)) throw new Error('a passcode is at least 4 digits — the console\'s keypad has no letters');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(c, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPasscode(code, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const want = Buffer.from(parts[2], 'base64');
  const got = crypto.scryptSync(String(code ?? ''), salt, want.length, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * Sessions and attempts. `hash` null means no passcode is set: then nothing is gated, and the
 * server binds to loopback only (a console without a gate is a local console).
 */
export class Gate {
  constructor({ hash = null, sessionMs = 24 * 3600e3, maxAttempts = 5, lockoutMs = 5 * 60e3, now = Date.now } = {}) {
    this.hash = hash; this.sessionMs = sessionMs; this.maxAttempts = maxAttempts; this.lockoutMs = lockoutMs; this.now = now;
    this.sessions = new Map(); // token → expiresAt
    this.attempts = new Map(); // address → { count, lockedUntil }
  }

  get enabled() { return !!this.hash; }

  /** Is this address locked out, and for how many more ms? */
  lockedFor(address) {
    const a = this.attempts.get(address);
    if (!a?.lockedUntil) return 0;
    const left = a.lockedUntil - this.now();
    if (left <= 0) { this.attempts.delete(address); return 0; }
    return left;
  }

  /** Try a passcode. Returns { ok, token } or { ok: false, lockedMs, attemptsLeft }. */
  tryUnlock(code, address = 'local') {
    if (!this.enabled) return { ok: true, token: this.issue() };
    const locked = this.lockedFor(address);
    if (locked > 0) return { ok: false, lockedMs: locked, attemptsLeft: 0 };
    if (verifyPasscode(code, this.hash)) { this.attempts.delete(address); return { ok: true, token: this.issue() }; }
    const a = this.attempts.get(address) || { count: 0, lockedUntil: 0 };
    a.count += 1;
    if (a.count >= this.maxAttempts) { a.lockedUntil = this.now() + this.lockoutMs; a.count = 0; }
    this.attempts.set(address, a);
    return { ok: false, lockedMs: a.lockedUntil ? a.lockedUntil - this.now() : 0, attemptsLeft: a.lockedUntil ? 0 : this.maxAttempts - a.count };
  }

  issue() {
    const token = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(token, this.now() + this.sessionMs);
    return token;
  }

  /** A valid, unexpired session token? An ungated console accepts anyone. */
  check(token) {
    if (!this.enabled) return true;
    const exp = this.sessions.get(token);
    if (!exp) return false;
    if (exp <= this.now()) { this.sessions.delete(token); return false; }
    return true;
  }

  revoke(token) { this.sessions.delete(token); }
}

// ---------------------------------------------------------------- device tokens
//
// A phone or another native client cannot send an Origin header a server should believe, and it
// has no cookie jar worth the name. It authenticates with a device token instead: made once with
// `weawr console device add <name>`, shown once, stored here only as a salted hash, sent as
// `Authorization: Bearer …`, and revocable by name.

/** A new token and the record to keep for it. The token itself is never stored. */
export function newDeviceToken(name) {
  const token = 'wd_' + crypto.randomBytes(24).toString('base64url');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(token, salt, 32, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { token, record: { name, hash: `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`, createdAt: new Date().toISOString() } };
}

/** The device a bearer token belongs to, or null. `devices` is { [name]: record }. */
export function deviceFor(token, devices = {}) {
  if (!token || typeof token !== 'string') return null;
  for (const [name, rec] of Object.entries(devices)) if (rec?.hash && verifyPasscode(token, rec.hash)) return { name, ...rec };
  return null;
}
