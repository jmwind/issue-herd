import os from 'node:os';
import { TRACKERS, mergeSpec, trackerSpec, trackerClass } from '@weawr/engine/adapters/trackers/index.mjs';
import { credentialsPath, deleteCredential, saveCredential, terminalUi } from '@weawr/engine/adapters/auth.mjs';
import { userDisplay } from '@weawr/engine/adapters/tracker.mjs';
import { trackerBanner } from '@weawr/engine';
import type { Context } from '../context.js';

/** `weawr login [tracker] [--paste]` and `weawr logout [tracker]`. Works before `init` when the tracker is named. */
export async function auth(ctx: Context, cmd: 'login' | 'logout', args: string[]): Promise<void> {
  const paste = args.includes('--paste');
  const named = args.find((a) => !a.startsWith('--'));
  const configured = ctx.hasConfig() ? ctx.config().trackerSpec : null;
  if (!named && !configured) throw new Error(`which tracker? weawr ${cmd} <${Object.keys(TRACKERS).join('|')}>`);
  // Naming the tracker must not throw away the config's options for it, or `login github` in a
  // GitHub Enterprise repo would sign in to github.com and save a token the watcher cannot use.
  const spec = mergeSpec(named ? trackerSpec(named) : null, configured);
  const Tracker: any = trackerClass(spec);
  const file = credentialsPath();
  const shown = file.replace(os.homedir(), '~');
  if (cmd === 'logout') { console.log(deleteCredential(Tracker.id, file) ? `forgot the ${Tracker.label} token in ${shown}` : `no ${Tracker.label} token saved in ${shown}`); return; }
  const options = { ...spec, cwd: ctx.paths.repo };
  const cred = await Tracker.login(terminalUi(), { paste, ...options });
  const tracker = new Tracker(cred, { options });
  const user = await tracker.me(); // proves the token works before it is saved
  const who = `${trackerBanner(tracker)}: signed in as ${userDisplay(user)}`;
  if (cred.kind === 'borrowed') {
    // The credential belongs to another tool that can rotate it (`gh`). Copying it here would go
    // stale and, being ahead of the fallback in the lookup order, would keep being used after it did.
    console.log(`✓ ${who} · nothing saved: the token comes from ${cred.source} on every run`);
    return;
  }
  const saved = saveCredential(Tracker.id, { ...cred, user: userDisplay(user) }, file);
  console.log(`✓ ${who} · ${saved.kind} token saved in ${shown}`);
  for (const name of ([] as string[]).concat(Tracker.auth?.env || [])) if (process.env[name]) console.log(`note: ${name} is set (environment or .env.local) and takes precedence over the saved token`);
}
