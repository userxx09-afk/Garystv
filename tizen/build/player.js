// Built-in player for live TV and recordings. Without ffmpeg we hand off to VLC
// if it is installed.
//
// Live TV plays from the engine's live buffer (the last 30 minutes of the channel,
// see core/timeshift.js) with hls.js, so it can pause, rewind (←), fast-forward (→)
// and jump back to live (L, or fast-forward to the end). Recordings are transcoded
// by the engine and played with mpegts.js; commercial breaks the engine found are
// skipped (or offered to skip, see Settings).
/* global mpegts, Hls, App */
const MAX_RETRIES = 6;
const LIVE_S = 8; // this close to the live edge counts as live
const VIEWER = Math.random().toString(36).slice(2); // tells the engine which buffer viewers are still here
const serverBase = () => window.GTV_SERVER || location.origin;

const Player = {
  mode: 'off', // off | full | pip
  kind: null, id: null, offset: 0, duration: 0, rec: null, channel: null, mp: null, hls: null,
  osdTimer: null, tickTimer: null, saveTimer: null, session: 0, retries: 0, passed: new Set(), prompted: null,

  // kind: live | rec (a recording) | vod (a movie or episode from the IPTV provider; item = { title,
  // subtitle, duration, poster, showId } from the Movies / Shows screens)
  async play(kind, id, { offset = 0, item = null } = {}) {
    const st = App.state.status;
    if (!st.ffmpeg) {
      if (st.vlc && !window.GTV_SERVER) { // VLC opens on the PC, so not from the TV app
        try { await api.post('/api/external-play', { kind, id }); toast('Opening in VLC...'); } catch (e) { toast(e.message); }
        return;
      }
      Modal.menu('Video player needed', `<div class="s">To watch on this PC, install <b>ffmpeg</b> (for the built-in player) or <b>VLC</b>. Recording works without either.<br><br>See Settings &gt; Status for where GarysTV looks for them.</div>`, [{ label: 'OK', value: true }]);
      return;
    }
    if (kind === 'live' || id !== this.id) { this.passed = new Set(); this.prompted = null; } // a seek within the same recording keeps these
    this.stopStream();
    this.kind = kind; this.id = id; this.offset = offset; this.retries = 0;
    this.rec = kind === 'rec' ? App.recordings.find((r) => r.id === id) : kind === 'vod' ? { ...item, id } : null;
    this.channel = kind === 'live' ? App.state.channels.find((c) => c.id === id) : null;
    if (kind === 'rec' && this.rec) this.duration = ((this.rec.finishedAt || Date.now()) - this.rec.recordedAt) / 1000;
    if (kind === 'vod') this.duration = this.rec.duration || 0; // 0: the provider didn't say
    if (this.channel) App.lastChannel = id;
    if (kind === 'live') this.playLive(id);
    else this.playRec(kind, id, offset);
    this.setMode('full');
    this.showOsd();
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), 500);
    clearInterval(this.saveTimer);
    if (this.rec) this.saveTimer = setInterval(() => this.savePosition(), 10000);
  },

  playLive(id) {
    const video = $('#video'), session = this.session;
    const url = `${serverBase()}/timeshift/${encodeURIComponent(id)}/live.m3u8?v=${VIEWER}`;
    if (!window.Hls || !Hls.isSupported()) { video.src = url; video.play().catch(() => {}); return; } // TVs that play HLS themselves
    // Start 6s behind live: a cushion so hiccups upstream don't freeze the picture. No catching up afterwards.
    const hls = this.hls = new Hls({ liveSyncDurationCount: 3, liveDurationInfinity: true, maxBufferLength: 20, backBufferLength: 60,
      manifestLoadingTimeOut: 25000, manifestLoadingMaxRetry: 3, levelLoadingMaxRetry: 8, fragLoadingMaxRetry: 8 });
    hls.on(Hls.Events.ERROR, (ev, d) => {
      if (session !== this.session || !d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
      if (this.retries++ >= MAX_RETRIES) { this.showOsd('Could not play this channel. Check the tuner or stream, then try again.'); return; }
      this.showOsd('Signal lost. Reconnecting...');
      setTimeout(() => { if (session !== this.session) return; if (/^manifest/.test(d.details)) hls.loadSource(url); else hls.startLoad(); }, 2000);
    });
    hls.on(Hls.Events.FRAG_LOADED, () => { this.retries = 0; });
    hls.loadSource(url);
    hls.attachMedia(video);
    video.play().catch(() => {});
  },

  playRec(kind, id, offset) {
    const video = $('#video'), session = this.session;
    // Absolute URL: mpegts.js fetches from a worker, which can't resolve relative paths.
    this.mp = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: `${serverBase()}/stream/${kind}/${encodeURIComponent(id)}?t=${Math.floor(offset)}` },
      { enableWorker: true, liveBufferLatencyChasing: false, lazyLoad: false });
    this.mp.on(mpegts.Events.ERROR, () => { if (session === this.session) this.showOsd(kind === 'vod' ? 'Could not play this. The provider may be busy; try again in a moment.' : 'Could not play this recording.'); });
    this.mp.attachMediaElement(video);
    this.mp.load();
    video.play().catch(() => {});
  },

  stopStream() {
    this.session++; // anything still pending for the old stream (reconnects) is now ignored
    if (this.hls) { try { this.hls.destroy(); } catch (_) {} this.hls = null; }
    if (this.mp) {
      try { this.mp.pause(); this.mp.unload(); this.mp.detachMediaElement(); this.mp.destroy(); } catch (_) {}
      this.mp = null;
    }
    const video = $('#video');
    if (video.getAttribute('src')) { video.removeAttribute('src'); video.load(); }
    if (this.kind === 'live' && this.id) api.post('/api/timeshift/release', { channelId: this.id, viewer: VIEWER }).catch(() => {});
  },

  stop() {
    if (this.mode === 'off') return;
    if (this.rec) this.savePosition();
    clearInterval(this.saveTimer);
    clearInterval(this.tickTimer);
    this.stopStream();
    this.setMode('off');
    this.kind = this.id = this.rec = this.channel = null;
  },

  togglePause() {
    const v = $('#video');
    if (v.paused) v.play().catch(() => {}); else v.pause();
    this.showOsd(v.paused ? (this.channel ? 'Paused. The channel keeps recording in the background.' : 'Paused') : '');
  },

  // ---------- live buffer ----------
  // { start, edge } of what can be watched, in video time; edge is "live".
  liveRange() {
    const v = $('#video'), s = v.seekable;
    if (!s.length) return null;
    const edge = this.hls && this.hls.liveSyncPosition != null ? this.hls.liveSyncPosition : s.end(s.length - 1);
    return { start: s.start(0), edge: Math.max(edge, s.start(0)) };
  },
  behind() {
    const r = this.liveRange();
    return r ? Math.max(0, r.edge - $('#video').currentTime) : 0;
  },
  seekLive(delta) {
    const r = this.liveRange(), v = $('#video');
    if (!r) return;
    const to = Math.max(r.start + 1, Math.min(r.edge, v.currentTime + delta));
    if (delta > 0 && to >= r.edge - 1) { this.goLive(); return; }
    v.currentTime = to;
    this.showOsd(delta < 0 && to <= r.start + 1 ? 'This is as far back as the live buffer goes.' : '');
  },
  goLive() {
    const r = this.liveRange(), v = $('#video');
    if (!r) return;
    v.currentTime = r.edge;
    v.play().catch(() => {});
    this.showOsd('Live');
  },

  // ---------- recordings ----------
  position() { return this.offset + ($('#video').currentTime || 0); },

  savePosition() {
    if (!this.rec) return;
    const pos = this.position();
    if (this.kind === 'vod') {
      const r = this.rec;
      api.put(`/api/vod/progress/${encodeURIComponent(r.id)}`, { position: pos, duration: this.duration, title: r.title, subtitle: r.subtitle, poster: r.poster, showId: r.showId }).catch(() => {});
      return;
    }
    const watched = this.duration > 0 && pos / this.duration > 0.9;
    api.put(`/api/recordings/${this.rec.id}`, { position: pos, watched: watched || this.rec.watched }).catch(() => {});
  },

  seek(delta) { if (this.rec) this.seekTo(this.position() + delta); },
  seekTo(to) { this.play(this.kind, this.rec.id, { offset: Math.max(0, this.duration ? Math.min(this.duration - 5, to) : to), item: this.rec }); },

  // The commercial break playback is in, if any.
  breakNow() {
    const rec = this.rec && (App.recordings.find((r) => r.id === this.rec.id) || this.rec); // breaks may have been found since we started
    const pos = this.position();
    return ((rec && rec.commercials) || []).find((b) => pos >= b.start - 0.5 && pos < b.end - 1) || null;
  },
  skipBreak(b) {
    this.passed.add(b.start);
    this.seekTo(b.end);
    setTimeout(() => this.showOsd(`Skipped a ${fmt.clock(b.end - b.start)} commercial break. Press ← to go back.`), 300);
  },

  // Twice a second: keep the live picture inside the buffer; skip or offer to skip commercials.
  tick() {
    if (this.mode === 'off') return;
    const v = $('#video');
    if (this.kind === 'live') {
      const r = this.liveRange();
      if (r && v.currentTime < r.start + 0.5 && r.edge - r.start > 5) v.currentTime = r.start + 3; // paused so long the oldest part was dropped
      if (!$('#osd').classList.contains('hide')) this.paintBar();
      return;
    }
    const b = this.breakNow();
    const how = App.state.settings.commercialSkip || 'auto';
    if (!b || how === 'off' || v.paused) return;
    if (how === 'auto' && !this.passed.has(b.start)) this.skipBreak(b);
    else if (how === 'button' && this.prompted !== b.start) { this.prompted = b.start; this.showOsd(`Commercial break (${fmt.clock(b.end - b.start)}). Press OK to skip it.`); }
  },

  setMode(mode) {
    this.mode = mode;
    const scr = $('#screen');
    scr.className = mode === 'off' ? '' : mode;
    scr.style.cssText = '';
    if (mode === 'pip') this.placePip();
  },

  placePip() {
    const box = $('.preview');
    if (!box || this.mode !== 'pip') return;
    const r = box.getBoundingClientRect();
    Object.assign($('#screen').style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  },

  currentProgram(at = Date.now()) {
    if (!this.channel) return null;
    const row = (App.guideRows || []).find((r) => r.id === this.channel.id);
    return row && row.programs.find((p) => p.start <= at && at < p.end);
  },

  showOsd(msg) {
    const osd = $('#osd');
    let title = '', sub = '';
    if (this.rec) {
      title = this.rec.title;
      sub = [fmt.se(this.rec), this.rec.subtitle].filter(Boolean).join('  ·  ');
    } else if (this.channel) {
      const p = this.currentProgram(Date.now() - this.behind() * 1000); // what was on at the moment you're watching
      title = p ? p.title : this.channel.name;
      sub = `${this.channel.number} ${this.channel.name}${p && p.subtitle ? `  ·  ${p.subtitle}` : ''}`;
    }
    const keys = this.rec ? '← back 10s · → skip 30s · Space pause · Esc stop' : (window.GTV_SERVER ? '← back 10s · → ahead 30s · ↑↓ channel · hold OK for options · BACK stop' : '← back 10s · → ahead 30s · L live · ↑↓ channel · G guide · R record · Esc stop');
    const btns = this.rec
      ? [['back', '⏪ 10s'], ['pause', '⏯'], ['fwd', '30s ⏩'], ...(this.breakNow() ? [['skip', 'Skip commercial ⏭']] : [])]
      : [['back', '⏪ 10s'], ['pause', '⏯'], ['fwd', '30s ⏩'], ['live', 'Go Live ⏭']];
    const rec = this.recording() ? '<span class="rec-badge">● REC</span>' : '';
    osd.innerHTML = `<div class="t">${rec}<span id="osdTag"></span>${esc(title)}</div><div class="s">${esc(sub)}</div>
      <div class="bar" id="osdBar"></div><div class="row"><span id="osdL"></span><span>${keys}</span><span id="osdR"></span></div>
      <div class="osd-btns">${btns.map(([a, l]) => `<span class="osd-btn" data-a="${a}">${l}</span>`).join('')}</div>
      ${msg ? `<div class="msg">${esc(msg)}</div>` : ''}`;
    $$('.osd-btn', osd).forEach((b) => { b.onclick = (e) => { e.stopPropagation(); this.act(b.dataset.a); }; });
    this.paintBar();
    osd.classList.remove('hide');
    clearTimeout(this.osdTimer);
    const hide = () => { if ($('#video').paused) this.osdTimer = setTimeout(hide, 1000); else osd.classList.add('hide'); }; // stays up while paused
    this.osdTimer = setTimeout(hide, msg ? 8000 : 4000);
  },
  osdMessage(m) { this.showOsd(m); },

  // The progress bar: the recording (with its commercial breaks), or the live buffer up to "now".
  paintBar() {
    const bar = $('#osdBar'), L = $('#osdL'), R = $('#osdR'), tag = $('#osdTag');
    if (!bar) return;
    const v = $('#video');
    if (this.rec) {
      const pos = this.position(), d = this.duration || 1;
      const rec = App.recordings.find((r) => r.id === this.rec.id) || this.rec;
      const ads = (rec.commercials || []).map((b) => `<b class="ad" style="left:${(b.start / d) * 100}%;width:${((b.end - b.start) / d) * 100}%"></b>`).join('');
      bar.innerHTML = `<i style="width:${Math.min(100, (pos / d) * 100)}%"></i>${ads}`;
      L.textContent = fmt.clock(pos); R.textContent = this.duration ? fmt.clock(this.duration) : '';
      return;
    }
    const r = this.liveRange();
    if (!r) { bar.innerHTML = ''; L.textContent = R.textContent = ''; tag.innerHTML = ''; return; }
    const span = Math.max(1, r.edge - r.start), behind = this.behind(), live = behind < LIVE_S;
    bar.innerHTML = `<i style="width:${Math.min(100, ((v.currentTime - r.start) / span) * 100)}%"></i>`;
    L.textContent = `Buffer from ${fmt.time(Date.now() - span * 1000)}`;
    R.textContent = live ? 'LIVE' : `−${fmt.clock(behind)}`;
    tag.innerHTML = live ? '<span class="live-badge">LIVE</span>' : `<span class="behind-badge">⏪ ${fmt.clock(behind)} behind</span>`;
  },

  // On-screen buttons and keys share these.
  act(a) {
    if (a === 'pause') this.togglePause();
    else if (a === 'back') { if (this.rec) this.seek(-10); else this.seekLive(-10); }
    else if (a === 'fwd') { if (this.rec) this.seek(30); else this.seekLive(30); }
    else if (a === 'live') this.goLive();
    else if (a === 'skip') { const b = this.breakNow(); if (b) this.skipBreak(b); }
  },

  // This channel's recording in progress, if any.
  recording() {
    return this.channel && (App.recordings || []).find((r) => r.status === 'recording' && r.channelId === this.channel.id);
  },

  // R / red button while watching: record now, DISH-style.
  async recordMenu() {
    const ch = this.channel, p = this.currentProgram(), now = Date.now();
    const active = this.recording();
    const choices = [];
    if (active) choices.push({ label: `■ Stop recording "${active.title}"`, value: 'stop', cls: 'danger' });
    if (p && !p.filler && !(active && active.title === p.title)) choices.push({ label: `● This show: ${p.title} (until ${fmt.time(p.end)})`, value: 'show' });
    for (const [min, label] of [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [180, '3 hours']]) choices.push({ label: `● Record now for ${label}`, value: min });
    choices.push({ label: '● Record now until I stop it (up to 4 hours)', value: 240 });
    choices.push({ label: 'Cancel', value: null });
    const v = await Modal.menu(`Record ${ch.number} ${ch.name}`, active ? `<div class="s">Recording now: ${esc(active.title)}</div>` : '', choices);
    try {
      if (v === 'stop') await this.stopRecording(active);
      else if (v === 'show') {
        await App.recordOnce(ch, p);
        this.showOsd(`Recording ${p.title}`);
      } else if (typeof v === 'number') {
        // Starts now and ends exactly when chosen: no early/late padding.
        const title = p && !p.filler ? p.title : ch.name;
        await api.post('/api/rules', { type: 'once', channelId: ch.id, start: now, end: now + v * 60000, title, prePad: 0, postPad: 0, categories: [] });
        await App.loadAll();
        this.showOsd(v === 240 ? 'Recording until you stop it. Press R again to stop.' : `Recording for the next ${v < 60 ? `${v} minutes` : `${v / 60} hour${v > 60 ? 's' : ''}`}`);
      }
    } catch (e) { toast(e.message); }
  },

  async stopRecording(active) {
    const rule = App.state.rules.find((r) => r.id === active.ruleId);
    if (rule && rule.type === 'once') await api.del(`/api/rules/${rule.id}`);
    else await api.post('/api/jobs/skip', { id: active.jobId });
    await App.loadAll();
    this.showOsd('Recording stopped. It is saved in My Recordings.');
  },

  // Hold OK (TV remote) / menu key while watching live: what you can do from here. Record now is
  // first, so hold OK then OK starts recording straight away: the rest of this show when the guide
  // knows it, else until stopped.
  async optionsMenu() {
    const ch = this.channel, p = this.currentProgram(), active = this.recording();
    const choices = [];
    if (active) choices.push({ label: `■ Stop recording "${active.title}"`, value: 'stop', cls: 'danger' });
    else choices.push({ label: p && !p.filler ? `● Record now: ${p.title} (until ${fmt.time(p.end)})` : '● Record now (until I stop it)', value: 'record' });
    choices.push({ label: '● More ways to record...', value: 'recordMenu' });
    if (this.behind() >= LIVE_S) choices.push({ label: '⏩ Back to live', value: 'live' });
    choices.push({ label: $('#video').paused ? '▶ Play' : '❚❚ Pause', value: 'pause' });
    choices.push({ label: '▦ Guide', value: 'guide' });
    choices.push({ label: '■ Stop watching', value: 'stopWatching' });
    choices.push({ label: '⌂ Home', value: 'home' });
    choices.push({ label: 'Cancel', value: null });
    const v = await Modal.menu(`${ch.number} ${ch.name}`, p && !p.filler ? `<div class="s">${esc(p.title)} · until ${fmt.time(p.end)}</div>` : '', choices);
    try {
      if (v === 'record') {
        if (p && !p.filler) { await App.recordOnce(ch, p); this.showOsd(`Recording ${p.title}`); }
        else {
          const now = Date.now();
          await api.post('/api/rules', { type: 'once', channelId: ch.id, start: now, end: now + 240 * 60000, title: ch.name, prePad: 0, postPad: 0, categories: [] });
          await App.loadAll();
          this.showOsd('Recording until you stop it. Hold OK to stop.');
        }
      } else if (v === 'stop') await this.stopRecording(active);
      else if (v === 'recordMenu') this.recordMenu();
      else if (v === 'live') this.goLive();
      else if (v === 'pause') this.togglePause();
      else if (v === 'guide') { this.setMode('pip'); App.go('guide'); }
      else if (v === 'stopWatching') { this.stop(); App.render(); }
      else if (v === 'home') App.home();
    } catch (e) { toast(e.message); }
  },

  // Hold OK / menu key while watching a recording, movie or episode.
  async playbackMenu() {
    const r = this.rec || {};
    const choices = [{ label: $('#video').paused ? '▶ Play' : '❚❚ Pause', value: 'pause', cls: 'primary' }];
    if (this.position() > 30) choices.push({ label: '⟲ Start over', value: 'over' });
    choices.push({ label: '↺ Back 5 minutes', value: 'back5' }, { label: '■ Stop watching', value: 'stop' }, { label: '⌂ Home', value: 'home' }, { label: 'Cancel', value: null });
    const v = await Modal.menu(r.title || 'Playing', r.subtitle ? `<div class="s">${esc(r.subtitle)}</div>` : '', choices);
    if (v === 'pause') this.togglePause();
    if (v === 'over') this.seekTo(0);
    if (v === 'back5') this.seek(-300);
    if (v === 'stop') { this.stop(); App.render(); }
    if (v === 'home') App.home();
  },

  surf(delta) {
    const rows = App.guideRows || [];
    if (!rows.length || !this.channel) return;
    const i = rows.findIndex((r) => r.id === this.channel.id);
    const next = rows[(i + delta + rows.length) % rows.length];
    this.play('live', next.id);
  },

  // Keys while full screen. Returns true if handled.
  onKey(e) {
    if (this.mode !== 'full' || Modal.top()) return false; // a menu over the video gets the keys
    const k = e.key;
    if (k === 'Escape' || k === 'Backspace') { this.stop(); App.render(); return true; }
    if (k === ' ' || k === 'MediaPlayPause') { this.togglePause(); return true; }
    if (k === 'ArrowLeft') { this.act('back'); return true; }
    if (k === 'ArrowRight') { this.act('fwd'); return true; }
    if (this.channel && ['l', 'L', 'End'].includes(k)) { this.goLive(); return true; }
    if (this.rec && k === 'Enter' && this.breakNow()) { this.act('skip'); return true; }
    if (this.channel && k === 'ArrowUp') { this.surf(-1); return true; }
    if (this.channel && k === 'ArrowDown') { this.surf(1); return true; }
    if (this.channel && (k === 'g' || k === 'G')) { this.setMode('pip'); App.go('guide'); return true; }
    if (this.channel && (k === 'r' || k === 'R')) { this.recordMenu(); return true; }
    if (k === 'ContextMenu' || k === 'm' || k === 'M') { if (this.channel) this.optionsMenu(); else this.playbackMenu(); return true; }
    this.showOsd();
    return ['Enter', 'i', 'I'].includes(k);
  },
};

window.addEventListener('resize', () => Player.placePip());
// Moving the mouse over the picture brings up the controls.
document.addEventListener('DOMContentLoaded', () => $('#screen').addEventListener('mousemove', () => {
  if (Player.mode === 'full' && $('#osd').classList.contains('hide')) Player.showOsd();
}));
