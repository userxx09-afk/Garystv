// Alexa voice control (core/alexa.js): "Alexa, ask Tapper to play ESPN". While GarysTV is on
// screen, this screen keeps one request open to the engine, which passes it to the Tapper Alexa
// relay, and acts on what Alexa queued: play a channel by name or number, next and previous
// channel, pause, resume, stop, open the guide or My Recordings, go home, go back. Each screen links to Alexa on its own (Settings > Alexa); the
// last one linked is the one Alexa controls.
/* global App, Player, Health, Multiview, MANAGING, Modal, atStart */
const AlexaVoice = {
  overview: null, running: false, wake: null, checked: 0,

  // This screen's id at the relay, kept here (it's this screen's, not the engine's).
  creds() {
    try {
      const c = JSON.parse(localStorage.getItem('gtv.alexa') || 'null');
      return c && c.tvId && c.token && this.overview && c.url === this.overview.url ? { tvId: c.tvId, token: c.token } : null;
    } catch (_) { return null; }
  },
  keep(tv) { try { localStorage.setItem('gtv.alexa', JSON.stringify({ url: this.overview && this.overview.url, ...tv })); } catch (_) { /* private mode */ } },
  forget() { try { localStorage.removeItem('gtv.alexa'); } catch (_) { /* private mode */ } },
  name() { const d = Health.device(); return d === 'This PC' || d === 'Browser' ? `GarysTV (${d})` : `GarysTV ${d}`; },

  // Settings changed: look again now instead of at the next minute.
  refresh() { this.overview = null; this.checked = 0; if (this.wake) this.wake(); },
  sleep(ms) { return new Promise((r) => { const t = setTimeout(() => { this.wake = null; r(); }, ms); this.wake = () => { clearTimeout(t); this.wake = null; r(); }; }); },

  async start() {
    if (this.running || MANAGING) return; // managing another location: its screens have their own
    this.running = true;
    let backoff = 2000;
    for (;;) {
      if (document.hidden) { await this.sleep(5000); continue; } // the TV app is in the background
      if (!this.overview || Date.now() - this.checked > 10 * 60000) {
        try { this.overview = await api.get('/api/alexa'); this.checked = Date.now(); } catch (_) { this.overview = null; await this.sleep(60000); continue; }
      }
      const tv = this.creds();
      if (!this.overview.configured || !tv) { await this.sleep(60000); this.checked = 0; continue; }
      try {
        const r = await api.post('/api/alexa/next', { tv });
        backoff = 2000;
        if (r.unknown) { this.forget(); continue; }
        for (const c of r.commands || []) this.run(c);
      } catch (_) {
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  },

  playing() { return Player.mode !== 'off'; },
  video() { return document.getElementById('video'); },

  run(c) {
    try {
      if (c.type === 'linked') { toast('Alexa is linked to this TV', 5000); if (App.view && App.viewName === 'settings') App.render(); return; }
      if (c.type === 'tune' || c.type === 'number') {
        if (!c.channelId) { toast(`Alexa: no channel matches "${c.query != null ? c.query : c.number}"`, 6000); return; }
        this.leaveOverlays();
        Player.play('live', c.channelId);
        return;
      }
      if (c.type === 'channelUp' || c.type === 'channelDown') {
        if (Player.channel) Player.surf(c.type === 'channelUp' ? 1 : -1);
        else if (App.lastChannel) { this.leaveOverlays(); Player.play('live', App.lastChannel); }
        return;
      }
      const v = this.video();
      if (c.type === 'pause') { if (this.playing() && v && !v.paused) Player.togglePause(); return; }
      if (c.type === 'resume') {
        if (this.playing() && v && v.paused) Player.togglePause();
        else if (!this.playing() && App.lastChannel) { this.leaveOverlays(); Player.play('live', App.lastChannel); }
        return;
      }
      if (c.type === 'guide') { this.leaveOverlays(); App.go('guide'); return; }
      if (c.type === 'recordings') { this.leaveOverlays(); App.go('dvr'); return; }
      if (c.type === 'home') { this.leaveOverlays(); App.home(); return; }
      if (c.type === 'back') { if (!atStart()) App.back(); return; } // never leaves the app
      if (c.type === 'stop') {
        if (typeof Multiview !== 'undefined' && Multiview.active) { Multiview.stop(); return; }
        if (this.playing()) { Player.stop(); App.render(); }
      }
    } catch (e) { toast(`Alexa: ${e.message}`); }
  },

  // A menu or multiview in the way of a channel Alexa was asked to put on.
  leaveOverlays() {
    for (let i = 0; i < 10 && Modal.closeTop(); i++) { /* close menus, top first */ }
    if (typeof Multiview !== 'undefined' && Multiview.active) Multiview.stop();
  },
};
