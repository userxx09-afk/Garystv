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

// The Arlo Keeper address from Settings, split into the address itself and its sign-in.
// A name and password in the address (https://name:password@ban.tapper.co) are sent with every
// request, the clips (ffmpeg) included, so Arlo Keeper never has to ask for them.
function keeperAddress(raw) {
  const base = String(raw || DEFAULTS.url).trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(base); } catch (_) { return { error: `"${base}" isn't a web address. It should look like http://192.168.5.210:8090` }; }
  if (!/^https?:$/.test(url.protocol)) return { error: `"${base}" isn't a web address. It should start with http:// or https://` };
  let auth = null;
  if (url.username || url.password) {
    const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
    auth = 'Basic ' + Buffer.from(`${dec(url.username)}:${dec(url.password)}`).toString('base64');
    url.username = ''; url.password = '';
  }
  return { base: url.toString().replace(/\/+$/, ''), auth, host: url.hostname, port: url.port };
}

// A hint for the usual mistake: a Cloudflare name (ban.tapper.co) with the home port on it.
// Cloudflare only passes the web ports, so :8090 there never answers.
function addressHint(a) {
  const lan = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a.host) || !a.host.includes('.');
  return !lan && a.port ? ` "${a.host}" is a name on the internet, which doesn't pass port ${a.port}: try https://name:password@${a.host} (no :${a.port}).` : '';
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

  get address() { return keeperAddress(this.settings.url); }

  // JSON request to Arlo Keeper.
  request(method, path, body) {
    const a = this.address;
    if (a.error) return Promise.reject(new Error(a.error));
    const url = new URL(a.base + path);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json', ...(a.auth ? { Authorization: a.auth } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) };
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method, timeout: 8000, headers }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          if (res.statusCode >= 300) {
            let why = '';
            try { why = JSON.parse(text).error || ''; } catch (_) { why = /^[^<]{1,200}$/.test(text.trim()) ? text.trim() : ''; }
            if (res.statusCode === 401) {
              why = a.auth ? `${why || 'It turned down the name and password in the address.'} Use the away-from-home name and password from Arlo Keeper's Alerts page.`
                : 'It asks for a password: put the away-from-home name and password in the address, like https://name:password@ban.tapper.co';
            } else if (res.statusCode >= 300 && res.statusCode < 400) why = `it sent GarysTV to ${res.headers.location || 'another page'}; check the address (https:// instead of http://?)`;
            return reject(new Error(`Arlo Keeper answered ${res.statusCode}${why ? `: ${why}` : ''}`));
          }
          try { resolve(JSON.parse(text)); } catch (_) { reject(new Error("That address answered, but it isn't Arlo Keeper.")); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (e) => reject(new Error(`Couldn't reach Arlo Keeper at ${a.base} (${e.message}).${addressHint(a)}`)));
      if (data) req.write(data);
      req.end();
    });
  }

  // Settings > Arlo: the cameras Arlo Keeper knows, with which are ticked.
  async cameras() {
    const r = await this.request('GET', '/api/cameras');
    const on = new Set(this.settings.cameras);
    const brandOf = (c) => c.brand || (String(c.id).startsWith('blink-') ? 'blink' : 'arlo');
    const cameras = (r.cameras || []).map((c) => ({ id: String(c.id), name: c.name, model: c.model, battery: c.battery, unavailable: !!c.unavailable, lastMotion: c.last_motion,
      brand: brandOf(c), account: c.account ? `${brandOf(c)}:${c.account}` : null, on: on.has(String(c.id)) }));
    // Accounts (newer Arlo Keepers list them; older ones only name each camera's account).
    let accounts = Array.isArray(r.accounts) ? r.accounts.map((x) => ({ id: `${x.brand}:${x.username}`, brand: x.brand, username: x.username, connected: !!x.connected, waitingForCode: !!x.waiting_for_code })) : [];
    for (const c of cameras) if (c.account && !accounts.some((x) => x.id === c.account)) accounts.push({ id: c.account, brand: c.brand, username: c.account.split(':').slice(1).join(':'), connected: true, waitingForCode: false });
    return { connected: !!r.connected, modes: r.modes || {}, subscribed: this.subscribed, error: this.lastError, cameras, accounts };
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

  // The Arlo screen (Home > Arlo): saved clips, newest first, from every camera, one camera, or
  // one account's cameras (account = "arlo:email" or "blink:email").
  async clips(camera, limit, account) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 60, 1), 200);
    const qs = `limit=${n}${camera ? `&camera=${encodeURIComponent(camera)}` : ''}${account && !camera ? `&account=${encodeURIComponent(account)}` : ''}`;
    let rows = await this.request('GET', `/api/clips?${qs}`);
    rows = Array.isArray(rows) ? rows : [];
    if (account && !camera) { // an older Arlo Keeper ignores account=: keep that account's cameras here
      const mine = new Set((await this.cameras().catch(() => ({ cameras: [] }))).cameras.filter((c) => c.account === account).map((c) => c.id));
      rows = rows.filter((c) => mine.has(String(c.camera_id)));
    }
    return rows.map((c) => {
      const src = c.video_path && safePath(`/media/${c.video_path}`);
      const thumb = c.thumb_path && safeThumb(`/media/${c.thumb_path}`);
      return { key: c.key, camera: c.camera_name, cameraId: String(c.camera_id), time: +c.created_ms || 0, duration: c.duration_s || null,
        trigger: c.trigger || null, starred: !!c.starred, size: c.size_bytes || null,
        view: src ? `/arlo/view?big=1&src=${encodeURIComponent(src)}` : null,
        thumb: thumb ? `/arlo/thumb?src=${encodeURIComponent(thumb)}` : null };
    }).filter((c) => c.view);
  }

  // Home > Arlo > Delete: removes the saved clip (video and picture) from Arlo Keeper, for every
  // screen and the BAN app too. Arlo's own cloud copy, if any, isn't touched.
  async deleteClip(key) {
    key = String(key || '');
    if (!key || key.includes('..')) throw new Error('Which clip?');
    const r = await this.request('DELETE', `/api/clip/${key.split('/').map(encodeURIComponent).join('/')}`);
    if (!r || !r.ok) throw new Error("Arlo Keeper doesn't have that clip any more.");
    return { ok: true };
  }

  // A clip's still picture, passed through from Arlo Keeper (the TVs may not be able to reach it).
  thumb(req, res, src) {
    const p = safeThumb(src);
    if (!p) { res.writeHead(400); return res.end(); }
    const a = this.address;
    if (a.error) { res.writeHead(400); return res.end(); }
    const url = new URL(a.base + p);
    const lib = url.protocol === 'https:' ? https : http;
    const up = lib.get(url, { timeout: 8000, headers: a.auth ? { Authorization: a.auth } : {} }, (r) => {
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
    const a = this.address;
    if (a.error) { res.writeHead(400); return res.end(); }
    const input = a.base + path;
    // The sign-in goes in a header: ffmpeg only sends one from the address after being asked.
    const auth = a.auth ? ['-headers', `Authorization: ${a.auth}\r\n`] : [];
    const look = big ? ['-t', '120', '-an', '-vf', 'fps=15,scale=1280:-2', '-q:v', '5'] : ['-t', '30', '-an', '-vf', 'fps=10,scale=640:-2', '-q:v', '7'];
    // -re: show it at normal speed (a finished clip would otherwise be sent all at once).
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', ...auth, '-i', input, ...look,
      '-f', 'mpjpeg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace;boundary=ffmpeg', 'Cache-Control': 'no-store' });
    proc.stdout.pipe(res);
    proc.on('close', (code) => { if (code && err && !res.destroyed) this.core.note(`arlo: ${err.trim().split('\n').pop()}`); res.end(); });
    req.on('close', () => proc.kill());
  }
}

module.exports = { Arlo, safePath, keeperAddress };
