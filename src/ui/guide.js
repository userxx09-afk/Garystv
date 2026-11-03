// The program guide: channels down the side, 90 minutes across the top,
// a details panel with a picture-in-picture preview above (DISH-style).
/* global App, Player */
const SLOT = 30 * 60000;
const SPAN = 3 * SLOT;
const align = (t) => Math.floor(t / SLOT) * SLOT;

const GuideView = {
  ws: align(Date.now()), row: 0, top: 0, t: Date.now(), rows: [], all: [], loaded: [0, 0], visible: 7,
  listId: (() => { try { return localStorage.getItem('gtv.favlist'); } catch (_) { return null; } })(), // favorites list shown, or all channels
  filter: (() => { try { return localStorage.getItem('gtv.filter'); } catch (_) { return null; } })(), // one channel group, or all
  inBar: false, // the remote is on the bar above the guide

  get list() { return ((App.state && App.state.favLists) || []).find((l) => l.id === this.listId) || null; },
  get title() { return ['Guide', this.list && this.list.name, this.filterLabel].filter(Boolean).join(' › '); },
  hints: [['↑↓←→', 'Move'], ['OK', 'Options'], ['R', 'Record', 'k-red'], ['M', 'Menu'], ['PgUp/PgDn', 'Page'], ['[ ]', 'Day'], ['#', 'Channel #'], ['Esc', 'Back']],

  // Show one favorites list (or all channels with null). Watching from it, channel up/down stays in it.
  // keepId: stay on that channel if it's still shown.
  setList(id, keepId) {
    this.listId = id || null;
    if (!this.list) this.listId = null; // deleted meanwhile
    try { if (this.listId) localStorage.setItem('gtv.favlist', this.listId); else localStorage.removeItem('gtv.favlist'); } catch (_) { /* private mode */ }
    this.applyList();
    const at = keepId ? this.rows.findIndex((r) => r.id === keepId) : -1;
    this.row = Math.max(0, at); this.top = 0;
    if (App.view === this) { $('#crumb').textContent = this.title; this.paintBar(); this.paint(); }
  },

  applyList() {
    const l = this.list, f = this.filter;
    this.rows = this.all.filter((r) => (!l || l.channelIds.includes(r.id)) && (!f || inFilter(r, f)));
    App.guideRows = this.rows;
  },

  // ---------- categories: Sports, News, Movies... and, inside each, the provider's own groups ----------
  // filter: a category name ("Sports"), or "group:" + one provider group ("group:US| ESPN PLUS").
  get filterLabel() { return !this.filter ? '' : this.filter.startsWith('group:') ? groupLabel(this.filter.slice(6)) : this.filter; },

  setFilter(f) {
    this.filter = f || null;
    try { if (this.filter) localStorage.setItem('gtv.filter', this.filter); else localStorage.removeItem('gtv.filter'); } catch (_) { /* private mode */ }
    this.setList(this.listId);
  },

  // -> [{ name, n, groups: [{ raw, label, n }] }], biggest first (within the favorites list shown)
  categoryTree() {
    const l = this.list;
    const cats = new Map();
    for (const r of this.all) {
      if (l && !l.channelIds.includes(r.id)) continue;
      const name = categoryOf(r);
      if (!cats.has(name)) cats.set(name, { name, n: 0, groups: new Map() });
      const c = cats.get(name);
      c.n++;
      if (r.group) c.groups.set(r.group, (c.groups.get(r.group) || 0) + 1);
    }
    return [...cats.values()].sort((a, b) => (a.name === 'Other') - (b.name === 'Other') || b.n - a.n)
      .map((c) => ({ ...c, groups: [...c.groups].map(([raw, n]) => ({ raw, n, label: groupLabel(raw) })).sort((a, b) => b.n - a.n) }));
  },

  // The Categories button: categories down the left; the highlighted one's groups on the right.
  categoryPicker() {
    const tree = this.categoryTree();
    const total = tree.reduce((s, c) => s + c.n, 0);
    const cur = this.filter;
    return Modal.open((m, close) => {
      m.classList.add('cat-modal');
      m.innerHTML = `<div class="title">Categories${this.list ? ` in ${esc(this.list.name)}` : ''}</div>
        <div class="s">Pick a category, or → for the provider's groups inside it.</div>
        <div class="cat-cols"><div class="menu-list" id="catL"></div><div class="menu-list" id="catR"></div></div>`;
      const left = $('#catL', m), right = $('#catR', m);
      const item = (html, on, attrs) => `<div class="btn nav${on ? ' primary' : ''}" ${attrs}>${html}</div>`;
      const count = (n) => `<span class="cnt">${n}</span>`;
      left.innerHTML = item(`All channels ${count(total)}`, !cur, 'data-key="cat-all" data-cat=""')
        + tree.map((c) => item(`${esc(c.name)} ${count(c.n)}`, cur === c.name, `data-key="cat-${esc(c.name)}" data-cat="${esc(c.name)}"`)).join('');
      const showGroups = (name) => {
        const c = tree.find((x) => x.name === name);
        right.innerHTML = !c ? '<div class="s">Every channel, in every category.</div>'
          : item(`All ${esc(c.name)} ${count(c.n)}`, cur === c.name, `data-cat="${esc(c.name)}"`)
            + c.groups.map((g) => item(`${esc(g.label)} ${count(g.n)}`, cur === `group:${g.raw}`, `data-group="${esc(g.raw)}"`)).join('');
        $$('[data-cat]', right).forEach((el) => { el.onclick = () => close(el.dataset.cat); });
        $$('[data-group]', right).forEach((el) => { el.onclick = () => close(`group:${el.dataset.group}`); });
      };
      $$('[data-cat]', left).forEach((el) => {
        el.onclick = () => close(el.dataset.cat);
        el._onFocus = () => showGroups(el.dataset.cat);
      });
      const curCat = !cur ? '' : cur.startsWith('group:') ? categoryOf({ group: cur.slice(6) }) : cur;
      setTimeout(() => Nav.focus($(`[data-cat="${CSS.escape(curCat)}"]`, left) || $('[data-cat]', left)), 0);
    }).then((v) => { if (v != null) this.setFilter(v || null); });
  },

  // The bar above the guide: every channel, each favorites list, categories, a channel number.
  paintBar() {
    const bar = $('#gbar');
    if (!bar) return;
    const lists = (App.state && App.state.favLists) || [];
    const chip = (key, on, label, attr = '') => `<span class="chip nav${on ? ' on' : ''}" data-key="${key}" ${attr}>${label}</span>`;
    bar.innerHTML = chip('gb-all', !this.list, 'All channels', 'data-list=""')
      + lists.map((l) => chip(`gb-${esc(l.id)}`, this.listId === l.id, `★ ${esc(l.name)}`, `data-list="${esc(l.id)}"`)).join('')
      + chip('gb-cats', !!this.filter, `▦ ${this.filter ? esc(this.filterLabel) : 'Categories'}`, 'id="gcats"')
      + (this.filter ? chip('gb-clear', false, '✕', 'id="gclear" title="Show every category"') : '')
      + '<span class="spacer"></span>'
      + chip('gb-pad', false, '🔢 Channel #', 'id="gpad"');
    $$('[data-list]', bar).forEach((el) => { el.onclick = () => { this.setList(el.dataset.list || null); this.refocusBar(); }; });
    $('#gcats', bar).onclick = () => this.categoryPicker().then(() => this.refocusBar());
    $('#gpad', bar).onclick = () => this.pad();
    const clr = $('#gclear', bar);
    if (clr) clr.onclick = () => { this.setFilter(null); this.refocusBar(); };
  },
  refocusBar() { if (this.inBar) Nav.focus($('#gbar .chip.on') || $('#gbar .chip')); },

  // A click or long press on a show: highlight it.
  select(el) {
    this.inBar = false;
    this.row = +el.dataset.r;
    this.t = Math.max(+el.dataset.s, this.ws);
    this.paint();
  },

  inAnyList(id) { return ((App.state && App.state.favLists) || []).some((l) => l.channelIds.includes(id)); },

  async load(force) {
    const from = align(Date.now()) - SLOT;
    const need = this.ws + SPAN;
    if (!force && this.ws >= this.loaded[0] && need <= this.loaded[1]) return;
    const to = Math.max(need, this.ws) + 12 * 3600000;
    this.all = await api.get(`/api/guide?from=${Math.min(from, this.ws)}&to=${to}`);
    this.loaded = [Math.min(from, this.ws), to];
    this.applyList();
  },

  async render(root) {
    if (this.ws < align(Date.now())) this.ws = align(Date.now());
    if (this.t < this.ws) this.t = this.ws;
    await this.load();
    this.inBar = false;
    root.innerHTML = `
      <div class="infopane"><div class="info" id="ginfo"></div><div class="preview" id="gprev"></div></div>
      <div class="g-bar" id="gbar"></div>
      <div class="guide">
        <div class="g-head"><div class="g-day" id="gday"></div><div class="g-times" id="gtimes"></div></div>
        <div class="g-body" id="gbody"></div>
      </div>`;
    const body = $('#gbody', root);
    const rowPx = parseFloat(getComputedStyle(document.documentElement).fontSize) * 4.4 + 2;
    this.visible = Math.max(3, Math.floor(body.clientHeight / rowPx));
    body.onwheel = (e) => {
      e.preventDefault();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.shift((e.deltaX || e.deltaY) > 0 ? SLOT : -SLOT);
      else this.moveRow(e.deltaY > 0 ? 3 : -3);
    };
    this.paintBar();
    this.paint();
    if (Player.mode === 'pip') Player.placePip();
  },

  focused() {
    const r = this.rows[this.row];
    if (!r) return null;
    return r.programs.find((p) => p.start <= this.t && this.t < p.end) || r.programs.find((p) => p.end > this.ws) || r.programs[0];
  },

  paint() {
    const body = $('#gbody');
    if (!body) return;
    const now = Date.now();
    $('#gday').textContent = fmt.day(this.ws);
    $('#gtimes').innerHTML = [0, 1, 2].map((i) => `<span style="left:${(i * 100) / 3}%">${fmt.time(this.ws + i * SLOT)}</span>`).join('') +
      (now >= this.ws && now < this.ws + SPAN ? `<div class="g-now" style="left:${((now - this.ws) / SPAN) * 100}%"></div>` : '');
    if (!this.rows.length && this.filter) {
      body.innerHTML = `<div class="g-empty">No channels${this.list ? ` in <b>${esc(this.list.name)}</b>` : ''} are in <b>${esc(this.filterLabel)}</b>. Pick another category on the bar above, or clear it.</div>`;
      this.paintInfo(null, null);
      return;
    }
    if (!this.rows.length && this.list) {
      body.innerHTML = `<div class="g-empty">No channels in <b>${esc(this.list.name)}</b> yet. Choose <b>All channels</b> on the bar above, then on each channel you want, ${window.GTV_SERVER ? 'hold OK' : 'press M'} and add it.</div>`;
      this.paintInfo(null, null);
      return;
    }
    if (!this.rows.length) {
      body.innerHTML = `<div class="g-empty">No channels yet. Go to <b>Settings &gt; Antenna &amp; Providers</b> to add your tuner or IPTV provider.</div>`;
      this.paintInfo(null, null);
      return;
    }
    this.row = Math.max(0, Math.min(this.rows.length - 1, this.row));
    if (this.row < this.top) this.top = this.row;
    if (this.row >= this.top + this.visible) this.top = this.row - this.visible + 1;
    const fp = this.focused();
    const we = this.ws + SPAN;
    body.innerHTML = this.rows.slice(this.top, this.top + this.visible).map((r, i) => {
      const ri = this.top + i;
      const progs = r.programs.filter((p) => p.end > this.ws && p.start < we).map((p) => {
        const s = Math.max(p.start, this.ws), e = Math.min(p.end, we);
        const cls = ['g-p', p.filler ? 'filler' : '', ri === this.row && p === fp ? 'focus' : ''].join(' ');
        const icon = timerIcon(p);
        return `<div class="${cls}" data-r="${ri}" data-s="${p.start}" style="left:${((s - this.ws) / SPAN) * 100}%;width:${((e - s) / SPAN) * 100}%">
          <div class="t">${p.start < this.ws ? '‹ ' : ''}${icon}${esc(p.title)}${p.end > we ? ' ›' : ''}</div>
          ${p.subtitle ? `<div class="s">${esc(p.subtitle)}</div>` : ''}</div>`;
      }).join('');
      return `<div class="g-row ${ri === this.row ? 'sel' : ''}">
        <div class="g-ch" data-ch="${esc(r.id)}"><span class="num">${esc(r.number)}</span>${r.logo ? `<img src="${esc(r.logo)}" alt="" referrerpolicy="no-referrer">` : ''}<span class="nm">${r.favorite || this.inAnyList(r.id) ? '<span class="fav">★</span> ' : ''}${esc(r.name)}</span></div>
        <div class="g-progs">${progs}</div></div>`;
    }).join('');
    $$('.g-p', body).forEach((el) => {
      el.onclick = () => {
        const r = +el.dataset.r, s = +el.dataset.s;
        const already = r === this.row && this.focused() && this.focused().start === s;
        this.select(el);
        if (already || el.classList.contains('filler')) this.open(); // no listing to look at: one click tunes in
      };
      el.ondblclick = () => this.open();
    });
    $$('.g-ch', body).forEach((el) => { el.onclick = () => Player.play('live', el.dataset.ch); });
    this.paintInfo(this.rows[this.row], fp);
  },

  paintInfo(row, p) {
    const info = $('#ginfo'), prev = $('#gprev');
    if (!info) return;
    if (!row || !p) { info.innerHTML = ''; prev.innerHTML = ''; return; }
    const now = Date.now();
    const airing = p.start <= now && now < p.end;
    const st = p.timerStatus;
    const timerTag = p.timer ? `<span class="tag ${st === 'conflict' ? '' : 'rec'}">${st === 'recording' ? '● RECORDING' : st === 'conflict' ? '⚠ TUNER CONFLICT' : st === 'skipped' ? 'SKIPPED' : p.timer === 'series' ? '●● SERIES TIMER' : '● TIMER SET'}</span>` : '';
    info.innerHTML = `
      <div class="title">${esc(p.title)}</div>
      ${p.filler ? (p.subtitle ? `<div class="sub">${esc(p.subtitle)}</div>` : '') : `<div class="sub">${esc([fmt.se(p), p.subtitle].filter(Boolean).join('  ·  '))}</div>`}
      <div class="meta"><span><b>${esc(row.number)}</b> ${esc(row.name)}</span>${p.filler ? '' : `<span>${fmt.day(p.start)} ${fmt.range(p.start, p.end)}</span><span>${fmt.dur(p.end - p.start)}</span>`}
        ${p.isNew ? '<span class="tag new">NEW</span>' : ''}${p.rating ? `<span class="tag">${esc(p.rating)}</span>` : ''}${(p.categories || []).slice(0, 2).map((c) => `<span class="tag">${esc(c)}</span>`).join('')}${timerTag}</div>
      ${airing && !p.filler ? `<div class="progress"><i style="width:${((now - p.start) / (p.end - p.start)) * 100}%"></i></div>` : ''}
      <div class="desc">${esc(p.desc || '')}</div>`;
    if (Player.mode !== 'pip') {
      prev.innerHTML = `<div><div class="big">${esc(row.number)}</div><div>${esc(row.name)}</div><div style="margin-top:.6rem;font-size:.9rem">${airing ? 'Press OK or click here to watch' : `Starts ${fmt.when(p.start)}`}</div></div>`;
      prev.style.cursor = airing ? 'pointer' : '';
      prev.onclick = airing ? () => Player.play('live', row.id) : null;
    }
  },

  moveRow(d) { this.row = Math.max(0, Math.min(this.rows.length - 1, this.row + d)); this.paint(); },

  async shift(d) {
    const min = align(Date.now());
    const next = Math.max(min, this.ws + d);
    if (next === this.ws) return;
    this.ws = next;
    this.t = Math.min(Math.max(this.t, this.ws), this.ws + SPAN - 1);
    await this.load();
    this.paint();
  },

  async left() {
    const p = this.focused();
    if (!p) return;
    if (p.start > this.ws) {
      const r = this.rows[this.row];
      const prev = [...r.programs].reverse().find((x) => x.start < p.start);
      this.t = Math.max(prev ? prev.start : this.ws, this.ws);
      this.paint();
    } else {
      await this.shift(-SLOT);
    }
  },

  async right() {
    const p = this.focused();
    if (!p) return;
    const r = this.rows[this.row];
    const next = r.programs.find((x) => x.start >= p.end);
    if (!next) { await this.shift(SLOT); return; }
    this.t = next.start;
    if (next.start >= this.ws + SPAN) { this.ws = align(next.start); await this.load(); }
    this.paint();
  },

  open() {
    const r = this.rows[this.row], p = this.focused();
    if (r && p && p.filler) { Player.play('live', r.id); return; } // no listing (e.g. free channels): OK just tunes in
    if (r && p) App.programDialog(r, p).then(() => this.refresh());
  },

  async refresh() {
    if (App.view !== this) return;
    await this.load(true);
    if (this.listId && !this.list) this.setList(null); // deleted on another screen
    $('#crumb').textContent = this.title; // a list may have been renamed
    this.paintBar();
    this.paint();
  },

  // Hold OK (TV), M or a long press: this show and channel, favorites lists, filters.
  menu() {
    const lists = App.state.favLists || [], r = this.rows[this.row], p = this.focused(), cur = this.list, now = Date.now();
    const items = [];
    const after = async () => { await App.loadAll(); this.setList(this.listId, r && r.id); };
    if (r) items.push({ label: `▶ Watch ${r.number} ${r.name}`, run: () => Player.play('live', r.id), cls: 'primary' });
    items.push({ label: '🔢 Go to a channel number...', run: () => this.pad() });
    if (r) items.push(...App.recordItems(r, p).map((c) => ({ ...c, run: () => Promise.resolve(c.run()).then(() => this.refresh()) })));
    if (r) items.push(...App.channelFavItems(r, after));
    const ch = r && App.state.channels.find((c) => c.id === r.id);
    if (ch) items.push({ label: `🔢 Give ${r.name} a different number...`, run: async () => { if (await SettingsView.numberDialog(ch)) await after(); } });
    for (const l of lists) if (!cur || l.id !== cur.id) items.push({ label: `▦ Show ${l.name} (${l.channelIds.length})`, run: () => this.setList(l.id) });
    if (cur) items.push({ label: '▦ Show all channels', run: () => this.setList(null) });
    items.push({ label: this.filter ? `▦ Categories: ${this.filterLabel}...` : '▦ Categories (Sports, News, Movies...)', run: () => this.categoryPicker() });
    if (this.filter) items.push({ label: '✕ Show every category', run: () => this.setFilter(null) });
    if (this.ws > align(now)) items.push({ label: '⏱ Back to now', run: () => { this.ws = align(now); this.t = now; this.paint(); } });
    items.push({
      label: '＋ New favorites list...',
      run: async () => {
        const name = await Modal.prompt('New favorites list', "Name (for example, Gary's Favorites)", '', 'Create');
        if (!name) return;
        const l = await api.post('/api/favlists', { name });
        if (r) await api.post(`/api/favlists/${l.id}/toggle`, { channelId: r.id, on: true });
        toast(r ? `Made ${l.name} with ${r.name} in it. Add more the same way.` : `Made ${l.name}.`, 5000);
        await after();
      },
    });
    if (cur) {
      items.push({
        label: `✎ Rename ${cur.name}...`,
        run: async () => {
          const name = await Modal.prompt(`Rename ${cur.name}`, 'New name', cur.name);
          if (name) { await api.put(`/api/favlists/${cur.id}`, { name }); await after(); }
        },
      });
      items.push({
        label: `✕ Delete ${cur.name}`, cls: 'danger',
        run: async () => {
          if (!await Modal.confirm(`Delete ${cur.name}?`, 'The channels stay in the guide; only this list goes.', 'Delete list')) return;
          await api.del(`/api/favlists/${cur.id}`);
          this.listId = null;
          await after();
        },
      });
    }
    return { title: this.title, body: r ? `<div class="s">${esc(r.number)} ${esc(r.name)}${p && !p.filler ? ` · ${esc(p.title)}` : ''}</div>` : '', items };
  },

  // The on-screen number pad: jump the guide to a channel (it's added to the view if a list or
  // filter was hiding it).
  async pad(first) {
    const c = await App.channelPad(first);
    if (!c) return;
    if (!this.rows.some((r) => r.id === c.id)) { this.filter = null; try { localStorage.removeItem('gtv.filter'); } catch (_) { /* private mode */ } this.setList(null, c.id); }
    this.inBar = false;
    Nav.focus(null);
    this.row = this.rows.findIndex((r) => r.id === c.id);
    this.top = this.row;
    this.paint();
  },

  // Hold ←: back to the first channel, now.
  toTop() {
    this.inBar = false;
    Nav.focus(null);
    this.row = 0; this.top = 0;
    this.ws = align(Date.now()); this.t = Date.now();
    this.load().then(() => this.paint());
    return true;
  },

  // Synchronous so the key handler knows right away whether the key was used.
  onKey(e) {
    const k = e.key;
    if (this.inBar && Nav.current && Nav.current.closest('#topnav')) { // the buttons along the top
      if (k === 'ArrowDown') { this.refocusBar(); return true; }
      return ['ArrowLeft', 'ArrowRight', 'Enter'].includes(k) && Nav.handle(e);
    }
    if (this.inBar) { // on the bar above the guide: ←→ along it, OK picks, ↓ back to the shows
      if (k === 'ArrowDown') { this.inBar = false; Nav.focus(null); this.paint(); return true; }
      if (k === 'ArrowUp') { Nav.focus($('#topnav .nav')); return true; }
      if (k === 'ArrowLeft' || k === 'ArrowRight') { // in order, even when a narrow screen wraps the bar
        const chips = $$('#gbar .chip'), i = chips.indexOf(Nav.current);
        Nav.focus(chips[Math.max(0, Math.min(chips.length - 1, i + (k === 'ArrowRight' ? 1 : -1)))]);
        return true;
      }
      return k === 'Enter' && Nav.handle(e);
    }
    if (k === 'ArrowUp' && this.row === 0) { // ↑ from the top channel: the bar
      this.inBar = true;
      $$('.g-p.focus').forEach((el) => el.classList.remove('focus'));
      Nav.focus($('#gbar .chip.on') || $('#gbar .chip'));
    } else if (k === 'ArrowUp') this.moveRow(-1);
    else if (k === 'ArrowDown') this.moveRow(1);
    else if (k === 'PageUp') this.moveRow(-this.visible);
    else if (k === 'PageDown') this.moveRow(this.visible);
    else if (k === 'ArrowLeft') this.left();
    else if (k === 'ArrowRight') this.right();
    else if (k === ']') this.shift(24 * 3600000);
    else if (k === '[') this.shift(-24 * 3600000);
    else if (k === 'Enter') this.open();
    else if (k === 'r' || k === 'R') App.quickRecord(this.rows[this.row], this.focused()).then(() => this.refresh());
    else if (/^[0-9.]$/.test(k) || k === '#') this.pad(k === '#' ? '' : k);
    else return false;
    return true;
  },

  tick() {
    if (this.ws < align(Date.now())) { this.ws = align(Date.now()); this.load(true).then(() => this.paint()); } else this.paint();
  },
};

// A channel's broad category, from the provider's group ("US| ESPN PLUS" -> Sports), or for a
// channel without one, from what most of its listings are. The first rule that matches wins,
// so "SPORTS NETWORK" is Sports and "NBC NETWORK" is Local & networks.
const CATEGORY_RULES = [
  ['Sports', /sport|espn|\bnfl|\bnba|wnba|\bnhl|\bmlb|milb|\bmls\b|ncaa|soccer|fifa|tennis|dazn|golf|racing|\bf1\b|\bb1g|\bbtn|fite|\bflo\b|nfhs|victory\+|\bwwe|\bufc|boxing|deportes|outdoor|ppv|\bstan\b/i],
  ['News', /news|weather/i],
  ['Kids', /\bkid|famil|cartoon|junior|children/i],
  ['Entertainment', /tv shows|series|entertain/i],
  ['Movies', /movie|cinema|hollywood|\bfilm/i],
  ['Faith', /biblic|relig|faith|gospel/i],
  ['Music', /music/i],
  ['Documentaries', /\bpbs\b|documentar|history|science|nature/i],
  ['Local & networks', /\b(abc|nbc|cbs|fox|cw|my network|telemundo|spectrum|locals?)\b/i],
];
function categoryOf(r) {
  if (r._cat) return r._cat;
  const match = (t) => (CATEGORY_RULES.find(([, re]) => re.test(t)) || [])[0];
  let cat = r.group ? match(r.group) || 'Entertainment' : null;
  if (!cat) {
    const progs = (r.programs || []).filter((p) => !p.filler);
    const seen = new Map();
    for (const p of progs) for (const c of new Set((p.categories || []).map(match).filter(Boolean))) seen.set(c, (seen.get(c) || 0) + 1);
    const [best] = [...seen].sort((a, b) => b[1] - a[1]);
    cat = best && best[1] >= progs.length / 2 ? best[0] : 'Other';
  }
  if (r.programs) r._cat = cat;
  return cat;
}
function inFilter(r, f) { return f.startsWith('group:') ? r.group === f.slice(6) : categoryOf(r) === f; }

// "US| CINEMANIA TV SHOWS" -> "Cinemania TV Shows"; "TV ᴿᴬᵂ ⁶⁰ᶠᵖˢ" -> "TV RAW 60fps".
function groupLabel(raw) {
  return String(raw).normalize('NFKC').replace(/^\s*(US|USA|UK|CA|EN)\s*[|:-]\s*/i, '').replace(/\s+/g, ' ').trim()
    .split(' ').map((w) => (/^[A-Z]{5,}$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(' ') || raw;
}

function timerIcon(p) {
  if (!p.timer) return '';
  const st = p.timerStatus;
  const cls = st === 'recording' ? 'dot pulse' : st === 'conflict' ? 'dot conflict' : st === 'skipped' ? 'dot skip' : 'dot';
  return `<span class="${cls}${p.timer === 'series' ? ' series' : ''}"></span>`;
}
