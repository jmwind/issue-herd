// Which coding agent a rule runs, and how to say the same thing to each of them.
//
// herdr can start twenty-odd agents (`herdr agent start --kind`), and it is the one that knows how
// to detect them in a pane. What it does not do is translate: everything after `--` is the agent's
// own command line, and issue-herd used to write Claude Code's dialect there unconditionally. So
// `"agentKind": "codex"` started codex and immediately handed it `--name` and `--permission-mode`,
// which are Claude Code flags, and the pane died at the prompt.
//
// A rule says what it wants in four words — name, permission mode, model, effort — and a profile
// turns those into that agent's flags. The point is a reviewer on a different provider from the
// implementer: a second set of eyes is only worth having if it is not the same eyes.
//
// Anything without a profile still runs. It gets the generic one (`--model`, and whatever the rule
// puts in `agentArgs`), because issue-herd knowing every agent's flags is not a thing to depend on
// — and herdr, not this file, is the authority on which kinds exist.

/**
 * `permissionMode` is Claude Code's word, and it is the one the config has always used. Each
 * profile decides what "unattended" means for its own agent, and none of them may decide it means
 * "no sandbox": an agent working an issue nobody is watching gets the widest setting that still
 * has a boundary, and the way past that boundary is for a person to type it into `agentArgs`.
 */
const UNATTENDED = new Set(['auto', 'bypassPermissions', 'acceptEdits']);

const PROFILES = {
  claude: {
    label: 'Claude Code',
    exit: '/exit',
    argv: ({ name, permissionMode, model, effort }) => [
      ...(name ? ['--name', name] : []),
      ...(permissionMode ? ['--permission-mode', permissionMode] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
    ],
  },
  codex: {
    label: 'Codex CLI',
    // Codex leaves the TUI with /quit, not /exit. Only reached by `onMerged.exitAgent`, which is
    // off by default, and stopAgent gives up and says so rather than hanging on the wrong word.
    exit: '/quit',
    argv: ({ permissionMode, model, effort }) => [
      // No session-name flag, so the run's name lives in herdr's agent name and nowhere else.
      ...(model ? ['--model', model] : []),
      // Reasoning effort is a config override rather than a flag; the value is parsed as TOML.
      ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(String(effort))}`] : []),
      // `--approve-for-me` answers approval requests inside the workspace-write sandbox — that
      // sandbox is what the flag means, and codex refuses `--sandbox` alongside it ("the argument
      // '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'"), which killed every
      // codex pane at the shell prompt until a dogfood run caught it. The unsandboxed equivalent
      // of Claude's "auto" exists and is deliberately not used here.
      ...(UNATTENDED.has(permissionMode) ? ['--approve-for-me'] : []),
    ],
  },
};

/** The generic profile: the one flag nearly every agent spells the same way. */
const GENERIC = {
  label: null,
  exit: '/exit',
  argv: ({ model }) => (model ? ['--model', model] : []),
};

/** The agent kinds this file can translate for. Everything else runs on the generic profile. */
export const TRANSLATED_KINDS = Object.keys(PROFILES);

export function profileFor(kind) {
  return PROFILES[Object.prototype.hasOwnProperty.call(PROFILES, kind) ? kind : ''] || GENERIC;
}

/** How this agent is asked to leave, for `onMerged.exitAgent`. */
export function exitCommandFor(kind) {
  return profileFor(kind).exit;
}

/** One line for the startup banner when a rule runs something other than the default. */
export function describeAgent(rule) {
  const bits = [rule.agentKind || 'claude'];
  if (rule.model) bits.push(rule.model);
  if (rule.effort) bits.push(`effort ${rule.effort}`);
  return bits.join(' ');
}

/**
 * The agent's own command line: what the profile makes of the rule, then whatever the rule adds
 * verbatim. `agentArgs` goes last so it can override anything above it — it is the escape hatch
 * for a flag this file has never heard of, including the one that turns a sandbox off.
 */
export function agentArgv({ kind = 'claude', name = null, permissionMode = null, model = null, effort = null, extra = [] } = {}) {
  return [...profileFor(kind).argv({ name, permissionMode, model, effort }), ...(extra || []).map(String)];
}
