// Arlo camera pop-ups. Arlo Keeper (a separate service, usually on the home server) records a
// clip when a camera sees motion and tells GarysTV straight away (POST /api/arlo/motion). If
// the camera is ticked in Settings > Arlo, every screen playing live TV or a recording shows
// that clip, muted, in its lower-left corner for a few seconds (player.js).
//
// The clip is shown as a stream of small JPEG pictures (/arlo/view), made here with ffmpeg:
// it plays in a plain <img> on every TV, needs no second video decoder (TVs often have only
// one, and the TV itself is using it), and Arlo's HEVC video plays everywhere this way.
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { findFfmpeg } = require('./tools');

const DEFAULTS = { enabled: false, url: 'http://127.0.0.1:8090', cameras: [] };
const RENEW_MS = 5 * 60000; // Arlo Keeper forgets a GarysTV that hasn't checked in for 30 minutes
// What /arlo/view may fetch from Arlo Keeper: a clip as it records, or a saved one.
const LIVE_PATH = /^\/live\/[A-Za-z0-9_-]+\.ts$/;
const CLIP_PATH = /^\/media\/[\w\-. ]+(\/[\w\-. ]+)*\.mp4$/;
// A clip's still picture, for the Arlo screen's list (/arlo/thumb).
const THUMB_PATH = /^\/media\/[\w\-. ]+(\/[\w\-. ]+)*\.(jpe?g|png)$/i;

function safePath(p) {
  p = String(p || '');
  return !p.includes('..') && (LIVE_PATH.test(p) || CLIP_PATH.test(p)) ? p : null;
}

function safeThumb(p) {
  p = String(p || '');
  return !p.includes('..') && THUMB_PATH.test(p) ? p : null;
}

class Arlo {
  constructor(core, broadcast) {
    this.core = core;
    this.broadcast = broadcast; // (object) -> sent to every screen over /events
    this.subscribed = false;
    this.lastError = null;
    core.on('changed', (what) => { if (what === 'settings') this.checkIn(); });
    setTimeout(() => this.checkIn(), 3000).unref();
    setInterval(() => this.checkIn(), RENEW_MS).unref();
  }

  get settings() {
    const s = this.core.settings.arlo || {};
    return { ...DEFAULTS, ...s, cameras: Array.isArray(s.cameras) ? s.cameras.map(String) : [] };
  }

  // JSON request to Arlo Keeper.
  request(method, path, body) {
    const base = (this.settings.url || DEFAULTS.url).replace(/\/+$/, '');
    let url;
    try { url = new URL(base + path); } catch (_) { return Promise.reject(new Error(`"${base}" isn't a web address. It should look like http://192.168.5.210:8090`)); }
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method, timeout: 6000, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          if (res.statusCode >= 300) return reject(new Error(`Arlo Keeper answered ${res.statusCode}${res.statusCode === 401 ? ' (it asks for a password; put it in the address: http://user:password@host:8090)' : ''}`));
          try { resolve(JSON.parse(text)); } catch (_) { reject(new Error("That address answered, but it isn't Arlo Keeper.")); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (e) => reject(new Error(`Couldn't reach Arlo Keeper at ${base} (${e.message}).`)));
      if (data) req.write(data);
      req.end();
    });
  }

  // Settings > Arlo: the cameras Arlo Keeper knows, with which are ticked.
  async cameras() {
    const r = await this.request('GET', '/api/cameras');
    const on = new Set(this.settings.cameras);
    return { connected: !!r.connected, modes: r.modes || {}, subscribed: this.subscribed, error: this.lastError,
      cameras: (r.cameras || []).map((c) => ({ id: String(c.id), name: c.name, model: c.model, battery: c.battery, unavailable: !!c.unavailable, lastMotion: c.last_motion, on: on.has(String(c.id)) })) };
  }

  // Ask Arlo Keeper to tell this GarysTV about motion (while Arlo is turned on here), or to stop.
  async checkIn() {
    const s = this.settings;
    try {
      if (s.enabled) {
        await this.request('POST', '/api/subscribe', { port: this.core.settings.port });
        if (!this.subscribed) this.core.note('arlo: Arlo Keeper will tell this GarysTV about motion');
        this.subscribed = true;
      } else if (this.subscribed) {
        await this.request('DELETE', '/api/subscribe', { port: this.core.settings.port });
        this.subscribed = false;
      }
      this.lastError = null;
    } catch (e) {
      if (s.enabled && this.lastError !== e.message) this.core.note(`arlo: ${e.message}`);
      this.lastError = e.message;
    }
  }

  // From Arlo Keeper: { camera, camera_id, time, file, live, clip }. Passed to the screens if
  // Arlo is on here and that camera is ticked; they show it only while playing TV.
  motion(ev) {
    const s = this.settings, id = String(ev.camera_id || '');
    if (!s.enabled) return { shown: false, why: 'Arlo is turned off in Settings > Arlo' };
    if (!s.cameras.includes(id)) return { shown: false, why: `${ev.camera || id} isn't ticked in Settings > Arlo` };
    const src = safePath(ev.live) || safePath(ev.clip);
    if (!src) throw new Error('No clip to show');
    this.broadcast({ what: 'arlo', motion: { camera: String(ev.camera || 'Camera'), cameraId: id, time: +ev.time || Date.now(), file: ev.file || null,
      view: `/arlo/view?src=${encodeURIComponent(src)}` } });
    return { shown: true };
  }

  // Settings > Arlo > Test: a pop-up with the newest saved clip (from a ticked camera if there is one).
  async test() {
    const clips = await this.request('GET', '/api/clips?limit=50');
    const on = new Set(this.settings.cameras);
    const pick = (clips || []).find((c) => on.has(String(c.camera_id)) && c.video_path) || (clips || []).find((c) => c.video_path);
    if (!pick) throw new Error('Arlo Keeper has no saved clips yet to test with.');
    const src = safePath(`/media/${pick.video_path}`);
    if (!src) throw new Error('That clip has an unusual file name.');
    this.broadcast({ what: 'arlo', motion: { camera: pick.camera_name, cameraId: String(pick.camera_id), time: Date.now(), file: pick.video_path, test: true,
      view: `/arlo/view?src=${encodeURIComponent(src)}` } });
    return { camera: pick.camera_name };
  }

  // The Arlo screen (Home > Arlo): saved clips, newest first, from every camera or one.
  async clips(camera, limit) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 60, 1), 200);
    const qs = `limit=${n}${camera ? `&camera=${encodeURIComponent(camera)}` : ''}`;
    const rows = await this.request('GET', `/api/clips?${qs}`);
    return (Array.isArray(rows) ? rows : []).map((c) => {
      const src = c.video_path && safePath(`/media/${c.video_path}`);
      const thumb = c.thumb_path && safeThumb(`/media/${c.thumb_path}`);
      return { key: c.key, camera: c.camera_name, cameraId: String(c.camera_id), time: +c.created_ms || 0, duration: c.duration_s || null,
        trigger: c.trigger || null, starred: !!c.starred, size: c.size_bytes || null,
        view: src ? `/arlo/view?big=1&src=${encodeURIComponent(src)}` : null,
        thumb: thumb ? `/arlo/thumb?src=${encodeURIComponent(thumb)}` : null };
    }).filter((c) => c.view);
  }

  // A clip's still picture, passed through from Arlo Keeper (the TVs may not be able to reach it).
  thumb(req, res, src) {
    const p = safeThumb(src);
    if (!p) { res.writeHead(400); return res.end(); }
    let url;
    try { url = new URL((this.settings.url || DEFAULTS.url).replace(/\/+$/, '') + p); } catch (_) { res.writeHead(400); return res.end(); }
    const lib = url.protocol === 'https:' ? https : http;
    const up = lib.get(url, { timeout: 8000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': r.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'max-age=86400' });
      r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('timed out')));
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('close', () => up.destroy());
  }

  // The clip as JPEG pictures (multipart/x-mixed-replace): ~10 a second, small enough for the
  // corner; or (big) bigger and smoother, for watching a clip full screen on the Arlo screen.
  view(req, res, src, big) {
    const path = safePath(src);
    if (!path) { res.writeHead(400); return res.end(); }
    const ffmpeg = findFfmpeg(this.core.settings);
    if (!ffmpeg) { res.writeHead(501); return res.end(); }
    const input = (this.settings.url || DEFAULTS.url).replace(/\/+$/, '') + path;
    const look = big ? ['-t', '120', '-an', '-vf', 'fps=15,scale=1280:-2', '-q:v', '5'] : ['-t', '30', '-an', '-vf', 'fps=10,scale=640:-2', '-q:v', '7'];
    // -re: show it at normal speed (a finished clip would otherwise be sent all at once).
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-i', input, ...look,
      '-f', 'mpjpeg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace;boundary=ffmpeg', 'Cache-Control': 'no-store' });
    proc.stdout.pipe(res);
    proc.on('close', (code) => { if (code && err && !res.destroyed) this.core.note(`arlo: ${err.trim().split('\n').pop()}`); res.end(); });
    req.on('close', () => proc.kill());
  }
}

module.exports = { Arlo, safePath };
