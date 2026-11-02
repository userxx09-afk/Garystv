// App shell: screen switching, remote-style keys, live updates from the
// engine, and the record / series-timer dialogs shared by several screens.
/* global HomeView, GuideView, DvrView, TimersView, SearchView, SettingsView, MoviesView, ShowsView, Player */
const VIEWS = { home: HomeView, guide: GuideView, movies: MoviesView, shows: ShowsView, dvr: DvrView, timers: TimersView, search: SearchView, settings: SettingsView };

const App = {
  state: null, recordings: [], schedule: [], guideRows: [], view: null, viewName: 'home', history: [], lastChannel: null,

  async loadAll() {
    [this.state, this.recordings, this.schedule] = await Promise.all([api.get('/api/state'), api.get('/api/recordings'), api.get('/api/schedule')]);
    if (!this.guideRows.length) this.guideRows = await api.get(`/api/guide?from=${Date.now()}&to=${Date.now() + 3600000}`);
    const n = this.recordings.filter((r) => r.status === 'recording').length;
    $('#recInd').classList.toggle('on', n > 0);
    $('#recText').textContent = n > 1 ? `Recording ${n} shows` : 'Recording';
  },

  go(name, { push = true } = {}) {
    if (!VIEWS[name]) name = 'home';
    if (Player.mode === 'full' || (Player.mode === 'pip' && name !== 'guide')) Player.stop();
    if (push && this.viewName !== name) this.history.push(this.viewName);
    this.viewName = name;
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    this.render();
  },

  back() {
    if (Modal.closeTop()) return;
    if (Player.mode === 'pip') { Player.setMode('full'); Player.showOsd(); return; }
    const prev = this.history.pop();
    if (!prev && this.viewName === 'home' && window.GTV_EXIT) { window.GTV_EXIT(); return; } // TV: Back on Home leaves the app
    this.go(prev || 'home', { push: false });
  },

  async render(focusKey) {
    const view = VIEWS[this.viewName];
    const changedView = this.view !== view;
    this.view = view;
    const keep = focusKey || (changedView ? null : Nav.key());
    $('#crumb').textContent = view.title;
    setHints(view.hints);
    Nav.current = null;
    await view.render($('#view'));
    if (view !== GuideView) Nav.restore(keep);
  },

  // ---------- recording actions ----------
  jobFor(row, p) { return this.schedule.find((j) => j.id === `${row.id}@${p.start}`); },
  seriesRuleFor(p) {
    const t = (p.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return this.state.rules.find((r) => r.type === 'series' && r.title.toLowerCase().replace(/[^a-z0-9]/g, '') === t);
  },

  async recordOnce(row, p) {
    await api.post('/api/rules', {
      type: 'once', channelId: row.id, start: p.start, end: p.end, title: p.title, subtitle: p.subtitle || '', desc: p.desc || '',
      season: p.season ?? null, episode: p.episode ?? null, categories: p.categories || [], isNew: !!p.isNew, programId: p.programId || '',
    });
    toast(`● Will record ${p.title}`);
    await this.loadAll();
  },

  async cancelProgram(row, p) {
    const job = this.jobFor(row, p);
    if (!job) return;
    if (job.ruleType === 'once') await api.del(`/api/rules/${job.ruleId}`);
    else await api.post('/api/jobs/skip', { id: job.id });
    toast(`Won't record ${p.title}`);
    await this.loadAll();
  },

  // R in the guide: none -> this show; this show -> whole series; series -> cancel.
  async quickRecord(row, p) {
    if (row && p && p.filler) return this.manualDialog(row.id); // no listing: record by time instead
    if (!row || !p) return;
    if (p.end < Date.now()) return toast('That show is over.');
    const job = this.jobFor(row, p);
    try {
      if (!job || job.status === 'skipped') {
        if (job && job.status === 'skipped') await api.post('/api/jobs/skip', { id: job.id, skip: false });
        else await this.recordOnce(row, p);
      } else if (job.ruleType === 'once') {
        await api.del(`/api/rules/${job.ruleId}`);
        await api.post('/api/rules', { type: 'series', title: p.title, channelId: row.id, newOnly: true, keep: 0 });
        toast(`●● Will record new episodes of ${p.title}`);
      } else {
        const rule = this.state.rules.find((r) => r.id === job.ruleId);
        if (rule && await Modal.confirm('Cancel series timer?', `Stop recording "${rule.title}"? Existing recordings are kept.`, 'Cancel series')) {
          await api.del(`/api/rules/${rule.id}`);
          toast('Series timer cancelled');
        }
      }
    } catch (e) { toast(e.message); }
    await this.loadAll();
  },

  async programDialog(row, p) {
    if (p.filler) return;
    const now = Date.now();
    const airing = p.start <= now && now < p.end;
    const job = this.jobFor(row, p);
    const series = this.seriesRuleFor(p);
    const choices = [];
    if (airing) choices.push({ label: '▶  Watch now', value: 'watch', cls: 'primary' });
    if (job && job.status !== 'skipped') choices.push({ label: job.status === 'recording' ? '■  Stop recording this show' : '✕  Don\'t record this show', value: 'cancel', cls: 'danger' });
    else if (p.end > now) choices.push({ html: '<span class="dot"></span> Record this show', value: 'once', cls: airing ? '' : 'primary' });
    choices.push(series ? { html: '<span class="dot series"></span> Change series timer', value: 'series' } : { html: '<span class="dot series"></span> Record series...', value: 'series' });
    choices.push({ label: 'Close', value: null });
    const body = `<div class="sub">${esc([fmt.se(p), p.subtitle].filter(Boolean).join('  ·  '))}</div>
      <div class="meta" style="color:var(--muted)">${esc(row.number)} ${esc(row.name)} · ${fmt.day(p.start)} ${fmt.range(p.start, p.end)} ${p.isNew ? '<span class="tag new">NEW</span>' : ''}</div>
      <div class="s" style="color:#c4d1e6;line-height:1.5">${esc(p.desc || '')}</div>
      ${job && job.reason ? `<div style="color:var(--yellow)">${esc(job.reason)}</div>` : ''}`;
    const v = await Modal.menu(p.title, body, choices);
    try {
      if (v === 'watch') Player.play('live', row.id);
      if (v === 'once') await this.recordOnce(row, p);
      if (v === 'cancel') await this.cancelProgram(row, p);
      if (v === 'series') await this.seriesDialog(row, p, series);
    } catch (e) { toast(e.message); }
  },

  seriesDialog(row, p, existing) {
    const o = existing ? { ...existing } : { newOnly: true, channelId: row ? row.id : null, keep: 0, prePad: null, postPad: null };
    return Modal.open((m, close) => {
      m.innerHTML = `<div class="title">${existing ? 'Series timer' : 'Record series'}: ${esc(p.title)}</div><div class="s">Use ←/→ to change an option.</div><div class="menu-list" id="opts"></div>
        <div class="actions"><div class="btn nav primary" id="ok">${existing ? 'Save timer' : 'Create timer'}</div>${existing ? '<div class="btn nav danger" id="del">Delete timer</div>' : ''}<div class="btn nav" id="cx">Cancel</div></div>`;
      const opts = $('#opts', m);
      const idx = (vals, v) => Math.max(0, vals.findIndex((x) => x.value === v));
      const add = (label, vals, key) => opts.appendChild(optionRow(label, vals, idx(vals, o[key]), (v) => { o[key] = v; }));
      add('Episodes', [{ label: 'New only', value: true }, { label: 'All (including reruns)', value: false }], 'newOnly');
      if (row) add('Channel', [{ label: `${row.number} ${row.name} only`, value: row.id }, { label: 'Any channel', value: null }], 'channelId');
      add('Keep', [{ label: 'All episodes', value: 0 }, { label: 'Latest 3', value: 3 }, { label: 'Latest 5', value: 5 }, { label: 'Latest 10', value: 10 }], 'keep');
      add('Start early', [{ label: 'Default', value: null }, { label: 'On time', value: 0 }, { label: '2 min', value: 2 }, { label: '5 min', value: 5 }], 'prePad');
      add('End late', [{ label: 'Default', value: null }, { label: 'On time', value: 0 }, { label: '5 min', value: 5 }, { label: '15 min', value: 15 }, { label: '30 min', value: 30 }, { label: '1 hour', value: 60 }], 'postPad');
      $('#cx', m).onclick = () => close();
      if (existing) $('#del', m).onclick = async () => { await api.del(`/api/rules/${existing.id}`); toast('Series timer deleted'); close(true); };
      $('#ok', m).onclick = async () => {
        const body = { type: 'series', title: p.title, newOnly: o.newOnly, channelId: o.channelId, keep: o.keep, prePad: o.prePad, postPad: o.postPad };
        try {
          if (existing) await api.put(`/api/rules/${existing.id}`, body);
          else await api.post('/api/rules', body);
          toast(`●● Series timer ${existing ? 'saved' : 'set'} for ${p.title}`);
          close(true);
        } catch (e) { toast(e.message); }
      };
    });
  },

  // channelId: start with that channel picked (e.g. from the red button on a channel without listings)
  manualDialog(channelId) {
    const chans = (this.guideRows.length ? this.guideRows : this.state.channels.filter((c) => !c.hidden));
    if (!chans.length) return toast('Add a tuner or provider first.');
    const pick = chans.find((c) => c.id === channelId);
    const d = new Date(Date.now() + 3600000);
    const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const o = { channelId: (pick || chans[0]).id, time: `${String(d.getHours()).padStart(2, '0')}:00`, minutes: 60, repeat: 'once' };
    return Modal.open((m, close) => {
      m.innerHTML = `<div class="title">Manual timer</div><div class="s">Record a channel at a set time, even without guide listings.</div>
        <div class="field"><label>Name</label><input id="mn" value="${esc(pick ? pick.name : 'Manual recording')}"></div>
        <div class="field"><label>Channel</label><select id="mc">${chans.map((c) => `<option value="${esc(c.id)}"${c.id === o.channelId ? ' selected' : ''}>${esc(c.number)} ${esc(c.name)}</option>`).join('')}</select></div>
        <div class="row"><div class="field"><label>Date</label><input id="md" type="date" value="${localDate}"></div>
          <div class="field"><label>Start time</label><input id="mt" type="time" value="${o.time}"></div>
          <div class="field"><label>Minutes</label><input id="mm" type="number" min="5" value="60"></div></div>
        <div class="field"><label>Repeat</label><select id="mr"><option value="once">Just once</option><option value="daily">Every day</option><option value="weekdays">Weekdays (Mon-Fri)</option><option value="weekly">Same day every week</option></select></div>
        <div class="actions"><div class="btn nav primary" id="ok">Create timer</div><div class="btn nav" id="cx">Cancel</div></div>`;
      $('#cx', m).onclick = () => close();
      $('#ok', m).onclick = async () => {
        const date = $('#md', m).value;
        const rep = $('#mr', m).value;
        const dow = new Date(`${date}T12:00`).getDay();
        const days = rep === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : rep === 'weekdays' ? [1, 2, 3, 4, 5] : rep === 'weekly' ? [dow] : [];
        await api.post('/api/rules', { type: 'manual', title: $('#mn', m).value.trim() || 'Manual recording', channelId: $('#mc', m).value, time: $('#mt', m).value, minutes: +$('#mm', m).value || 60, days, date: rep === 'once' ? date : null });
        toast('Manual timer set');
        close(true);
      };
    });
  },
};

// ---------- keys ----------
document.addEventListener('keydown', (e) => {
  const a = document.activeElement;
  const typing = a && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName);
  if (typing) {
    if (App.view && App.view.onKey && !Modal.top() && App.view.onKey(e)) e.preventDefault();
    else if (e.key === 'Escape') { a.blur(); if (!a.value && !Modal.top()) App.back(); e.preventDefault(); } // empty box: Back leaves the screen
    return;
  }
  if (Player.onKey(e)) { e.preventDefault(); return; }
  if (Modal.top()) {
    if (e.key === 'Escape' || e.key === 'Backspace') { Modal.closeTop(); e.preventDefault(); return; }
    if (Nav.handle(e)) e.preventDefault();
    return;
  }
  if (App.view && App.view.onKey && App.view.onKey(e)) { e.preventDefault(); return; }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const jumps = { g: 'guide', d: 'dvr', t: 'timers', s: 'search', h: 'home', Home: 'home', F1: 'guide' };
  if (jumps[k] && !(e.ctrlKey || e.altKey)) { App.go(jumps[k]); e.preventDefault(); return; }
  if (k === 'Escape' || k === 'Backspace') { App.back(); e.preventDefault(); return; }
  if (Nav.handle(e)) e.preventDefault();
});

// ---------- live updates ----------
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await App.loadAll();
    if (Modal.top()) return; // don't redraw under an open dialog
    if (App.view === GuideView) GuideView.refresh();
    else if (App.view !== SearchView) App.render();
  }, 300);
}
function connectEvents() {
  const es = new EventSource(server('/events'));
  es.onmessage = scheduleRefresh;
  es.onerror = () => { es.close(); setTimeout(connectEvents, 3000); };
}

function tickClock() {
  const d = new Date();
  $('#clock').innerHTML = `<small>${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</small>${fmt.time(d)}`;
}

(async function start() {
  tickClock();
  setInterval(tickClock, 15000);
  setInterval(() => { if (App.view === GuideView && !Modal.top()) GuideView.tick(); }, 60000);
  await window.GTV_READY; // TV app: wait until it has found the PC
  await App.loadAll();
  App.viewName = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'home';
  await App.render();
  connectEvents();
})();
