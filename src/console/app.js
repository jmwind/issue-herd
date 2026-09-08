// Factory Floor, the page. One JSON document in (over SSE), a render per change, hash routes:
//   #/                     every factory on this machine, one plant each, belts between them
//   #/f/<factory>          one factory's floor: alerts, assembling, output
//   #/i/<factory>/<issue>  one issue
// No framework, no build step. Everything shown comes from /api/state.
(function () {
  'use strict';
  var root = document.getElementById('app');
  var GEAR = '<svg class="gear" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8zm9.4 5.3-2.1-.4a7.5 7.5 0 0 0-.6-1.5l1.2-1.8-1.9-1.9-1.8 1.2c-.5-.3-1-.5-1.5-.6l-.4-2.1h-2.6l-.4 2.1c-.5.1-1 .3-1.5.6L8 6.7 6.1 8.6l1.2 1.8c-.3.5-.5 1-.6 1.5l-2.1.4v2.6l2.1.4c.1.5.3 1 .6 1.5l-1.2 1.8 1.9 1.9 1.8-1.2c.5.3 1 .5 1.5.6l.4 2.1h2.6l.4-2.1c.5-.1 1-.3 1.5-.6l1.8 1.2 1.9-1.9-1.2-1.8c.3-.5.5-1 .6-1.5l2.1-.4z"/></svg>';
  var INSERTER = '<div class="inserter"><svg viewBox="0 0 32 30"><rect x="10" y="22" width="12" height="6" fill="#4A4A4A" stroke="#0A0A0A"/><g class="arm"><rect x="14" y="4" width="4" height="22" fill="#E39827" stroke="#0A0A0A"/><rect x="10" y="1" width="12" height="5" fill="#5C5C5C" stroke="#0A0A0A"/></g></svg></div>';
  var view = null, sheet = false, showAll = false, tails = {}, expanded = {}, receivedAt = 0;
  // Mark done / Undo in flight, by task: the button and card show it until the console's state
  // reflects the decision (the task in output, or back), not just until the request returns.
  var busy = {};
  var MARK = (document.getElementById('mark') || { innerHTML: '' }).innerHTML;
  var ROLE_COLORS = { impl: 'var(--orange-2)', review: '#8FA9B8', usability: '#B79CD9' }, EXTRA = ['#D9C07A', '#7ED184', '#E05252'];
  function roleColor(role, i) { return ROLE_COLORS[role] || EXTRA[i % EXTRA.length]; }
  // A gear as a path: `teeth` square teeth of `depth` around a circle of radius r, with a hub hole.
  function gearPath(cx, cy, r, teeth, depth) {
    var pts = [], n = teeth * 4;
    for (var i = 0; i < n; i++) { var a = i / n * Math.PI * 2, out = i % 4 === 1 || i % 4 === 2, rr = out ? r : r - depth; pts.push((cx + Math.cos(a) * rr).toFixed(1) + ',' + (cy + Math.sin(a) * rr).toFixed(1)); }
    var h = Math.max(2, r * 0.28);
    return 'M' + pts.join('L') + 'Z M' + (cx - h) + ',' + cy + 'a' + h + ',' + h + ' 0 1 0 ' + (h * 2) + ',0a' + h + ',' + h + ' 0 1 0 ' + (-h * 2) + ',0Z';
  }
  // An assembling machine: chamfered steel body, rivets, a hazard stripe, and a round port with
  // a big gear and two small ones meshing on it. The gears turn while the plant is working.
  var ASSEMBLER = '<svg class="asm" viewBox="0 0 100 100" aria-hidden="true">' +
    '<defs><linearGradient id="asmb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8A979E"/><stop offset="1" stop-color="#4A555B"/></linearGradient>' +
    '<radialGradient id="asmp" cx=".5" cy=".45" r=".6"><stop offset="0" stop-color="#2A2A2A"/><stop offset="1" stop-color="#050505"/></radialGradient>' +
    '<pattern id="asmh" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="8" fill="#E9C13A"/><rect x="4" width="4" height="8" fill="#151515"/></pattern></defs>' +
    '<path class="body" d="M14 2H86L98 14V86L86 98H14L2 86V14Z"/><path class="panel" d="M19 7H81L93 19V81L81 93H19L7 81V19Z"/>' +
    '<rect x="22" y="86" width="56" height="6" fill="url(#asmh)" stroke="#0A0A0A"/>' +
    '<circle class="rivet" cx="12" cy="12" r="2.6"/><circle class="rivet" cx="88" cy="12" r="2.6"/><circle class="rivet" cx="12" cy="88" r="2.6"/><circle class="rivet" cx="88" cy="88" r="2.6"/>' +
    '<circle class="port" cx="50" cy="47" r="28"/><circle class="ring" cx="50" cy="47" r="25"/>' +
    '<g class="g2"><path d="' + gearPath(67, 34, 8, 7, 2.6) + '"/></g><g class="g3"><path d="' + gearPath(31, 58, 7, 6, 2.4) + '"/></g>' +
    '<g class="g1"><path d="' + gearPath(50, 47, 17, 10, 4) + '"/></g>' +
    '<ellipse class="glass" cx="42" cy="34" rx="12" ry="7"/>' +
    '<rect class="lampbox" x="16" y="16" width="14" height="9"/><circle class="lamp" cx="23" cy="20.5" r="2.8"/></svg>';
  // Where the page is, from the hash: the index of every factory (the default), one factory's floor, or one issue.
  function route() {
    var m = /^#\/i\/([^/]+)\/(.+)$/.exec(location.hash); if (m) return { kind: 'issue', id: decodeURIComponent(m[1]), key: decodeURIComponent(m[2]) };
    m = /^#\/f\/([^/]+)$/.exec(location.hash); if (m) return { kind: 'factory', id: decodeURIComponent(m[1]) };
    return { kind: 'index' };
  }
  var chosen = null; // the factory the current route is about, or null for the index

  // ------------------------------------------------------------ helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function drift() { return view ? Date.now() - receivedAt : 0; }
  function dur(ms) { ms = Math.max(0, ms); var s = Math.round(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24); if (d) return d + 'd ' + (h % 24) + 'h'; if (h) return h + 'h ' + (m % 60) + 'm'; if (m) return m + 'm'; return s + 's'; }
  function clock(iso) { if (!iso) return ''; var d = new Date(iso); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function prNum(url) { return url ? '#' + url.split('/').pop() : ''; }
  function factories() { return view ? view.factories : []; }
  function taskAlerts(f) { var keys = []; f.alerts.forEach(function (a) { if (keys.indexOf(a.issueKey) < 0) keys.push(a.issueKey); }); return keys.length; }
  function hasAlert(f, iss) { return f.alerts.some(function (a) { return a.issueKey === iss.key; }); }
  // One line of facts per task: size and grade, the issue's state, the PR's state.
  function stats(iss) {
    var out = [];
    if (iss.size && (iss.size.added || iss.size.removed)) out.push('<span class="st"><b class="add">+' + iss.size.added + '</b> <b class="del">−' + iss.size.removed + '</b>' + (iss.size.complexity ? ' <em>' + esc(iss.size.complexity.grade) + '</em>' : '') + '</span>');
    if (iss.issueState) out.push('<span class="st' + (iss.issueState === 'closed' ? ' closed' : '') + '">issue ' + esc(iss.issueState) + '</span>');
    if (iss.prUrl) out.push('<span class="st pr-' + esc(iss.prState) + '">PR ' + esc(prNum(iss.prUrl)) + ' ' + esc(iss.prState) + '</span>');
    else out.push('<span class="st dim">no PR</span>');
    return '<span class="stats">' + out.join('') + '</span>';
  }
  // A run's result as a word: the raw status for the run that owns the PR, the model's reading for a reviewer (a report, not a decision).
  function verdict(r) { return r.result && r.ownsPr ? r.result.status.replace('_', ' ') : r.phrase; }
  var SHORT = { blocked: 'blocked on a dialog', question: 'stopped to ask', merge: 'PR waits for your merge', needs_human: 'needs your decision', holding: 'still holding its workspace', stopped: 'stopped without a result', failed: 'failed', gone: 'agent gone', finished: 'finished, waiting for your sign-off' };
  function current() { if (!view || !chosen) return null; return factories().filter(function (f) { return f.id === chosen; })[0] || null; }
  function shown() { var f = current(); return f ? [f] : factories(); }
  function pct(a, b) { return a + b > 0 ? Math.round(a / (a + b) * 100) : null; }
  function factoryOf(issueKey, id) { return factories().filter(function (f) { return f.id === id; })[0]; }

  // ------------------------------------------------------------ pieces
  // `below` hangs off the bar: the factory picker drops from it, directly under the picker button.
  function titlebar(inner, below) {
    var ok = view && view.herdr.connected;
    return '<div class="titlebar' + (below ? ' open' : '') + '">' + MARK + inner + '<span class="drag"></span><span class="tick' + (ok ? '' : ' off') + '" title="' + (ok ? 'herdr ' + esc(view.herdr.version || '') : 'herdr is not answering') + '">' + GEAR + esc(document.body.dataset.hostname) + '</span>' + (below || '') + '</div>';
  }
  function belt() {
    var fs = shown(), today = 0, assembling = 0, wait = 0, alerts = 0;
    fs.forEach(function (f) {
      alerts += taskAlerts(f); assembling += f.counts.inflight; wait += f.humanWaitMs;
      f.issues.forEach(function (i) { if (i.bucket !== 'inflight' && !hasAlert(f, i) && i.finishedAt && Date.now() - Date.parse(i.finishedAt) < 86400e3) today++; });
    });
    var stats = [['output today', today, 'merged'], ['assembling', assembling, 'commit'], ['waiting on you', dur(wait), 'lines'], ['alerts', alerts, alerts ? 'pr' : 'commit']];
    var items = stats.map(function (st) { return '<span class="item"><i class="' + st[2] + '"></i><b>' + esc(st[1]) + '</b>' + esc(st[0]) + '</span>'; }).join('');
    return '<div class="belt" aria-hidden="true"><div class="items">' + items + items + '</div>' + INSERTER + '</div>';
  }
  // The roles that worked on a task, in team order, each with its light; a role the team has but
  // nobody has started yet is a dashed chip, so the team's shape is visible on every task.
  function chips(iss) {
    return '<span class="chips">' + iss.slots.map(function (sl, i) {
      var r = iss.runs.filter(function (x) { return x.role === sl.role || (!x.role && sl.role === 'run'); })[0];
      var who = r ? (r.agentKind || '') : '';
      return '<span class="chip ' + esc(sl.light) + '" style="border-left:3px solid ' + roleColor(sl.role, i) + '" title="' + esc(sl.role + ': ' + sl.phrase + (who ? ' · ' + who : '')) + '"><i class="led ' + esc(sl.light === 'empty' ? '' : sl.light) + ' still"></i>' + esc(sl.role) + (who ? '<small>' + esc(who) + '</small>' : '') + '</span>';
    }).join('') + '</span>';
  }
  // One row per task. `plain` leaves the role chips out: a finished task is a summary line, and
  // which roles worked on it is the detail screen's business.
  function row(f, iss, many, plain) {
    var elapsed = iss.finishedAt ? iss.elapsedMs : iss.elapsedMs + drift();
    var phrase = iss.bucket === 'merged' ? 'merged ' + prNum(iss.prUrl) + (iss.finishedAt ? ' · ' + clock(iss.finishedAt) : '') : iss.cleared ? 'marked done by you' : iss.phrase;
    var wait = iss.humanWaitMs + (iss.bucket === 'inflight' && iss.light !== 'green' ? drift() : 0);
    return '<a class="row ' + esc(iss.light) + '" href="#/i/' + esc(f.id) + '/' + encodeURIComponent(iss.key) + '"><i class="led ' + esc(iss.light) + (iss.bucket !== 'inflight' ? ' still' : '') + '"></i>' +
      '<span class="t"><b>' + esc(iss.key) + '</b>' + esc(iss.title) + '</span>' +
      '<span class="e"><span class="you' + (wait ? '' : ' none') + '" title="time a person was waited on">' + (wait ? dur(wait) : '0') + '<small>you</small></span><small class="el">' + dur(elapsed) + '</small></span>' +
      '<span class="s">' + (plain ? '' : chips(iss)) + '<span>' + (many ? esc(f.name) + ' · ' : '') + esc(phrase) + '</span>' + stats(iss) + '</span>' +
      (iss.light === 'green' && iss.bucket === 'inflight' ? '<span class="craft"><i></i></span>' : '') + '</a>';
  }
  function taskCard(f, iss, alerts, many) {
    var lines = alerts.map(function (a) { return '<li title="' + esc(a.text) + '"><i class="led ' + esc(a.light) + ' still"></i><b>' + esc(a.role || 'agent') + '</b> ' + esc(SHORT[a.kind] || a.kind) + (a.kind === 'holding' && a.workspaceId ? ' ' + esc(a.workspaceId) : '') + ' <small>' + dur(a.sinceMs + drift()) + '</small>' + (a.verdicts ? '<span class="verdicts">' + esc(a.verdicts) + '</span>' : '') + '</li>'; }).join('');
    var acts = '', seen = {};
    alerts.forEach(function (a) {
      if (a.kind === 'merge' && a.prUrl && !seen.merge) { seen.merge = 1; acts += '<a class="btn confirm" href="' + esc(a.prUrl) + '" target="_blank" rel="noopener">✓ Merge on GitHub</a>'; }
      if (a.kind === 'needs_human' && a.url && !seen.answer) { seen.answer = 1; acts += '<a class="btn confirm" href="' + esc(a.url) + '" target="_blank" rel="noopener">Answer on the issue</a>'; }
    });
    if (!seen.merge && !seen.answer && iss.url) acts += '<a class="btn" href="' + esc(iss.url) + '" target="_blank" rel="noopener">Open issue</a>';
    var live = iss.runs.filter(function (r) { return r.agentAlive; });
    if (live.length) acts += '<button class="btn" data-tail="' + esc(f.id) + '|' + esc(iss.key) + '">Scrollback</button>';
    acts += doneButton(f, iss, live);
    var tail = scrollback(f.id + '|' + iss.key);
    var wait = iss.humanWaitMs + (iss.light === 'green' ? 0 : drift());
    var b = busy[f.id + '|' + iss.key];
    return '<div class="alert' + (b ? ' busy' : '') + '"><div class="k"><i class="led ' + esc(iss.light) + ' still"></i><b>' + esc(iss.key) + ' ' + esc(iss.title) + (many ? ' · ' + esc(f.name) : '') + '</b><span class="you' + (wait > 1000 ? '' : ' none') + '" title="time a person was waited on">' + (wait > 1000 ? dur(wait) : '0') + '<small>you</small></span></div>' +
      '<a class="open" href="#/i/' + esc(f.id) + '/' + encodeURIComponent(iss.key) + '">' + chips(iss) + stats(iss) + '</a><ul class="why">' + lines + '</ul>' + tail + '<div class="acts">' + acts + '</div>' + (b ? '<span class="craft"><i></i></span>' : '') + '</div>';
  }
  // The one action on a task: a person says it is done. Its agents are closed, its alerts go,
  // and it moves to output. `live` is the agents still up, named so the confirm can say who goes.
  function doneButton(f, iss, live) {
    var b = busy[f.id + '|' + iss.key];
    if (b) return busyButton(b);
    return '<button class="btn done" data-done="' + esc(f.id) + '|' + esc(iss.key) + '" data-agents="' + esc(live.map(function (r) { return r.agent; }).join(', ')) + '" title="Close its agents, clear its alerts and move it to output. Your call.">✓ Mark done</button>';
  }
  // The same button while its request is in flight: a turning gear and what the console is doing
  // right now, so a click that takes a few seconds (an agent shutting down) is visibly doing it.
  function busyButton(b) {
    var what = b.undo ? 'Bringing it back…' : b.agents ? 'Closing ' + b.agents + ' agent' + (b.agents === 1 ? '' : 's') + '…' : b.settled ? 'Moving to output…' : 'Marking done…';
    return '<button class="btn done busy" disabled aria-live="polite">' + GEAR + esc(what) + '</button>';
  }
  // Every agent's last lines, one block per role with its colour in the gutter. Read only.
  function scrollback(key) {
    var blocks = tails[key]; if (!blocks) return '';
    if (typeof blocks === 'string') return '<pre>' + esc(blocks) + '</pre>';
    return '<div class="scrollback">' + blocks.map(function (b, i) {
      var c = roleColor(b.role, i);
      return '<div class="sb" style="border-left-color:' + c + '"><div class="sbh" style="color:' + c + '">' + esc(b.role || b.agent) + ' <small>' + esc(b.agent + ' · ' + b.agentKind + ' · ' + (b.alive ? b.phrase : 'agent gone')) + '</small></div>' + (b.text ? '<pre>' + esc(b.text) + '</pre>' : '<pre class="dim">(no scrollback: the agent is no longer running)</pre>') + '</div>';
    }).join('') + '</div>';
  }
  function section(title, count, body, extra) { return '<section><div class="sub">' + title + ' <span class="n' + (extra && extra.hot ? ' hot' : '') + '">' + count + '</span>' + (extra && extra.more || '') + '</div>' + body + '</section>'; }
  // What this factory is, at a glance: where it reads issues from, the rules that pick them up
  // (which issues, which role, which agent) and how its watcher is doing. Top of the overview.
  function factoryCard(f) {
    var alive = !f.watcher.stale;
    var rules = f.rules.map(function (r, i) {
      return '<div><b style="color:' + roleColor(r.role || r.name, i) + '">' + esc(r.role || r.name) + '</b><span><em>' + esc(r.agent + (r.model ? ' ' + r.model : '')) + '</em>' + (r.effort ? ' · ' + esc(r.effort) : '') + (r.basedOn ? ' · after ' + esc(r.basedOn) : '') + (r.passes > 1 ? ' · ' + r.passes + ' passes' : '') + '<code>' + esc(r.match || 'any issue') + '</code></span></div>';
    }).join('') || '<div class="empty">No rules: this factory picks nothing up.</div>';
    var meta = esc(f.tracker) + ' · ' + esc(f.repo.replace(/^.*\//, '')) + (f.maxConcurrent ? ' · cap ' + f.maxConcurrent : '') + (f.pollSeconds ? ' · every ' + f.pollSeconds + 's' : '') +
      ' · ' + (f.watcher.lastPoll ? (alive ? 'polled ' + dur(Date.now() - Date.parse(f.watcher.lastPoll)) + ' ago' : 'watcher not seen for ' + dur(Date.now() - Date.parse(f.watcher.lastPoll))) : (f.watcher.paneOnly ? 'watcher pane open' : 'watcher never seen'));
    return section('<i class="led ' + (alive ? 'green' : 'red') + ' still"></i>' + esc(f.name), f.rules.length + ' rule' + (f.rules.length === 1 ? '' : 's'), '<div class="inset pane factory"><div class="fmeta' + (alive ? '' : ' stale') + '">' + meta + '</div><div class="team">' + rules + '</div></div>',
      { more: '<span class="more" style="color:var(--muted)">' + esc(f.roles.join(' → ')) + '</span>' });
  }
  function legend() {
    return '<div class="legend"><span><i class="led green still"></i>working</span><span><i class="led red"></i>blocked</span><span><i class="led yellow"></i>waiting on you</span><span><i class="led"></i>done</span><span><span class="chip empty"><i class="led still"></i>role</span>not started</span><span><span class="you">5m<small>you</small></span>waited on a person</span></div>';
  }

  // ------------------------------------------------------------ screens
  function picker(label) { return '<button class="picker" id="pick" aria-expanded="' + (sheet ? 'true' : 'false') + '"><span class="n">' + esc(label) + '</span><span class="chev">' + (sheet ? '▲' : '▼') + '</span></button>'; }
  function overview() {
    var f = current();
    if (!f) return titlebar(picker(factories().length ? 'All factories' : 'No factories'), sheet ? pickerSheet() : '') + '<div class="body"><div class="empty">No factory called <b>' + esc(chosen) + '</b> here. <a href="#/">All factories</a></div></div>' + (sheet ? '<div class="dimmer" id="dim"></div>' : '');
    var fs = [f], many = false;
    var head = titlebar(picker(f.name), sheet ? pickerSheet() : '');
    var alerts = [], inflight = [], merged = [], done = [];
    fs.forEach(function (x) {
      var byTask = {};
      x.alerts.forEach(function (a) { (byTask[a.issueKey] = byTask[a.issueKey] || []).push(a); });
      Object.keys(byTask).forEach(function (k) { var iss = x.issues.filter(function (i) { return i.key === k; })[0]; if (iss) alerts.push([x, iss, byTask[k]]); });
      x.issues.forEach(function (i) { if (i.bucket === 'inflight') inflight.push([x, i]); else if (!byTask[i.key]) (i.bucket === 'merged' ? merged : done).push([x, i]); });
    });
    var body = '';
    if (!factories().length) body += '<div class="empty">No factory has reported yet. Start a watcher with <b>issue-herd</b> in a repository, and it appears here on its first poll.</div>';
    else body += fs.map(factoryCard).join('') + legend();
    body += section('<i class="led ' + (alerts.length ? 'red' : '') + ' still"></i>Alerts', alerts.length, alerts.length ? '<div class="inset pane">' + alerts.map(function (p) { return taskCard(p[0], p[1], p[2], many); }).join('') + '</div>' : '<div class="inset pane"><div class="empty">Nothing needs you. The factory is running by itself.</div></div>', { hot: alerts.length });
    body += section('Assembling', inflight.length, inflight.length ? '<div class="inset pane">' + inflight.map(function (p) { return row(p[0], p[1], many); }).join('') + '</div>' : '<div class="inset pane"><div class="empty">No issue in flight.</div></div>');
    var out = merged.concat(done);
    var today = out.filter(function (p) { return p[1].finishedAt && Date.now() - Date.parse(p[1].finishedAt) < 86400e3; });
    var list = showAll ? out : today;
    var more = out.length > list.length ? '<button class="more" id="more">Show all ' + out.length + '</button>' : (showAll && out.length > today.length ? '<button class="more" id="more">Today only</button>' : '');
    body += section(showAll ? 'Output' : 'Output today', list.length, list.length ? '<div class="inset pane">' + list.map(function (p) { return row(p[0], p[1], many, true); }).join('') + '</div>' : '<div class="inset pane"><div class="empty">Nothing finished' + (showAll ? '' : ' today') + '.</div></div>', { more: more });
    var wait = fs.reduce(function (s, x) { return s + x.humanWaitMs; }, 0);
    body += '<div class="foot"><span>' + esc(fs.reduce(function (s, x) { return s + x.counts.running; }, 0)) + ' running · you were waited on for <b>' + dur(wait) + '</b> in total</span><span>' + (f && f.watcher.lastPoll ? 'polled ' + dur(Date.now() - Date.parse(f.watcher.lastPoll)) + ' ago' : '') + '</span></div>';
    return head + belt() + '<div class="body">' + body + '</div>' + (sheet ? '<div class="dimmer" id="dim"></div>' : '');
  }

  // ---- the index: every factory on the machine as one plant, belts running between them.
  // What is on a plant is what changes what you do next, plus the numbers a factory owner
  // looks at: who works there, what came out today, this week, this month, and how much of
  // its time it ran on its own against how much it spent waiting on a person.
  function plant(f) {
    var alive = !f.watcher.stale, working = f.counts.working > 0, alerts = taskAlerts(f);
    var state = !alive ? 'stale' : working ? 'working' : 'idle';
    var phrase = !alive ? (f.watcher.lastPoll ? 'watcher not seen for ' + dur(Date.now() - Date.parse(f.watcher.lastPoll)) : 'watcher never seen') : working ? f.counts.working + ' agent' + (f.counts.working === 1 ? '' : 's') + ' working' : f.counts.inflight ? 'waiting' : 'idle';
    var agents = []; f.rules.forEach(function (r) { if (agents.indexOf(r.agent) < 0) agents.push(r.agent); });
    // Who works here: the roles, or with no roles the rules themselves, one chip each.
    var names = f.roles.length ? f.roles : f.rules.map(function (r) { return r.name; });
    var crew = '<b>' + names.length + '</b> ' + (f.roles.length ? 'role' : 'rule') + (names.length === 1 ? '' : 's') + ' ' + (names.map(function (r, i) { return '<span class="chip" style="border-left:3px solid ' + roleColor(r, i) + '">' + esc(r) + '</span>'; }).join('') || '<span class="chip empty">none</span>');
    var win = ['today', 'week', 'month'];
    var cell = function (k, fmt) { return win.map(function (w) { var p = f.production[w]; return '<td>' + fmt(p) + '</td>'; }).join(''); };
    var prod = '<table class="prod"><thead><tr><th></th><th>today</th><th>week</th><th>month</th></tr></thead><tbody>' +
      '<tr><th><i class="ico merged"></i>output</th>' + cell('finished', function (p) { return '<b>' + p.finished + '</b>' + (p.merged ? '<small>' + p.merged + ' merged</small>' : ''); }) + '</tr>' +
      '<tr><th><i class="ico commit"></i>on its own</th>' + cell('workingMs', function (p) { return '<b class="own">' + dur(p.workingMs) + '</b>'; }) + '</tr>' +
      '<tr><th><i class="ico lines"></i>waiting on you</th>' + cell('humanMs', function (p) { var r = pct(p.workingMs, p.humanMs); return '<b class="' + (p.humanMs > 1000 ? 'you' : 'none') + '">' + dur(p.humanMs) + '</b>' + (r !== null ? '<small>' + r + '% alone</small>' : ''); }) + '</tr></tbody></table>';
    var gears = ASSEMBLER;
    var lights = '<span class="lights" aria-hidden="true">' + [0, 1, 2, 3].map(function (i) { return '<i class="led ' + (i < f.counts.working ? 'green' : i < f.counts.inflight ? 'yellow still' : 'still') + '"></i>'; }).join('') + '</span>';
    return '<a class="plant ' + state + '" href="#/f/' + esc(f.id) + '"><i class="rivet tl"></i><i class="rivet tr"></i><i class="rivet bl"></i><i class="rivet br"></i>' +
      '<div class="roof"><i class="led ' + (alive ? (working ? 'green' : 'yellow still') : 'red') + '"></i><b>' + esc(f.name) + '</b><span class="m">' + esc(f.tracker) + ' · ' + esc(f.repo.replace(/^.*\//, '')) + '</span><span class="chev">›</span></div>' +
      '<div class="floor">' + gears + '<span class="panel"><span class="state">' + lights + '<span class="ph">' + esc(phrase) + '</span></span>' +
      '<span class="crew">' + crew + (agents.length ? '<span class="who">' + esc(agents.join(', ')) + '</span>' : '') + '</span>' + (working ? '<span class="craft"><i></i></span>' : '') + '</span></div>' +
      prod +
      '<div class="needs"><span class="pill' + (alerts ? ' hot' : '') + '">' + (alerts ? alerts + ' alert' + (alerts > 1 ? 's' : '') : 'nothing needs you') + '</span><span class="pill">' + f.counts.inflight + ' assembling</span>' + (f.watcher.lastPoll && alive ? '<span class="m">polled ' + dur(Date.now() - Date.parse(f.watcher.lastPoll)) + ' ago</span>' : '') + '</div></a>';
  }
  // The belt from one plant down to the next: chevrons always run; cargo rides it only when a plant at either end is working.
  function link(above, below) {
    var working = above.counts.working > 0 || below.counts.working > 0;
    var items = working ? '<span class="cargo" aria-hidden="true"><i class="commit"></i><i class="merged"></i><i class="pr"></i><i class="lines"></i></span>' : '';
    return '<div class="link' + (working ? ' on' : '') + '" aria-hidden="true"><div class="vbelt">' + items + '</div></div>';
  }
  function index() {
    var fs = factories();
    var head = titlebar(picker(fs.length ? 'All factories' : 'No factories'), sheet ? pickerSheet() : '');
    var body = '';
    if (!fs.length) body = '<div class="empty">No factory has reported yet. Start a watcher with <b>issue-herd</b> in a repository, and it appears here on its first poll.</div>';
    else body = '<div class="plants">' + fs.map(function (f, i) { return (i ? link(fs[i - 1], f) : '') + plant(f); }).join('') + '</div>';
    var wait = fs.reduce(function (s, x) { return s + x.humanWaitMs; }, 0), running = fs.reduce(function (s, x) { return s + x.counts.running; }, 0);
    body += '<div class="foot"><span>' + fs.length + ' factor' + (fs.length === 1 ? 'y' : 'ies') + ' on ' + esc(document.body.dataset.hostname) + ' · ' + running + ' running · you were waited on for <b>' + dur(wait) + '</b> in total</span></div>';
    return head + belt() + '<div class="body">' + body + '</div>' + (sheet ? '<div class="dimmer" id="dim"></div>' : '');
  }

  function pickerSheet() {
    var opts = factories().map(function (f) {
      var alive = !f.watcher.stale;
      return '<button class="opt' + (f.id === chosen ? ' on' : '') + (alive ? '' : ' stale') + '" data-choose="' + esc(f.id) + '"><i class="led ' + (alive ? 'green' : 'red') + ' still"></i><span class="n">' + esc(f.name) + '</span>' +
        '<span class="c"><span class="pill">' + f.counts.inflight + ' assembling</span>' + (taskAlerts(f) ? '<span class="pill hot">' + taskAlerts(f) + ' alert' + (taskAlerts(f) > 1 ? 's' : '') + '</span>' : '') + '</span>' +
        '<span class="m">' + esc(f.tracker) + ' · ' + esc(f.repo.replace(/^.*\//, '')) + ' · ' + (f.watcher.lastPoll ? (alive ? 'polled ' + dur(Date.now() - Date.parse(f.watcher.lastPoll)) + ' ago' : 'watcher not seen for ' + dur(Date.now() - Date.parse(f.watcher.lastPoll))) : (f.watcher.paneOnly ? 'watcher pane ' + esc(f.watcher.workspaceId || '') + ' open' : 'watcher never seen')) + '</span></button>';
    }).join('');
    opts = '<button class="opt' + (!chosen ? ' on' : '') + '" data-choose="all"><i class="led green still"></i><span class="n">All factories</span><span class="c"><span class="pill">' + factories().reduce(function (s, f) { return s + f.counts.inflight; }, 0) + ' assembling</span></span><span class="m">every factory on ' + esc(document.body.dataset.hostname) + '</span></button>' + opts;
    // The chosen factory's rules live at the top of the overview now; the picker is for choosing.
    var f = current(), about = '';
    if (f) about = '<div class="pane"><div class="acts"><span class="pill">' + (f.watcher.version ? 'issue-herd ' + esc(f.watcher.version) : 'version unknown') + '</span>' + (f.watcher.workspaceId ? '<span class="pill">workspace ' + esc(f.watcher.workspaceId) + '</span>' : '') + '</div></div>';
    var lock = document.body.dataset.gated === 'true' ? '<div class="pane"><button class="btn" id="lockbtn">Lock the console</button></div>' : '';
    return '<div class="sheet" role="dialog" aria-label="Factories"><div class="titlebar"><h1>Factories on ' + esc(document.body.dataset.hostname) + '</h1><span class="drag"></span><button class="tbtn red" id="closesheet" aria-label="close">✕</button></div><div class="pane">' + opts + '</div>' + about + lock + '</div>';
  }

  function detail(fid, key) {
    var f = factoryOf(key, fid), iss = f && f.issues.filter(function (i) { return i.key === key; })[0];
    if (!iss) return titlebar('<h1>' + esc(key) + '</h1>') + '<div class="body"><div class="empty">No such run here. <a href="#/">Back</a></div></div>';
    var head = '<div class="titlebar">' + MARK + '<h1>' + esc(iss.key) + '</h1><span class="drag"></span><a class="tbtn red" href="#/f/' + esc(f.id) + '" aria-label="back">✕</a></div>';
    var elapsed = iss.finishedAt ? iss.elapsedMs : iss.elapsedMs + drift();
    var lead = iss.runs.filter(function (r) { return r.needsYou; })[0] || iss.runs.filter(function (r) { return r.status === 'running'; })[0] || iss.runs[0];
    var status = '<div class="status"><i class="led ' + esc(iss.light) + (iss.bucket !== 'inflight' ? ' still' : '') + '"></i><b>' + esc(iss.bucket === 'merged' ? 'Merged' : lead.phrase) + '</b>' + (iss.finishedAt ? ' at ' + clock(iss.finishedAt) : '') + ' <small>' + dur(elapsed) + ' end to end</small><span class="you big" title="time a person was waited on">' + dur(iss.humanWaitMs) + '<small>you</small></span></div>';
    var ws = iss.runs.map(function (r) { return r.workspaceId; }).filter(Boolean)[0];
    var links = '<div class="links">' + (iss.url ? '<a href="' + esc(iss.url) + '" target="_blank" rel="noopener">Issue<small>' + esc(iss.key) + (iss.issueState ? ' ' + esc(iss.issueState) : '') + '</small></a>' : '<span>Issue<small>no link</small></span>') +
      (iss.prUrl ? '<a href="' + esc(iss.prUrl) + '" target="_blank" rel="noopener">Pull request<small>' + esc(prNum(iss.prUrl)) + ' ' + esc(iss.prState) + '</small></a>' : '<span>Pull request<small>none yet</small></span>') +
      (ws ? '<span title="open it in herdr">Workspace<small>' + esc(ws) + '</small></span>' : '<span>Workspace<small>none</small></span>') + '</div>';
    var t0 = Date.parse(iss.startedAt), t1 = iss.finishedAt ? Date.parse(iss.finishedAt) : Date.now(); if (t1 - t0 < 60000) t1 = t0 + 60000;
    var bars = iss.runs.map(function (r, ri) {
      var segs = r.segments.map(function (s) { var l = Math.max(0, (s.from - t0) / (t1 - t0) * 100), w = Math.max(0.5, (Math.min(s.to, t1) - s.from) / (t1 - t0) * 100); return '<i class="' + esc(s.kind) + '" style="left:' + l.toFixed(2) + '%;width:' + w.toFixed(2) + '%"></i>'; }).join('');
      var v = dur((r.finishedAt ? r.elapsedMs : r.elapsedMs + drift())) + ' · ' + esc(verdict(r));
      return '<div class="role"><span class="n" style="color:' + roleColor(r.role, ri) + '">' + esc(r.role || r.rule) + '<small>' + esc(r.agentKind) + (r.pass > 1 ? ' · pass ' + r.pass : '') + '</small></span><div class="bar">' + segs + '</div><span class="v">' + v + '</span></div>';
    }).join('');
    var waits = [];
    iss.runs.forEach(function (r) { r.segments.forEach(function (s) { if (s.kind === 'blocked' || s.kind === 'question') waits.push(s); }); });
    var you = '<div class="role"><span class="n">you</span><div class="bar">' + waits.map(function (s) { var l = Math.max(0, (s.from - t0) / (t1 - t0) * 100), w = Math.max(0.5, (Math.min(s.to, t1) - s.from) / (t1 - t0) * 100); return '<i class="question" style="left:' + l.toFixed(2) + '%;width:' + w.toFixed(2) + '%"></i>'; }).join('') + '</div><span class="v">' + dur(iss.humanWaitMs) + '</span></div>';
    var roles = section('Modules', iss.runs.length + ' run' + (iss.runs.length === 1 ? '' : 's'), '<div class="inset pane">' + you + bars + '</div>' + '<div class="legend"><span><i class="bar" style="width:14px;height:8px;background:var(--green)"></i>working</span><span><i class="bar" style="width:14px;height:8px;background:var(--red-2)"></i>blocked</span><span><i class="bar" style="width:14px;height:8px;background:var(--yellow)"></i>waiting on you</span><span><i class="bar" style="width:14px;height:8px;background:#5A5A5A"></i>done</span></div>', { more: '<span class="more" style="color:var(--muted)">' + clock(iss.startedAt) + ' → ' + (iss.finishedAt ? clock(iss.finishedAt) : 'now') + '</span>' });
    var size = iss.size, change = '';
    if (size) {
      change = section('Recipe output', size.commits.length + ' commit' + (size.commits.length === 1 ? '' : 's'), '<div class="inset pane"><dl class="facts"><dt>size</dt><dd><b>+' + size.added + '</b> <s>−' + size.removed + '</s> · ' + size.files + ' file' + (size.files === 1 ? '' : 's') + (size.complexity ? ' · <em>' + esc(size.complexity.grade) + '</em>' : '') + '</dd>' +
        (size.complexity ? '<dt>why ' + esc(size.complexity.grade) + '</dt><dd>' + esc(size.complexity.why) + '</dd>' : '') +
        (size.commits.length ? '<dt>last commit</dt><dd>' + esc(size.commits[0].sha + ' ' + size.commits[0].subject) + '</dd>' : '') +
        (size.paths.length ? '<dt>touched</dt><dd>' + esc(size.paths.slice(0, 6).join(', ') + (size.paths.length > 6 ? ' +' + (size.paths.length - 6) : '')) + '</dd>' : '') + '</dl></div>');
    } else change = section('Recipe output', '—', '<div class="inset pane"><div class="empty">No branch measured yet.</div></div>');
    var results = iss.runs.filter(function (r) { return r.result && r.result.summary; }).map(function (r) { return '<div class="inset pane"><div class="sub" style="padding-top:0">' + esc(r.role || r.rule) + ' · ' + esc(verdict(r)) + '</div>' + (r.result.summary.length > 600 && !expanded[r.key] ? '<p class="summary clamp">' + esc(r.result.summary) + '</p><button class="more" data-expand="' + esc(r.key) + '">Read all</button>' : '<p class="summary">' + esc(r.result.summary) + '</p>' + (r.result.notes ? '<p class="summary" style="color:var(--dim)">' + esc(r.result.notes) + '</p>' : '')) + '</div>'; }).join('');
    if (results) results = section('Reports', iss.runs.filter(function (r) { return r.result; }).length, results);
    var live = iss.runs.filter(function (r) { return r.agentAlive; });
    var acts = live.length ? section('Agents still up', live.length, '<div class="inset pane">' + scrollback(f.id + '|' + iss.key) + '<div class="acts"><button class="btn" data-tail="' + esc(f.id) + '|' + esc(iss.key) + '">Scrollback</button></div></div>') : '';
    var b = busy[f.id + '|' + iss.key];
    acts += '<div class="acts">' + (b ? busyButton(b) : iss.cleared && !live.length ? '<span class="pill">marked done by you</span><button class="btn" data-undone="' + esc(f.id) + '|' + esc(iss.key) + '">Undo</button>' : doneButton(f, iss, live)) + '</div>';
    return head + belt() + '<div class="ehead"><span class="key">' + esc(f.name) + '</span><h2>' + esc(iss.title) + '</h2>' + status + '</div><div class="body">' + links + roles + change + results + acts + '</div>';
  }

  // ------------------------------------------------------------ render + wiring
  function render() {
    if (!view) return;
    var r = route();
    chosen = r.kind === 'index' ? null : r.id;
    root.innerHTML = r.kind === 'issue' ? detail(r.id, r.key) : r.kind === 'factory' ? overview() : index();
  }
  // A Mark done or Undo is over when the console's state shows it: the task out of Alerts and
  // in output (or back, for Undo), or gone from the view. A state that never catches up (the
  // console restarted, say) is not a reason to hold the button forever: SETTLE_MS after the
  // console answered, it goes back to a button.
  var SETTLE_MS = 8000;
  function settle() {
    var changed = false, now = Date.now();
    Object.keys(busy).forEach(function (key) {
      var b = busy[key], p = key.split('|'), f = factoryOf(p[1], p[0]), iss = f && f.issues.filter(function (i) { return i.key === p[1]; })[0];
      var landed = !f || !iss ? !!b.settled : b.undo ? !iss.cleared : iss.cleared && iss.bucket !== 'inflight' && !hasAlert(f, iss);
      if ((b.settled && landed) || (b.settled && now - b.settled > SETTLE_MS)) { delete busy[key]; changed = true; }
    });
    if (changed) render();
  }
  function toast(t) { var el = document.createElement('div'); el.className = 'toast'; el.textContent = t; document.body.appendChild(el); setTimeout(function () { el.remove(); }, 2600); }

  root.addEventListener('click', function (e) {
    var t = e.target.closest('button,a');
    if (!t) return;
    if (t.id === 'pick') { sheet = !sheet; render(); }
    else if (t.id === 'closesheet' || t.id === 'dim') { sheet = false; render(); }
    else if (t.id === 'more') { showAll = !showAll; render(); }
    else if (t.dataset.expand) { expanded[t.dataset.expand] = true; render(); }
    else if (t.id === 'lockbtn') { fetch('/lock', { method: 'POST' }).then(function () { location.replace('/'); }); }
    else if (t.dataset.choose) { sheet = false; var to = t.dataset.choose === 'all' ? '#/' : '#/f/' + encodeURIComponent(t.dataset.choose); if (location.hash === to || (to === '#/' && !location.hash)) render(); else location.hash = to; }
    else if (t.dataset.tail) { var p = t.dataset.tail.split('|'); t.disabled = true; fetch('/api/tail?factory=' + encodeURIComponent(p[0]) + '&issue=' + encodeURIComponent(p[1])).then(function (r) { return r.json(); }).then(function (j) { tails[t.dataset.tail] = j.blocks || '(empty)'; render(); }); }
    else if (t.dataset.done || t.dataset.undone) {
      var d = (t.dataset.done || t.dataset.undone).split('|'), undo = !!t.dataset.undone, agents = t.dataset.agents;
      if (!undo && !confirm('Mark ' + d[1] + ' done? ' + (agents ? 'Every agent still up on it (' + agents + ') is sent its exit command and shuts down the way it wants; workspaces and worktrees stay. ' : '') + 'Its alerts are cleared and it moves to output. A new run on it brings it back.')) return;
      var key = d[0] + '|' + d[1];
      busy[key] = { undo: undo, agents: undo || !agents ? 0 : agents.split(', ').length };
      render();
      fetch(undo ? '/api/undone' : '/api/done', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ factory: d[0], issue: d[1] }) })
        .then(function (r) { return r.json(); }).then(function (j) {
          if (!j.ok || j.error) { delete busy[key]; render(); return toast('Could not: ' + (j.error || 'unknown')); }
          var closed = (j.outcomes || []).map(function (o) { return o.agent + ' ' + o.outcome; }).join(' · ');
          toast(undo ? d[1] + ' is back' : d[1] + ' marked done' + (closed ? ' · ' + closed : ''));
          // The console said yes; the button keeps turning until the state that moves the task lands.
          if (busy[key]) { busy[key].settled = Date.now(); busy[key].agents = 0; }
          render(); settle();
          setTimeout(settle, SETTLE_MS + 50);
        }).catch(function () { delete busy[key]; render(); toast('The console did not answer.'); });
    }
  });
  document.getElementById('app').addEventListener('click', function (e) { if (e.target.id === 'dim') { sheet = false; render(); } });
  window.addEventListener('hashchange', render);
  setInterval(function () { if (view && !sheet) render(); }, 30000); // elapsed times tick even when nothing changed

  function connect() {
    var es = new EventSource('/api/events');
    es.addEventListener('state', function (ev) { view = JSON.parse(ev.data); receivedAt = Date.now(); render(); settle(); });
    es.onerror = function () { es.close(); fetch('/api/state').then(function (r) { if (r.status === 401) location.replace('/'); }).catch(function () {}); setTimeout(connect, 3000); };
  }
  connect();
})();
