// Multiview: up to 4 live channels on screen at once, in a grid. The highlighted one has the
// sound; OK on it brings up its choices (full screen, change channel, add, remove).
// Each tile is its own live buffer stream on the engine (its own viewer id), so it uses a plan
// like watching one channel does. Free TV never runs out; a paid IPTV plan or antenna box only
// has so many streams, and the channel picker offers a paid channel only while one is free
// (GET /api/multiview/room), so the grid never asks for more streams than the plans allow.
/* global Hls */
const Multiview = {
  MAX: 4,
  tiles: [], // { channelId, viewer, hls, el }
  focus: 0,
  active: false,
  labelTimer: null,

  channel(id) { return (App.state.channels || []).find((c) => c.id === id); },
  program(id) {
    const row = (App.guideRows || []).find((r) => r.id === id);
    const now = Date.now();
    return row && row.programs.find((p) => p.start <= now && now < p.end && !p.filler);
  },

  // From full screen live TV: the channel playing becomes the first tile, then pick a second.
  async start(firstId) {
    if (this.active) return;
    this.active = true;
    this.focus = 0;
    let root = $('#multiview');
    if (!root) {
      root = document.createElement('div');
      root.id = 'multiview';
      document.body.appendChild(root);
    }
    root.className = 'mv';
    this.addTile(firstId);
    Player.stop(); // after the tile has joined the channel's buffer, so the stream carries on
    this.layout();
    clearInterval(this.labelTimer);
    this.labelTimer = setInterval(() => this.paint(), 30000);
    await this.pickAndAdd();
  },

  // Leave multiview. keepId: that channel goes on full screen.
  stop(keepId = null) {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.labelTimer);
    for (const t of this.tiles) this.endTile(t, t.channelId === keepId);
    this.tiles = [];
    const root = $('#multiview');
    if (root) { root.className = ''; root.innerHTML = ''; }
    if (keepId) Player.play('live', keepId, { here: true });
    else App.render();
  },

  addTile(channelId) {
    const t = { channelId, viewer: `${VIEWER}.mv${Math.random().toString(36).slice(2, 7)}`, hls: null, el: null };
    this.tiles.push(t);
    this.load(t);
    return t;
  },

  load(t) {
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    const el = document.createElement('div');
    el.className = 'mv-tile';
    el.innerHTML = '<div class="mv-label"></div><div class="mv-msg"></div>';
    el.prepend(video);
    t.el = el;
    $('#multiview').appendChild(el);
    const url = `${serverBase()}/timeshift/${encodeURIComponent(t.channelId)}/live.m3u8?v=${t.viewer}`;
    if (!window.Hls || !Hls.isSupported()) { video.src = url; video.play().catch(() => {}); return; }
    // Small buffers: four of these at once on a Fire TV is a lot.
    const hls = t.hls = new Hls({ liveSyncDurationCount: 3, liveDurationInfinity: true, maxBufferLength: 10, backBufferLength: 10,
      manifestLoadingTimeOut: 25000, manifestLoadingMaxRetry: 3, levelLoadingMaxRetry: 8, fragLoadingMaxRetry: 8, capLevelToPlayerSize: true });
    hls.on(Hls.Events.ERROR, (ev, d) => {
      if (d.response && d.response.code === 409) {
        hls.stopLoad();
        fetch(url).then((r) => r.json()).then((j) => this.message(t, j.error || 'No stream free for this channel')).catch(() => this.message(t, 'No stream free for this channel'));
        return;
      }
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else this.message(t, 'This channel stopped. OK > Change channel to try again.');
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    video.play().catch(() => {});
  },

  message(t, msg) { const m = t.el && $('.mv-msg', t.el); if (m) m.textContent = msg || ''; },

  // keep: the channel is going on full screen, so its buffer keeps going (the full-screen player
  // joins it); the others let go of their stream straight away.
  endTile(t, keep = false) {
    if (t.hls) { try { t.hls.destroy(); } catch (_) {} t.hls = null; }
    const v = t.el && $('video', t.el);
    if (v) { v.removeAttribute('src'); v.load(); }
    if (t.el) t.el.remove();
    if (keep) api.post('/api/timeshift/release', { channelId: t.channelId, viewer: t.viewer }).catch(() => {});
    else api.post('/api/timeshift/leave', { viewer: t.viewer }).catch(() => {});
  },

  layout() {
    const root = $('#multiview');
    root.dataset.n = String(this.tiles.length);
    this.focus = Math.min(this.focus, this.tiles.length - 1);
    this.paint();
  },

  paint() {
    this.tiles.forEach((t, i) => {
      const ch = this.channel(t.channelId), p = this.program(t.channelId);
      $('.mv-label', t.el).innerHTML = `<b>${esc(ch ? `${ch.number} ${ch.name}` : t.channelId)}</b>${p ? ` · ${esc(p.title)}` : ''}`;
      t.el.classList.toggle('on', i === this.focus);
      const v = $('video', t.el);
      v.muted = i !== this.focus; // sound from the highlighted one only
      if (i === this.focus) v.play().catch(() => {});
    });
  },

  // Which of these channels could be added now. -> Map id -> { ok, paid }
  async room(ids) {
    try { return new Map(Object.entries(await api.get(`/api/multiview/room?ids=${ids.map(encodeURIComponent).join(',')}`))); } catch (_) { return new Map(); }
  },

  // Recent channels, then favorites, then the rest of the guide (as many as fit on a menu),
  // minus those on screen already. Paid channels with no stream free are left out.
  async pick(title) {
    const on = new Set(this.tiles.map((t) => t.channelId));
    const visible = new Map(((App.state.channels) || []).filter((c) => !c.hidden).map((c) => [c.id, c]));
    const favIds = (App.state.favLists || []).flatMap((l) => l.channelIds);
    const rows = (App.guideRows || []).map((r) => r.id);
    const ids = [...new Set([...App.recentIds(), ...favIds, ...rows])].filter((id) => visible.has(id) && !on.has(id)).slice(0, 60);
    const room = await this.room(ids);
    const ok = ids.filter((id) => (room.get(id) || {}).ok);
    const hidden = ids.length - ok.length;
    const choices = ok.map((id) => {
      const c = visible.get(id), p = this.program(id);
      return { label: `${c.number} ${c.name}${p ? `  ·  ${p.title}` : ''}`, value: id };
    });
    choices.unshift({ label: '🔢 Type a channel number...', value: '#pad' });
    choices.push({ label: 'Cancel', value: null });
    const note = hidden ? `<div class="s">${hidden} paid channel${hidden === 1 ? '' : 's'} not shown: every stream your plans allow is in use (by these tiles, recordings or another TV). Free TV and antenna channels can still be added.</div>` : '';
    let v = await Modal.menu(title, note, choices);
    if (v === '#pad') {
      const c = await App.channelPad('', title);
      if (!c) return null;
      if (on.has(c.id)) { toast(`${c.name} is already on screen`); return null; }
      const r = (await this.room([c.id])).get(c.id);
      if (!r || !r.ok) { toast(`No stream free for ${c.name}: every stream your plans allow is in use.`, 6000); return null; }
      v = c.id;
    }
    return v;
  },

  async pickAndAdd() {
    if (this.tiles.length >= this.MAX) return toast(`Multiview shows up to ${this.MAX} channels`);
    const id = await this.pick(`Add a channel (${this.tiles.length + 1} of up to ${this.MAX})`);
    if (!this.active) return;
    if (!id) { if (this.tiles.length === 1) this.stop(this.tiles[0].channelId); return; } // nothing added: back to full screen
    this.addTile(id);
    this.focus = this.tiles.length - 1;
    App.noteRecent(id);
    this.layout();
  },

  async change(i) {
    const t = this.tiles[i];
    // Let go of this tile's stream first, so its plan counts as free for the new channel.
    this.endTile(t);
    await new Promise((r) => setTimeout(r, 300));
    const id = await this.pick('Change this channel');
    if (!this.active) return;
    t.channelId = id || t.channelId;
    t.viewer = `${VIEWER}.mv${Math.random().toString(36).slice(2, 7)}`;
    const next = this.tiles[i + 1];
    this.load(t);
    if (next && next.el) $('#multiview').insertBefore(t.el, next.el); // keep its place in the grid
    if (id) App.noteRecent(id);
    this.layout();
  },

  remove(i) {
    if (this.tiles.length <= 1) return this.stop(this.tiles[0].channelId);
    const [t] = this.tiles.splice(i, 1);
    this.endTile(t);
    this.layout();
  },

  async tileMenu() {
    const i = this.focus, t = this.tiles[i];
    if (!t) return;
    const ch = this.channel(t.channelId);
    const choices = [{ label: '⛶ Watch this one full screen', value: 'full', cls: 'primary' }, { label: '↔ Change channel...', value: 'change' }];
    if (this.tiles.length < this.MAX) choices.push({ label: '＋ Add a channel...', value: 'add' });
    if (this.tiles.length > 1) choices.push({ label: '✕ Take this one off', value: 'remove' });
    choices.push({ label: '■ Leave multiview', value: 'exit' }, { label: 'Cancel', value: null });
    const v = await Modal.menu(ch ? `${ch.number} ${ch.name}` : 'Multiview', '', choices);
    if (!this.active) return;
    if (v === 'full') this.stop(t.channelId);
    if (v === 'change') await this.change(i);
    if (v === 'add') await this.pickAndAdd();
    if (v === 'remove') this.remove(i);
    if (v === 'exit') this.stop();
  },

  move(dx, dy) {
    const n = this.tiles.length, cols = n <= 1 ? 1 : 2;
    let i = this.focus;
    if (dx) i = Math.floor(i / cols) * cols + ((i % cols) + dx + cols) % cols;
    if (dy) i = (i + dy * cols + Math.ceil(n / cols) * cols) % (Math.ceil(n / cols) * cols);
    if (i < n) { this.focus = i; this.paint(); }
  },

  // Keys while multiview is up. Returns true if handled.
  onKey(e) {
    if (!this.active || Modal.top()) return false;
    const k = e.key;
    if (k === 'ArrowLeft') this.move(-1, 0);
    else if (k === 'ArrowRight') this.move(1, 0);
    else if (k === 'ArrowUp') this.move(0, -1);
    else if (k === 'ArrowDown') this.move(0, 1);
    else if (k === 'Enter' || k === 'ContextMenu' || k === 'm' || k === 'M') this.tileMenu();
    else if (k === 'Escape' || k === 'Backspace') this.stop(this.tiles[this.focus] && this.tiles[this.focus].channelId);
    else if (k === ' ' || k === 'MediaPlayPause') { const v = $('video', this.tiles[this.focus].el); if (v.paused) v.play().catch(() => {}); else v.pause(); }
    return true; // nothing else reacts while it's up
  },
};
