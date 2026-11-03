// App shell: screen switching, remote-style keys, live updates from the
// engine, and the record / series-timer dialogs shared by several screens.
/* global HomeView, GuideView, DvrView, TimersView, SearchView, SettingsView, MoviesView, ShowsView, Player, Updates */
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

  go(name, { push = true, focus = null } = {}) {
    if (!VIEWS[name]) name = 'home';
    if (Player.mode === 'full' || (Player.mode === 'pip' && name !== 'guide')) Player.stop();
    if (push && this.viewName !== name) this.history.push(this.viewName);
    this.viewName = name;
    if (location.hash !== `#${name}`) history.replaceState(history.state, '', `#${name}`);
    this.render(focus);
  },

  // Hold ←: to the top of the list you're in (the guide: the first channel). A screen can
  // have its own toTop(); otherwise the first item of the list holding the highlight.
  toTop() {
    if (!Modal.top() && this.view && this.view.toTop && this.view.toTop()) return;
    const box = Nav.current && Nav.current.closest('.list, .menu-list, .posters, .cards, .tiles, .seasons, .pad, .g-bar, .menu, .tabs');
    if (box) box.scrollTop = 0;
    Nav.focus((box && $('.nav', box)) || Nav.items()[0]);
  },

  // The logo: straight to Home from anywhere, closing whatever is open.
  home() {
    while (Modal.closeTop());
    if (Player.mode !== 'off') Player.stop();
    for (const v of [MoviesView, ShowsView]) { v.show = null; v.fromElsewhere = false; }
    DvrView.folder = null;
    this.history = [];
    this.go('home', { push: false });
  },

  // Hold OK (TV), M, right-click or a long press: what you can do here, then where you can go.
  // A screen's menu() -> { title, body, items: [{ label, run, cls }] } for what's highlighted.
  async menu() {
    if (Modal.top()) return;
    const view = this.view;
    let own = {};
    try { own = (view.menu && await view.menu()) || {}; } catch (e) { toast(e.message); }
    const items = (own.items || []).map((c) => ({ ...c, value: c.run }));
    const places = [['home', '⌂ Home'], ['guide', '▦ Guide'], ['movies', '🎬 Movies'], ['shows', '📺 Shows'], ['dvr', '● My Recordings'], ['search', '⌕ Search'], ['settings', '⚙ Settings']]
      .filter(([k]) => k !== this.viewName || (view.show || view.folder));
    places.forEach(([k, label], i) => items.push({ label, value: () => (k === 'home' ? this.home() : this.go(k)), cls: i === 0 ? 'gap' : '' }));
    if (window.GTV_SWITCH) items.push({ label: '⇄ Connect to a different GarysTV...', value: () => window.GTV_SWITCH() });
    items.push({ label: 'Close', value: null });
    const run = await Modal.menu(own.title || view.title || 'Menu', own.body || '', items);
    if (typeof run === 'function') {
      try { await run(); } catch (e) { toast(e.message); }
    }
  },

  back() {
    if (Modal.closeTop()) return;
    if (Player.mode === 'full') { Player.stop(); this.render(); return; }
    if (this.view && this.view.onBack && this.view.onBack()) return; // a screen's own step back (a folder, a show)
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

  // Favorites choices for a channel: in or out of each list; with no list yet, one called
  // Favorites is made. after(): what to do once it's changed (the guide redraws).
  channelFavItems(ch, after = () => this.loadAll()) {
    const lists = this.state.favLists || [];
    const toggle = async (l, on) => {
      const res = await api.post(`/api/favlists/${l.id}/toggle`, { channelId: ch.id, ...(on != null ? { on } : {}) });
      toast(res.on ? `★ Added ${ch.name} to ${l.name}` : `Took ${ch.name} off ${l.name}`);
      await after();
    };
    if (!lists.length) {
      return [{ label: `★ Add ${ch.name} to Favorites`, run: async () => { const l = await api.post('/api/favlists', { name: 'Favorites' }); await toggle(l, true); } }];
    }
    return lists.map((l) => {
      const on = l.channelIds.includes(ch.id);
      return { label: on ? `★ Take ${ch.name} off ${l.name}` : `☆ Add ${ch.name} to ${l.name}`, run: () => toggle(l) };
    });
  },

  // Your own number for just this channel (101 KAAL can be 6); the provider's is kept.
  // after(number): what to do once it's changed.
  numberItem(ch, after = () => this.loadAll()) {
    const c = this.state.channels.find((x) => x.id === ch.id);
    if (!c) return [];
    return [{ label: `🔢 Change channel number (now ${c.number})...`, run: async () => { const done = await SettingsView.numberDialog(c); if (done) await after(done.number); } }];
  },

  // Recording choices for a channel and the show on it, for the hold-OK menus.
  recordItems(row, p) {
    const now = Date.now();
    const items = [];
    const active = this.recordings.find((r) => r.status === 'recording' && r.channelId === row.id);
    if (active) {
      items.push({
        label: `■ Stop recording "${active.title}"`, cls: 'danger',
        run: async () => {
          const rule = this.state.rules.find((x) => x.id === active.ruleId);
          if (rule && rule.type === 'once') await api.del(`/api/rules/${rule.id}`);
          else await api.post('/api/jobs/skip', { id: active.jobId });
          toast('Recording stopped. It is saved in My Recordings.');
          await this.loadAll();
        },
      });
    }
    if (p && !p.filler && p.end > now) {
      const job = this.jobFor(row, p);
      if (job && job.status !== 'skipped') {
        if (job.status !== 'recording') items.push({ label: `✕ Don't record "${p.title}"`, run: () => this.cancelProgram(row, p) });
      } else items.push({ label: `● Record "${p.title}"`, run: () => this.recordOnce(row, p) });
      const series = this.seriesRuleFor(p);
      items.push({ label: series ? '●● Change the series timer...' : `●● Record every episode of "${p.title}"...`, run: () => this.seriesDialog(row, p, series) });
    }
    items.push({ label: '● Record now for...', run: () => this.recordNowMenu(row, p) });
    items.push({ label: '⏱ Record at a set time...', run: () => this.manualDialog(row.id) });
    return items;
  },

  // The on-screen number pad: type a channel number with the arrows and OK (a Fire TV remote
  // has no number buttons), the mouse, a finger, or the number keys. Shows the channel as you
  // type. -> the channel picked, or null. first: a digit already pressed.
  channelPad(first = '', title = 'Go to channel') {
    const all = GuideView.all.length ? GuideView.all : this.guideRows.length ? this.guideRows : this.state.channels.filter((c) => !c.hidden);
    const find = (n) => n && (all.find((c) => String(c.number) === n) || all.find((c) => String(c.number).startsWith(n)));
    let typed = String(first);
    return Modal.open((m, close) => {
      const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];
      m.classList.add('pad-modal');
      m.innerHTML = `<div class="title">${esc(title)}</div>
        <div class="pad-show"><div class="pad-num" id="padNum"></div><div class="pad-ch" id="padCh"></div></div>
        <div class="pad">${keys.map((k) => `<div class="btn nav pad-key" data-k="${k}" data-key="pk-${k}">${k}</div>`).join('')}</div>
        <div class="actions"><div class="btn nav primary" id="padGo" data-key="pk-go">Go</div><div class="btn nav" id="padCancel">Cancel</div></div>`;
      const paint = () => {
        const c = find(typed);
        $('#padNum', m).textContent = typed || '–';
        $('#padCh', m).innerHTML = !typed ? 'Type a channel number' : c ? `${esc(c.number)} ${esc(c.name)}` : '<span style="color:var(--yellow)">No channel with that number</span>';
      };
      const press = (k) => {
        if (k === '⌫') typed = typed.slice(0, -1);
        else if (typed.length < 7) typed += k;
        paint();
      };
      const go = () => { const c = find(typed); if (c) close(c); else toast(typed ? `No channel ${typed}` : 'Type a channel number first'); };
      $$('.pad-key', m).forEach((b) => { b.onclick = () => press(b.dataset.k); });
      $('#padGo', m).onclick = go;
      $('#padCancel', m).onclick = () => close(null);
      // Number keys (keyboard, Samsung remote) type straight in; Backspace deletes.
      m.addEventListener('pad-key', (e) => { if (e.detail === 'go') go(); else press(e.detail); });
      paint();
      setTimeout(() => Nav.focus(typed ? $('#padGo', m) : $('[data-k="1"]', m)), 0);
    });
  },

  // Starts now and ends exactly when chosen: no early/late padding.
  async recordNowMenu(row, p) {
    const choices = [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [180, '3 hours'], [240, 'Until I stop it (up to 4 hours)']]
      .map(([min, label]) => ({ label: `● ${label}`, value: min }));
    const min = await Modal.menu(`Record ${row.number} ${row.name} now`, '', [...choices, { label: 'Cancel', value: null }]);
    if (!min) return;
    const now = Date.now();
    await api.post('/api/rules', { type: 'once', channelId: row.id, start: now, end: now + min * 60000, title: p && !p.filler ? p.title : row.name, prePad: 0, postPad: 0, categories: [] });
    toast(min === 240 ? 'Recording until you stop it.' : `Recording ${row.name} for ${choices.find((c) => c.value === min).label.slice(2)}`);
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
// Holding ← (the remote repeats it while held; a key-up isn't always sent): after a moment,
// jump to the top. Key repeats (or presses very close together) count as one hold.
const held = { start: 0, last: 0, fired: 0 };
function heldLeft(e) {
  if (e.key !== 'ArrowLeft') { held.start = 0; return false; }
  const now = Date.now();
  if (!held.start || (!e.repeat && now - held.last > 120)) Object.assign(held, { start: now, fired: 0 }); // quick taps stay taps
  held.last = now;
  if (!held.fired && now - held.start > 700) held.fired = 1;
  return held.fired > 0;
}
document.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft') held.start = 0; });

document.addEventListener('keydown', (e) => {
  const a = document.activeElement;
  const typing = a && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName);
  if (typing) {
    if (App.view && App.view.onKey && !Modal.top() && App.view.onKey(e)) e.preventDefault();
    else if (e.key === 'Escape') { a.blur(); App.back(); e.preventDefault(); }
    return;
  }
  if (Player.onKey(e)) { e.preventDefault(); return; } // while watching, holding ← keeps rewinding
  if (heldLeft(e)) { if (held.fired === 1) { held.fired = 2; App.toTop(); } e.preventDefault(); return; }
  if (Modal.top()) {
    const pad = $('.modal-bg:last-of-type .pad-modal');
    if (pad && /^[0-9.]$|^Backspace$/.test(e.key)) { pad.dispatchEvent(new CustomEvent('pad-key', { detail: e.key === 'Backspace' ? '⌫' : e.key })); e.preventDefault(); return; }
    if (e.key === 'Escape' || e.key === 'Backspace') { Modal.closeTop(); e.preventDefault(); return; }
    if (Nav.handle(e)) e.preventDefault();
    return;
  }
  if (App.view && App.view.onKey && App.view.onKey(e)) { e.preventDefault(); return; }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if ((k === 'ContextMenu' || k === 'm') && !(e.ctrlKey || e.altKey)) { App.menu(); e.preventDefault(); return; }
  const jumps = { g: 'guide', d: 'dvr', t: 'timers', s: 'search', h: 'home', Home: 'home', F1: 'guide' };
  if (jumps[k] && !(e.ctrlKey || e.altKey)) { App.go(jumps[k]); e.preventDefault(); return; }
  if (k === 'Escape' || k === 'Backspace') { App.back(); e.preventDefault(); return; }
  if (Nav.handle(e)) e.preventDefault();
});

// ---------- mouse, touch and the browser's Back ----------
// Holding the mouse button or a finger on something (or right-clicking it) is the same as
// holding OK on the remote: it's highlighted and the menu comes up.
const press = { timer: null, held: false, x: 0, y: 0 };
function pick(target) {
  const el = target.closest && target.closest('.nav');
  if (el && Nav.scope().contains(el)) Nav.focus(el, { scroll: false });
  const cell = target.closest && target.closest('.g-p');
  if (cell && App.view === GuideView) GuideView.select(cell);
}
function holdMenu(target) {
  if (Modal.top() || !$('#app').contains(target)) return;
  press.held = true;
  pick(target);
  App.menu();
}
document.addEventListener('pointerdown', (e) => {
  clearTimeout(press.timer);
  press.held = false;
  if (e.button !== 0) return;
  Object.assign(press, { x: e.clientX, y: e.clientY });
  press.timer = setTimeout(() => holdMenu(e.target), 650);
});
document.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 12) clearTimeout(press.timer); });
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, () => clearTimeout(press.timer)));
document.addEventListener('contextmenu', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return; // copy and paste
  e.preventDefault();
  clearTimeout(press.timer);
  if (!press.held) holdMenu(e.target);
});
// The click that ends a long press doesn't also open what was under it.
document.addEventListener('click', (e) => { if (press.held) { press.held = false; e.stopPropagation(); e.preventDefault(); } }, true);

$('#brand').onclick = () => App.home();
$('#topnav').onclick = (e) => {
  const t = e.target.closest('[data-top]');
  if (!t) return;
  const k = t.dataset.top;
  if (k === 'back') App.back();
  else if (k === 'home') App.home();
  else if (k === 'menu') App.menu();
  else App.go(k);
};

// A phone or browser's own Back button steps back in GarysTV instead of leaving the page
// (one extra history entry is kept for it; on Home with nothing open it leaves as usual).
function atStart() { return !Modal.top() && Player.mode === 'off' && App.viewName === 'home' && !App.history.length; }
window.addEventListener('popstate', () => {
  if (atStart()) return;
  App.back();
  history.pushState({ gtv: 1 }, '', location.hash);
});

// ---------- live updates ----------
let refreshTimer;
// What changed decides what the screens must read again: new channels or listings mean the
// guide (and, for a new provider, its movies and shows) are out of date.
function onEvent(e) {
  let what = '';
  try { what = JSON.parse(e.data).what; } catch (_) { /* a plain ping */ }
  if (['channels', 'sources', 'guides'].includes(what)) { GuideView.loaded = [0, 0]; App.guideRows = []; }
  if (what === 'sources') for (const v of [MoviesView, ShowsView]) { v.cats = null; v.items = {}; }
  scheduleRefresh();
}
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
  es.onmessage = onEvent;
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
  try { App.lastChannel = localStorage.getItem('gtv.lastChannel'); } catch (_) { /* private mode */ }
  if (!App.state.channels.some((c) => c.id === App.lastChannel)) App.lastChannel = null;
  // A reload keeps the screen you were on; a fresh start opens what Settings > When it starts says.
  const fresh = !VIEWS[location.hash.slice(1)], start = startChoice();
  if (start.list !== 'last') GuideView.setList(start.list || null);
  App.viewName = !fresh ? location.hash.slice(1) : start.open === 'home' ? 'home' : 'guide';
  await App.render();
  if (fresh && start.open === 'live' && App.lastChannel) Player.play('live', App.lastChannel);
  if (!window.GTV_SERVER) history.pushState({ gtv: 1 }, '', location.hash); // the TV apps have their own Back
  Updates.startCheck();
  connectEvents();
})();
