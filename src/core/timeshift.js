// Live TV pause & rewind. While you watch a channel, the engine keeps the last
// 30 minutes (Settings) of it on disk as an HLS playlist of 2-second pieces. The
// player plays from that, so it can pause, rewind, fast-forward and jump to live.
// If the stream drops, ffmpeg is restarted and the buffer carries on.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SEG_S = 2;
const MB_PER_MIN = 45; // about 6 Mbit/s: converted video is capped there, internet channels are usually under it
const SPARE_MB = 1500; // never fill the disk: leave this much free
const GRACE_MS = 5000; // after the last viewer leaves (channel change, stop)
const STALE_MS = 60000; // a viewer that stopped asking for the playlist is gone (closed app, TV off)

class Timeshift {
  // ffmpeg(): path to ffmpeg; input(channelId, session): Promise<ffmpeg input + video options>; dir(): buffer folder; minutes(): wanted length
  // claim(channelId, onBump): a plan for the stream (tuners.js; throws when none is free); unclaim(lease)
  // health: playback health (diagnostics.js), told how well each channel's stream keeps up
  constructor({ ffmpeg, input, dir, minutes, note = () => {}, claim = () => null, unclaim = () => {}, health = null }) {
    Object.assign(this, { ffmpeg, input, dir, minutes, note, claim, unclaim, health });
    this.sessions = new Map();
    this.timer = setInterval(() => this.reap(), GRACE_MS);
    try { fs.rmSync(this.dir(), { recursive: true, force: true }); } catch (_) { /* leftovers from a crash */ }
  }

  // Starts (or joins) the buffer for a channel; resolves once the first piece of video exists.
  async open(channelId, viewer) {
    // This viewer was on another channel: they changed channel. Let go of the old one now rather
    // than after the grace period, so a plan that allows one stream at a time is free for this one.
    // (The player's own "release" can arrive after this request, so it can't be relied on.)
    if (viewer) {
      for (const [id, o] of [...this.sessions]) {
        if (id === channelId || !o.viewers.delete(viewer)) continue;
        if (!o.viewers.size) this.stop(id);
      }
    }
    let s = this.sessions.get(channelId);
    if (!s) {
      let lease;
      try {
        lease = this.claim(channelId, () => this.stop(channelId));
      } catch (e) {
        // Still busy: a buffer nobody is watching any more (waiting out its grace period) gives way.
        if (e.status !== 409 || !this.stopIdle()) throw e;
        lease = this.claim(channelId, () => this.stop(channelId));
      }
      s = this.start(channelId, lease);
    }
    s.viewers.set(viewer || 'anon', Date.now());
    await s.ready;
    return s;
  }

  start(channelId, lease = null) {
    const root = this.dir();
    const dir = path.join(root, `ch-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    const s = { channelId, dir, proc: null, viewers: new Map(), stopped: false, fails: 0, minutes: this.fitMinutes(root), startedAt: Date.now(), lease };
    this.sessions.set(channelId, s);
    s.ready = new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = () => {
        if (s.stopped) return reject(new Error(s.error || 'Stopped'));
        if (this.playlist(s).includes('#EXTINF')) return resolve();
        if (Date.now() - t0 > 20000) { s.error = s.error || 'No video from this channel'; this.stop(channelId); return reject(new Error(s.error)); }
        setTimeout(check, 200);
      };
      check();
    });
    s.ready.catch(() => {});
    this.run(s, false);
    return s;
  }

  async run(s, resume) {
    let args;
    try { args = await this.input(s.channelId, s); } catch (e) { s.error = e.message; if (this.health) this.health.bufferExited(s.channelId, e.message); return this.stop(s.channelId); }
    if (s.stopped) return;
    if (this.health) this.health.bufferStarted(s.channelId, args);
    const flags = `delete_segments+independent_segments+omit_endlist${resume ? '+append_list+discont_start' : ''}`;
    // -progress: how much video has been written, so playback health can tell when the stream falls behind.
    const proc = spawn(this.ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...args, '-c:a', 'aac', '-ac', '2', '-b:a', '160k',
      '-f', 'hls', '-hls_time', String(SEG_S), '-hls_list_size', String(Math.round((s.minutes * 60) / SEG_S)), '-hls_flags', flags,
      '-hls_segment_filename', path.join(s.dir, 'seg%06d.ts'), path.join(s.dir, 'live.m3u8')], { stdio: ['ignore', 'pipe', 'pipe'] });
    s.proc = proc;
    let err = '';
    const began = Date.now();
    proc.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
    let progress = '';
    proc.stdout.on('data', (d) => {
      progress = (progress + d).slice(-4000);
      const lines = progress.split('\n');
      progress = lines.pop();
      for (const l of lines) {
        const m = /^out_time_us=(\d+)/.exec(l);
        if (m && this.health && !s.stopped) this.health.progress(s.channelId, +m[1]);
      }
    });
    proc.on('close', () => {
      if (s.stopped) return;
      if (this.health) this.health.bufferExited(s.channelId, err.trim().split('\n').pop());
      // The source dropped: carry on in the same buffer. Give up only if it keeps failing straight away.
      s.fails = Date.now() - began > 30000 ? 0 : s.fails + 1;
      if (err) s.error = err.trim().split('\n').pop();
      if (s.fails > 8) { this.note(`live buffer: gave up on ${s.channelId}: ${s.error || 'stream ended'}`); return this.stop(s.channelId); }
      setTimeout(() => !s.stopped && this.run(s, this.playlist(s).includes('#EXTINF')), Math.min(s.fails, 5) * 1000);
    });
  }

  // As many minutes as asked for, but only as many as the disk has room for.
  fitMinutes(root) {
    let free = Infinity;
    try { const st = fs.statfsSync(root); free = (st.bavail * st.bsize) / 1e6; } catch (_) { /* unknown: assume room */ }
    return Math.max(2, Math.min(this.minutes(), Math.floor((free - SPARE_MB) / MB_PER_MIN)));
  }

  playlist(s) {
    try { return fs.readFileSync(path.join(s.dir, 'live.m3u8'), 'utf8'); } catch (_) { return ''; }
  }

  touch(channelId, viewer) {
    const s = this.sessions.get(channelId);
    if (s) s.viewers.set(viewer || 'anon', Date.now());
  }

  release(channelId, viewer) {
    const s = this.sessions.get(channelId);
    if (!s) return;
    s.viewers.delete(viewer || 'anon');
    if (!s.viewers.size) s.emptySince = Date.now();
  }

  // A piece of a channel's buffer, or null. Only names ffmpeg itself writes are served.
  file(channelId, name) {
    const s = this.sessions.get(channelId);
    if (!s || !/^(live\.m3u8|seg\d+\.ts)$/.test(name)) return null;
    return path.join(s.dir, name);
  }

  reap() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      for (const [v, seen] of s.viewers) if (now - seen > STALE_MS) s.viewers.delete(v);
      if (s.viewers.size) { s.emptySince = null; continue; }
      s.emptySince = s.emptySince || now;
      if (now - s.emptySince >= GRACE_MS) this.stop(id);
    }
  }

  stop(channelId) {
    const s = this.sessions.get(channelId);
    if (!s) return;
    s.stopped = true;
    this.sessions.delete(channelId);
    if (this.health) this.health.bufferStopped(channelId);
    if (s.lease) this.unclaim(s.lease);
    if (s.proc) {
      const proc = s.proc;
      proc.kill();
      // The provider counts the stream until ffmpeg's connection closes; don't let a stuck ffmpeg hold it.
      setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 1500).unref();
    }
    setTimeout(() => fs.rm(s.dir, { recursive: true, force: true }, () => {}), 1000); // after ffmpeg lets go of the files
  }

  // Stops every buffer with no one watching. -> how many were stopped.
  stopIdle() {
    let n = 0;
    for (const [id, s] of [...this.sessions]) if (!s.viewers.size) { this.stop(id); n++; }
    return n;
  }

  stopAll() {
    clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}

module.exports = { Timeshift };
