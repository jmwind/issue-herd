// The tally store: names and how many times each was counted, kept in one JSON file.
import fs from 'node:fs';

export function openStore(file) {
  let counts = {};
  try { counts = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* a new tally */ }
  const save = () => fs.writeFileSync(file, JSON.stringify(counts, null, 2) + '\n');
  return {
    /** Count `name` `by` more times (once by default). */
    add(name, by = 1) {
      counts[name] = (counts[name] || 0) + by;
      save();
      return counts[name];
    },
    get(name) { return counts[name] || 0; },
    reset(name) { delete counts[name]; save(); },
    /** Every name and its count, most counted first. */
    entries() { return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); },
  };
}
