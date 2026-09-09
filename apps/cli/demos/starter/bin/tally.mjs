#!/usr/bin/env node
// tally: count things from the command line.
//
//   tally add <name> [n]    count <name> once, or n times
//   tally list              every name and its count
//   tally reset <name>      forget a name
//
// Counts live in ./tally.json (or the file TALLY_FILE names).
import { openStore } from '../src/store.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const store = openStore(process.env.TALLY_FILE || 'tally.json');

switch (cmd) {
  case 'add': {
    const [name, n = '1'] = rest;
    if (!name) usage('add needs a name');
    console.log(`${name}: ${store.add(name, Number(n))}`);
    break;
  }
  case 'list': {
    for (const [name, count] of store.entries()) console.log(`${name}\t${count}`);
    break;
  }
  case 'reset': {
    if (!rest[0]) usage('reset needs a name');
    store.reset(rest[0]);
    console.log(`${rest[0]}: 0`);
    break;
  }
  default:
    usage(cmd ? `unknown command ${cmd}` : null);
}

function usage(problem) {
  if (problem) console.error(`tally: ${problem}`);
  console.error('usage: tally add <name> [n] | tally list | tally reset <name>');
  process.exit(problem ? 1 : 0);
}
