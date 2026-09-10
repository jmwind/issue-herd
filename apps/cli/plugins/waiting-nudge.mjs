// A shipped example plugin: a scheduled task.
//
// Every 15 minutes, look at the team's snapshot and send one herdr notification for each task
// that has waited on a person for more than an hour — once per task, not once per run of the
// task. The engine calls `run` with the canonical snapshot, a logger, a notifier and the memory
// the task returned last time. `"plugins": ["examples/waiting-nudge"]`.
export default {
  name: 'waiting-nudge', version: '1.0.0', api: 1,
  tasks: [{
    name: 'long-waits', every: '15m', summary: 'one notification per task that has waited on you for over an hour',
    async run({ snapshot, notify, log, memory, now }) {
      if (!snapshot) return;
      const told = { ...(memory.told || {}) };
      for (const task of snapshot.issues) {
        const waited = task.runs.reduce((ms, r) => Math.max(ms, r.waitingSince ? now.getTime() - r.waitingSince : 0), 0);
        if (waited < 3_600_000 || task.cleared) { delete told[task.key]; continue; }
        if (told[task.key]) continue;
        told[task.key] = now.toISOString();
        log(`${task.key} has waited on a person for ${Math.round(waited / 60_000)} min (${task.attention || task.phrase})`);
        await notify(`weawr ${snapshot.name}: ${task.key} is waiting on you`, `${task.title} — ${task.attention || task.phrase}, for ${Math.round(waited / 60_000)} minutes`);
      }
      return { told };
    },
  }],
};
