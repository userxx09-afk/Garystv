// The program guide: channels down the side, 90 minutes across the top,
// a details panel with a picture-in-picture preview above (DISH-style).
/* global App, Player */
const SLOT = 30 * 60000;
const SPAN = 3 * SLOT;
const align = (t) => Math.floor(t / SLOT) * SLOT;

const GuideView = {
  ws: align(Date.now()), row: 0, top: 0, t: Date.now(), rows: [], loaded: [0, 0], visible: 7, digits: '', digitTimer: null,

  title: 'Guide',
  hints: [['↑↓←→', 'Move'], ['OK', 'Options'], ['R', 'Record', 'k-red'], ['PgUp/PgDn', 'Page'], ['[ ]', 'Day'], ['0-9', 'Channel'], ['Esc', 'Back']],

  async load(force) {
    const from = align(Date.now()) - SLOT;
    const need = this.ws + SPAN;
    if (!force && this.ws >= this.loaded[0] && need <= this.loaded[1]) return;
    const to = Math.max(need, this.ws) + 12 * 3600000;
    this.rows = await api.get(`/api/guide?from=${Math.min(from, this.ws)}&to=${to}`);
    this.loaded = [Math.min(from, this.ws), to];
    App.guideRows = this.rows;
  },

  async render(root) {
    if (this.ws < align(Date.now())) this.ws = align(Date.now());
    if (this.t < this.ws) this.t = this.ws;
    await this.load();
    root.innerHTML = `
      <div class="infopane"><div class="info" id="ginfo"></div><div class="preview" id="gprev"></div></div>
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
        <div class="g-ch" data-ch="${esc(r.id)}"><span class="num">${esc(r.number)}</span>${r.logo ? `<img src="${esc(r.logo)}" alt="" referrerpolicy="no-referrer">` : ''}<span class="nm">${r.favorite ? '<span class="fav">★</span> ' : ''}${esc(r.name)}</span></div>
        <div class="g-progs">${progs}</div></div>`;
    }).join('');
    $$('.g-p', body).forEach((el) => {
      el.onclick = () => {
        const r = +el.dataset.r, s = +el.dataset.s;
        const already = r === this.row && this.focused() && this.focused().start === s;
        this.row = r; this.t = Math.max(s, this.ws);
        this.paint();
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
    this.paint();
  },

  jumpToChannel(num) {
    const i = this.rows.findIndex((r) => r.number === num) >= 0 ? this.rows.findIndex((r) => r.number === num) : this.rows.findIndex((r) => String(r.number).startsWith(num));
    if (i >= 0) { this.row = i; this.top = i; this.paint(); } else toast(`No channel ${num}`);
  },

  // Synchronous so the key handler knows right away whether the key was used.
  onKey(e) {
    const k = e.key;
    if (k === 'ArrowUp') this.moveRow(-1);
    else if (k === 'ArrowDown') this.moveRow(1);
    else if (k === 'PageUp') this.moveRow(-this.visible);
    else if (k === 'PageDown') this.moveRow(this.visible);
    else if (k === 'ArrowLeft') this.left();
    else if (k === 'ArrowRight') this.right();
    else if (k === ']') this.shift(24 * 3600000);
    else if (k === '[') this.shift(-24 * 3600000);
    else if (k === 'Enter') this.open();
    else if (k === 'r' || k === 'R') App.quickRecord(this.rows[this.row], this.focused()).then(() => this.refresh());
    else if (/^[0-9.]$/.test(k)) {
      this.digits += k;
      toast(`Channel ${this.digits}`, 1200);
      clearTimeout(this.digitTimer);
      this.digitTimer = setTimeout(() => { this.jumpToChannel(this.digits); this.digits = ''; }, 1300);
    } else return false;
    return true;
  },

  tick() {
    if (this.ws < align(Date.now())) { this.ws = align(Date.now()); this.load(true).then(() => this.paint()); } else this.paint();
  },
};

function timerIcon(p) {
  if (!p.timer) return '';
  const st = p.timerStatus;
  const cls = st === 'recording' ? 'dot pulse' : st === 'conflict' ? 'dot conflict' : st === 'skipped' ? 'dot skip' : 'dot';
  return `<span class="${cls}${p.timer === 'series' ? ' series' : ''}"></span>`;
}
