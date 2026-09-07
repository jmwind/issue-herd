// Factory Floor, the page. One JSON document in (over SSE), a render per change, hash routes:
//   #/                overview of the chosen factory (or every factory)
//   #/i/<factory>/<issue>  one issue
// No framework, no build step. Everything shown comes from /api/state.
(function () {
  'use strict';
  var root = document.getElementById('app');
  var GEAR = '<svg class="gear" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8zm9.4 5.3-2.1-.4a7.5 7.5 0 0 0-.6-1.5l1.2-1.8-1.9-1.9-1.8 1.2c-.5-.3-1-.5-1.5-.6l-.4-2.1h-2.6l-.4 2.1c-.5.1-1 .3-1.5.6L8 6.7 6.1 8.6l1.2 1.8c-.3.5-.5 1-.6 1.5l-2.1.4v2.6l2.1.4c.1.5.3 1 .6 1.5l-1.2 1.8 1.9 1.9 1.8-1.2c.5.3 1 .5 1.5.6l.4 2.1h2.6l.4-2.1c.5-.1 1-.3 1.5-.6l1.8 1.2 1.9-1.9-1.2-1.8c.3-.5.5-1 .6-1.5l2.1-.4z"/></svg>';
  var INSERTER = '<div class="inserter"><svg viewBox="0 0 32 30"><rect x="10" y="22" width="12" height="6" fill="#4A4A4A" stroke="#0A0A0A"/><g class="arm"><rect x="14" y="4" width="4" height="22" fill="#E39827" stroke="#0A0A0A"/><rect x="10" y="1" width="12" height="5" fill="#5C5C5C" stroke="#0A0A0A"/></g></svg></div>';
  var view = null, sheet = false, showAll = false, tails = {}, receivedAt = 0;
  var chosen = null; try { chosen = localStorage.getItem('factory'); } catch (e) { /* private mode */ }

  // ------------------------------------------------------------ helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function drift() { return view ? Date.now() - receivedAt : 0; }
  function dur(ms) { ms = Math.max(0, ms); var s = Math.round(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24); if (d) return d + 'd ' + (h % 24) + 'h'; if (h) return h + 'h ' + (m % 60) + 'm'; if (m) return m + 'm'; return s + 's'; }
  function clock(iso) { if (!iso) return ''; var d = new Date(iso); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function prNum(url) { return url ? '#' + url.split('/').pop() : ''; }
  function factories() { return view ? view.factories : []; }
  function current() { if (!view) return null; if (chosen === 'all' || !chosen) return factories().length === 1 ? factories()[0] : null; return factories().filter(function (f) { return f.id === chosen; })[0] || null; }
  function shown() { var f = current(); return f ? [f] : factories(); }
  function factoryOf(issueKey, id) { return factories().filter(function (f) { return f.id === id; })[0]; }

  // ------------------------------------------------------------ pieces
  function titlebar(inner) {
    var ok = view && view.herdr.connected;
    return '<div class="titlebar">' + inner + '<span class="drag"></span><span class="tick' + (ok ? '' : ' off') + '" title="' + (ok ? 'herdr ' + esc(view.herdr.version || '') : 'herdr is not answering') + '">' + GEAR + esc(document.body.dataset.hostname) + '</span></div>';
  }
  function belt() {
    var fs = shown(), today = 0, assembling = 0, wait = 0, alerts = 0;
    fs.forEach(function (f) {
      alerts += f.alerts.length; assembling += f.counts.inflight; wait += f.humanWaitMs;
      f.issues.forEach(function (i) { if (i.bucket !== 'inflight' && i.finishedAt && Date.now() - Date.parse(i.finishedAt) < 86400e3) today++; });
    });
    var stats = [['output today', today, 'merged'], ['assembling', assembling, 'commit'], ['waiting on you', dur(wait), 'lines'], ['alerts', alerts, alerts ? 'pr' : 'commit']];
    var items = stats.map(function (st) { return '<span class="item"><i class="' + st[2] + '"></i><b>' + esc(st[1]) + '</b>' + esc(st[0]) + '</span>'; }).join('');
    return '<div class="belt" aria-hidden="true"><div class="items">' + items + items + '</div>' + INSERTER + '</div>';
  }
  // The roles that worked on a task, in team order, each with its light; a role the team has but
  // nobody has started yet is a dashed chip, so the team's shape is visible on every task.
  function chips(iss) {
    return '<span class="chips">' + iss.slots.map(function (sl) {
      var r = iss.runs.filter(function (x) { return x.role === sl.role || (!x.role && sl.role === 'run'); })[0];
      var who = r ? (r.agentKind || '') : '';
      return '<span class="chip ' + esc(sl.light) + '" title="' + esc(sl.role + ': ' + sl.phrase + (who ? ' · ' + who : '')) + '"><i class="led ' + esc(sl.light === 'empty' ? '' : sl.light) + ' still"></i>' + esc(sl.role) + (who ? '<small>' + esc(who) + '</small>' : '') + '</span>';
    }).join('') + '</span>';
  }
  function row(f, iss, many) {
    var elapsed = iss.finishedAt ? iss.elapsedMs : iss.elapsedMs + drift();
    var phrase = iss.bucket === 'merged' ? 'merged ' + prNum(iss.prUrl) + (iss.finishedAt ? ' · ' + clock(iss.finishedAt) : '') : iss.phrase;
    var wait = iss.humanWaitMs + (iss.bucket === 'inflight' && iss.light !== 'green' ? drift() : 0);
    return '<a class="row ' + esc(iss.light) + '" href="#/i/' + esc(f.id) + '/' + encodeURIComponent(iss.key) + '"><i class="led ' + esc(iss.light) + (iss.bucket !== 'inflight' ? ' still' : '') + '"></i>' +
      '<span class="t"><b>' + esc(iss.key) + '</b>' + esc(iss.title) + '</span>' +
      '<span class="e"><span class="you' + (wait ? '' : ' none') + '" title="time a person was waited on">' + (wait ? dur(wait) : '0') + '<small>you</small></span><small class="el">' + dur(elapsed) + '</small></span>' +
      '<span class="s">' + chips(iss) + '<span>' + (many ? esc(f.name) + ' · ' : '') + esc(phrase) + '</span></span>' +
      (iss.light === 'green' && iss.bucket === 'inflight' ? '<span class="craft"><i></i></span>' : '') + '</a>';
  }
  function taskCard(f, iss, alerts, many) {
    var lines = alerts.map(function (a) { return '<li><i class="led ' + esc(a.light) + ' still"></i><b>' + esc(a.role || 'agent') + '</b> ' + esc(a.text) + ' <small>' + dur(a.sinceMs + drift()) + '</small></li>'; }).join('');
    var acts = '', seen = {};
    alerts.forEach(function (a) {
      if (a.kind === 'merge' && a.prUrl && !seen.merge) { seen.merge = 1; acts += '<a class="btn confirm" href="' + esc(a.prUrl) + '" target="_blank" rel="noopener">✓ Merge on GitHub</a>'; }
      if (a.kind === 'needs_human' && a.url && !seen.answer) { seen.answer = 1; acts += '<a class="btn confirm" href="' + esc(a.url) + '" target="_blank" rel="noopener">Answer on the issue</a>'; }
      if (a.kind === 'blocked' || a.kind === 'question') acts += '<button class="btn" data-tail="' + esc(f.id) + '|' + esc(a.runKey) + '">Scrollback · ' + esc(a.role || a.agent) + '</button>';
    });
    if (!seen.merge && !seen.answer && iss.url) acts += '<a class="btn" href="' + esc(iss.url) + '" target="_blank" rel="noopener">Open issue</a>';
    iss.runs.filter(function (r) { return r.agentAlive; }).forEach(function (r) { acts += '<button class="btn cancel" data-exit="' + esc(f.id) + '|' + esc(r.key) + '" data-agent="' + esc(r.agent) + '">✕ Exit ' + esc(r.role || 'agent') + '</button>'; });
    var tail = alerts.map(function (a) { var k = f.id + '|' + a.runKey; return tails[k] ? '<pre>' + esc(tails[k]) + '</pre>' : ''; }).join('');
    var wait = iss.humanWaitMs + (iss.light === 'green' ? 0 : drift());
    return '<div class="alert"><div class="k"><i class="led ' + esc(iss.light) + ' still"></i><b>' + esc(iss.key) + ' ' + esc(iss.title) + (many ? ' · ' + esc(f.name) : '') + '</b><span class="you' + (wait > 1000 ? '' : ' none') + '" title="time a person was waited on">' + (wait > 1000 ? dur(wait) : '0') + '<small>you</small></span></div>' +
      '<a class="open" href="#/i/' + esc(f.id) + '/' + encodeURIComponent(iss.key) + '">' + chips(iss) + '</a><ul class="why">' + lines + '</ul>' + tail + '<div class="acts">' + acts + '</div></div>';
  }
  function section(title, count, body, extra) { return '<section><div class="sub">' + title + ' <span class="n' + (extra && extra.hot ? ' hot' : '') + '">' + count + '</span>' + (extra && extra.more || '') + '</div>' + body + '</section>'; }

  // ------------------------------------------------------------ screens
  function overview() {
    var fs = shown(), many = fs.length > 1, f = current();
    var pickerLabel = f ? f.name : (factories().length ? 'All factories' : 'No factories');
    var head = titlebar('<button class="picker" id="pick"><span class="n">' + esc(pickerLabel) + '</span><span class="chev">▼</span></button>');
    var alerts = [], inflight = [], merged = [], done = [];
    fs.forEach(function (x) {
      var byTask = {};
      x.alerts.forEach(function (a) { (byTask[a.issueKey] = byTask[a.issueKey] || []).push(a); });
      Object.keys(byTask).forEach(function (k) { var iss = x.issues.filter(function (i) { return i.key === k; })[0]; if (iss) alerts.push([x, iss, byTask[k]]); });
      x.issues.forEach(function (i) { (i.bucket === 'inflight' ? inflight : i.bucket === 'merged' ? merged : done).push([x, i]); });
    });
    var body = '';
    if (!factories().length) body += '<div class="empty">No factory has reported yet. Start a watcher with <b>issue-herd</b> in a repository, and it appears here on its first poll.</div>';
    body += section('<i class="led ' + (alerts.length ? 'red' : '') + ' still"></i>Alerts', alerts.length, alerts.length ? '<div class="inset pane">' + alerts.map(function (p) { return taskCard(p[0], p[1], p[2], many); }).join('') + '</div>' : '<div class="inset pane"><div class="empty">Nothing needs you. The factory is running by itself.</div></div>', { hot: alerts.length });
    body += section('Assembling', inflight.length, inflight.length ? '<div class="inset pane">' + inflight.map(function (p) { return row(p[0], p[1], many); }).join('') + '</div>' : '<div class="inset pane"><div class="empty">No issue in flight.</div></div>') +
      '<div class="legend"><span><i class="led green still"></i>working</span><span><i class="led red"></i>blocked</span><span><i class="led yellow"></i>waiting on you</span><span><i class="led"></i>done</span><span><span class="chip empty"><i class="led still"></i>role</span>not started</span><span><span class="you">5m<small>you</small></span>waited on a person</span></div>';
    var out = merged.concat(done);
    var today = out.filter(function (p) { return p[1].finishedAt && Date.now() - Date.parse(p[1].finishedAt) < 86400e3; });
    var list = showAll ? out : today;
    var more = out.length > list.length ? '<button class="more" id="more">Show all ' + out.length + '</button>' : (showAll && out.length > today.length ? '<button class="more" id="more">Today only</button>' : '');
    body += section(showAll ? 'Output' : 'Output today', list.length, list.length ? '<div class="inset pane">' + list.map(function (p) { return row(p[0], p[1], many); }).join('') + '</div>' : '<div class="inset pane"><div class="empty">Nothing finished' + (showAll ? '' : ' today') + '.</div></div>', { more: more });
    var wait = fs.reduce(function (s, x) { return s + x.humanWaitMs; }, 0);
    body += '<div class="foot"><span>' + esc(fs.reduce(function (s, x) { return s + x.counts.running; }, 0)) + ' running · you were waited on for <b>' + dur(wait) + '</b> in total</span><span>' + (f && f.watcher.lastPoll ? 'polled ' + dur(Date.now() - Date.parse(f.watcher.lastPoll)) + ' ago' : '') + '</span></div>';
    return head + belt() + '<div class="body">' + body + '</div>' + (sheet ? pickerSheet() : '');
  }

  function pickerSheet() {
    var opts = factories().map(function (f) {
      var alive = !f.watcher.stale;
      return '<button class="opt' + (f.id === chosen ? ' on' : '') + (alive ? '' : ' stale') + '" data-choose="' + esc(f.id) + '"><i class="led ' + (alive ? 'green' : 'red') + ' still"></i><span class="n">' + esc(f.name) + '</span>' +
        '<span class="c"><span class="pill">' + f.counts.inflight + ' assembling</span>' + (f.counts.alerts ? '<span class="pill hot">' + f.counts.alerts + ' alert' + (f.counts.alerts > 1 ? 's' : '') + '</span>' : '') + '</span>' +
        '<span class="m">' + esc(f.tracker) + ' · ' + esc(f.repo.replace(/^.*\//, '')) + ' · ' + (f.watcher.lastPoll ? (alive ? 'polled ' + dur(Date.now() - Date.parse(f.watcher.lastPoll)) + ' ago' : 'watcher not seen for ' + dur(Date.now() - Date.parse(f.watcher.lastPoll))) : (f.watcher.paneOnly ? 'watcher pane ' + esc(f.watcher.workspaceId || '') + ' open' : 'watcher never seen')) + '</span></button>';
    }).join('');
    if (factories().length > 1) opts = '<button class="opt' + (chosen === 'all' || !current() ? ' on' : '') + '" data-choose="all"><i class="led green still"></i><span class="n">All factories</span><span class="c"><span class="pill">' + factories().reduce(function (s, f) { return s + f.counts.inflight; }, 0) + ' assembling</span></span><span class="m">every factory on ' + esc(document.body.dataset.hostname) + '</span></button>' + opts;
    var f = current(), team = '';
    if (f) team = '<div class="pane"><div class="sub">' + esc(f.name) + ' · ' + f.rules.length + ' rule' + (f.rules.length === 1 ? '' : 's') + (f.maxConcurrent ? ' <span class="n">cap ' + f.maxConcurrent + '</span>' : '') + '</div><div class="inset pane team">' +
      f.rules.map(function (r) { return '<div><b>' + esc(r.role || r.name) + '</b><span><em>' + esc(r.agent + (r.model ? ' ' + r.model : '')) + '</em>' + (r.effort ? ' · ' + esc(r.effort) : '') + (r.basedOn ? ' · basedOn ' + esc(r.basedOn) : '') + ' · ' + esc(r.match) + '</span></div>'; }).join('') +
      '</div><div class="acts" style="margin-top:8px"><span class="pill">' + (f.watcher.version ? 'issue-herd ' + esc(f.watcher.version) : 'version unknown') + '</span>' + (f.watcher.workspaceId ? '<span class="pill">workspace ' + esc(f.watcher.workspaceId) + '</span>' : '') + '</div></div>';
    var lock = document.body.dataset.gated === 'true' ? '<div class="pane"><button class="btn" id="lockbtn">Lock the console</button></div>' : '';
    return '<div class="dimmer" id="dim"></div><div class="sheet" role="dialog" aria-label="Factories"><div class="titlebar"><h1>Factories on ' + esc(document.body.dataset.hostname) + '</h1><span class="drag"></span><button class="tbtn red" id="closesheet" aria-label="close">✕</button></div><div class="pane">' + opts + '</div>' + team + lock + '</div>';
  }

  function detail(fid, key) {
    var f = factoryOf(key, fid), iss = f && f.issues.filter(function (i) { return i.key === key; })[0];
    if (!iss) return titlebar('<h1>' + esc(key) + '</h1>') + '<div class="body"><div class="empty">No such run here. <a href="#/">Back</a></div></div>';
    var head = '<div class="titlebar"><h1>' + esc(iss.key) + '</h1><span class="drag"></span><a class="tbtn red" href="#/" aria-label="back">✕</a></div>';
    var elapsed = iss.finishedAt ? iss.elapsedMs : iss.elapsedMs + drift();
    var lead = iss.runs.filter(function (r) { return r.needsYou; })[0] || iss.runs.filter(function (r) { return r.status === 'running'; })[0] || iss.runs[0];
    var status = '<div class="status"><i class="led ' + esc(iss.light) + (iss.bucket !== 'inflight' ? ' still' : '') + '"></i><b>' + esc(iss.bucket === 'merged' ? 'Merged' : lead.phrase) + '</b>' + (iss.finishedAt ? ' at ' + clock(iss.finishedAt) : '') + ' <small>' + dur(elapsed) + ' end to end</small><span class="you big" title="time a person was waited on">' + dur(iss.humanWaitMs) + '<small>you</small></span></div>';
    var ws = iss.runs.map(function (r) { return r.workspaceId; }).filter(Boolean)[0];
    var links = '<div class="links">' + (iss.url ? '<a href="' + esc(iss.url) + '" target="_blank" rel="noopener">Issue<small>' + esc(iss.key) + '</small></a>' : '<span>Issue<small>no link</small></span>') +
      (iss.prUrl ? '<a href="' + esc(iss.prUrl) + '" target="_blank" rel="noopener">Pull request<small>' + esc(prNum(iss.prUrl)) + (iss.merged ? ' merged' : '') + '</small></a>' : '<span>Pull request<small>none yet</small></span>') +
      (ws ? '<span title="open it in herdr">Workspace<small>' + esc(ws) + '</small></span>' : '<span>Workspace<small>none</small></span>') + '</div>';
    var t0 = Date.parse(iss.startedAt), t1 = iss.finishedAt ? Date.parse(iss.finishedAt) : Date.now(); if (t1 - t0 < 60000) t1 = t0 + 60000;
    var bars = iss.runs.map(function (r) {
      var segs = r.segments.map(function (s) { var l = Math.max(0, (s.from - t0) / (t1 - t0) * 100), w = Math.max(0.5, (Math.min(s.to, t1) - s.from) / (t1 - t0) * 100); return '<i class="' + esc(s.kind) + '" style="left:' + l.toFixed(2) + '%;width:' + w.toFixed(2) + '%"></i>'; }).join('');
      var v = dur((r.finishedAt ? r.elapsedMs : r.elapsedMs + drift())) + ' · ' + esc(r.result ? r.result.status.replace('_', ' ') : r.phrase);
      return '<div class="role"><span class="n">' + esc(r.role || r.rule) + '<small>' + esc(r.agentKind) + (r.pass > 1 ? ' · pass ' + r.pass : '') + '</small></span><div class="bar">' + segs + '</div><span class="v">' + v + '</span></div>';
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
    var results = iss.runs.filter(function (r) { return r.result && r.result.summary; }).map(function (r) { return '<div class="inset pane"><div class="sub" style="padding-top:0">' + esc(r.role || r.rule) + ' · ' + esc(r.result.status.replace('_', ' ')) + '</div><p class="summary">' + esc(r.result.summary) + '</p>' + (r.result.notes ? '<p class="summary" style="color:var(--dim)">' + esc(r.result.notes) + '</p>' : '') + '</div>'; }).join('');
    if (results) results = section('Reports', iss.runs.filter(function (r) { return r.result; }).length, results);
    var live = iss.runs.filter(function (r) { return r.agentAlive; });
    var acts = live.length ? '<div class="acts">' + live.map(function (r) { return '<button class="btn cancel" data-exit="' + esc(f.id) + '|' + esc(r.key) + '" data-agent="' + esc(r.agent) + '">✕ Exit ' + esc(r.role || 'agent') + ' (' + esc(r.agent) + ')</button>'; }).join('') + '</div>' : '';
    return head + belt() + '<div class="ehead"><span class="key">' + esc(f.name) + '</span><h2>' + esc(iss.title) + '</h2>' + status + '</div><div class="body">' + links + roles + change + results + acts + '</div>';
  }

  // ------------------------------------------------------------ render + wiring
  function render() {
    if (!view) return;
    var m = /^#\/i\/([^/]+)\/(.+)$/.exec(location.hash);
    root.innerHTML = m ? detail(decodeURIComponent(m[1]), decodeURIComponent(m[2])) : overview();
  }
  function toast(t) { var el = document.createElement('div'); el.className = 'toast'; el.textContent = t; document.body.appendChild(el); setTimeout(function () { el.remove(); }, 2600); }

  root.addEventListener('click', function (e) {
    var t = e.target.closest('button,a');
    if (!t) return;
    if (t.id === 'pick') { sheet = true; render(); }
    else if (t.id === 'closesheet' || t.id === 'dim') { sheet = false; render(); }
    else if (t.id === 'more') { showAll = !showAll; render(); }
    else if (t.id === 'lockbtn') { fetch('/lock', { method: 'POST' }).then(function () { location.replace('/'); }); }
    else if (t.dataset.choose) { chosen = t.dataset.choose; try { localStorage.setItem('factory', chosen); } catch (x) { /* fine */ } sheet = false; render(); }
    else if (t.dataset.tail) { var p = t.dataset.tail.split('|'); t.disabled = true; fetch('/api/tail?factory=' + encodeURIComponent(p[0]) + '&run=' + encodeURIComponent(p[1])).then(function (r) { return r.json(); }).then(function (j) { tails[t.dataset.tail] = j.text || '(empty)'; render(); }); }
    else if (t.dataset.exit) {
      var q = t.dataset.exit.split('|');
      if (!confirm('Send the exit command to agent ' + t.dataset.agent + '? It shuts itself down the way it wants; the workspace and worktree stay.')) return;
      t.disabled = true;
      fetch('/api/exit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ factory: q[0], run: q[1] }) })
        .then(function (r) { return r.json(); }).then(function (j) { toast(j.ok ? 'Agent ' + t.dataset.agent + ' ' + j.outcome : 'Could not exit: ' + (j.error || 'unknown')); }).catch(function () { toast('The console did not answer.'); });
    }
  });
  document.getElementById('app').addEventListener('click', function (e) { if (e.target.id === 'dim') { sheet = false; render(); } });
  window.addEventListener('hashchange', render);
  setInterval(function () { if (view && !sheet) render(); }, 30000); // elapsed times tick even when nothing changed

  function connect() {
    var es = new EventSource('/api/events');
    es.addEventListener('state', function (ev) { view = JSON.parse(ev.data); receivedAt = Date.now(); if (chosen && chosen !== 'all' && !current()) chosen = factories().length === 1 ? factories()[0].id : 'all'; render(); });
    es.onerror = function () { es.close(); fetch('/api/state').then(function (r) { if (r.status === 401) location.replace('/'); }).catch(function () {}); setTimeout(connect, 3000); };
  }
  connect();
})();
