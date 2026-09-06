// Layering of .issue-herd/config.local.json over .issue-herd/config.json.
//
// config.json is committed and shared; config.local.json is gitignored and per machine. The local
// file has the same shape and overrides field by field:
//   - top-level keys (pollSeconds, maxConcurrent, name, …) replace the committed value
//   - "defaults" merges key by key; its onPickup/onDone/onBlocked/onIdle objects merge key by key too
//   - "rules" merge by name: fields of a local rule override the committed rule with the same name
//     (so "enabled": false can switch a rule off on one machine); a name that does not exist in
//     config.json is added as a new rule

const EVENT_KEYS = ['onPickup', 'onDone', 'onBlocked', 'onIdle'];

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Merge one rule or the defaults block: shallow, except the on* event objects merge one level deeper. */
export function mergeRule(base, local) {
  const out = { ...base, ...local };
  for (const k of EVENT_KEYS) if (isObject(base?.[k]) && isObject(local?.[k])) out[k] = { ...base[k], ...local[k] };
  return out;
}

export function mergeConfig(base, local) {
  if (!local) return base;
  const out = { ...base, ...local };
  if (isObject(local.defaults)) out.defaults = mergeRule(base.defaults || {}, local.defaults);
  if (Array.isArray(local.rules)) {
    const rules = (base.rules || []).map((r) => ({ ...r }));
    for (const lr of local.rules) {
      const i = lr.name ? rules.findIndex((r) => r.name === lr.name) : -1;
      if (i === -1) rules.push({ ...lr }); else rules[i] = mergeRule(rules[i], lr);
    }
    out.rules = rules;
  }
  return out;
}

/** Dotted paths of what a local file overrides, for the startup log: "defaults.claimLabel", "rules[ai].enabled", "pollSeconds". */
export function overridePaths(local) {
  const out = [];
  if (!local) return out;
  for (const [k, v] of Object.entries(local)) {
    if (k === 'defaults' && isObject(v)) {
      for (const [dk, dv] of Object.entries(v)) leaf(`defaults.${dk}`, dv);
    } else if (k === 'rules' && Array.isArray(v)) {
      for (const r of v) for (const [rk, rv] of Object.entries(r)) { if (rk !== 'name') leaf(`rules[${r.name ?? '?'}].${rk}`, rv); }
    } else {
      out.push(k);
    }
  }
  return out;
  function leaf(prefix, v) {
    if (isObject(v) && EVENT_KEYS.some((e) => prefix.endsWith('.' + e))) for (const sk of Object.keys(v)) out.push(`${prefix}.${sk}`);
    else out.push(prefix);
  }
}
