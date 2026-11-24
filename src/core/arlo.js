// Arlo camera pop-ups. Camera Keeper (a separate service, usually on the home server) records a
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

// Camera Keeper knows GarysTV by this: the household's TVs don't show other people's cameras.
const UA = `GarysTV/${(() => { try { return require('../../package.json').version; } catch (_) { return '0'; } })()}`;

const DEFAULTS = { enabled: false, url: 'http://127.0.0.1:8090', cameras: [] };
const RENEW_MS = 5 * 60000; // Camera Keeper forgets a GarysTV that hasn't checked in for 30 minutes
// What /arlo/view may fetch from Camera Keeper: a clip as it records, or a saved one.
const LIVE_PATH = /^\/live\/[A-Za-z0-9_-]+\.ts$/;
const CLIP_PATH = /^\/media\/[\w\-. ]+(\/[\w\-. ]+)*\.mp4$/;
// A clip's still picture, for the Arlo screen's list (/arlo/thumb).
const THUMB_PATH = /^\/media\/[\w\-. ]+(\/[\w\-. ]+)*\.(jpe?g|png)$/i;

function safePath(p) {
  p = String(p || '');
  return !p.includes('..') && (LIVE_PATH.test(p) || CLIP_PATH.test(p)) ? p : null;
}

// A camera id as Camera Keeper writes them (Arlo device ids, blink-123, ipcam-...).
function safeCam(id) {
  id = String(id || '');
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(id) && !id.includes('..') ? id : null;
}

function liveState(r) {
  r = r || {};
  return { state: r.state || 'off', error: r.error || null, secondsLeft: +r.seconds_left || 0, viewers: +r.viewers || 0 };
}

function safeThumb(p) {
  p = String(p || '');
  return !p.includes('..') && THUMB_PATH.test(p) ? p : null;
}

// The Camera Keeper address from Settings, split into the address itself and its sign-in.
// A name and password in the address (https://name:password@bcn.tapper.co) are sent with every
// request, the clips (ffmpeg) included, so Camera Keeper never has to ask for them.
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

// A hint for the usual mistake: a Cloudflare name (bcn.tapper.co) with the home port on it.
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

  // JSON request to Camera Keeper.
  request(method, path, body) {
    const a = this.address;
    if (a.error) return Promise.reject(new Error(a.error));
    const url = new URL(a.base + path);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json', 'User-Agent': UA, ...(a.auth ? { Authorization: a.auth } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) };
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method, timeout: 8000, headers }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          if (res.statusCode >= 300) {
            let why = '';
            try { why = JSON.parse(text).error || ''; } catch (_) { why = /^[^<]{1,200}$/.test(text.trim()) ? text.trim() : ''; }
            if (res.statusCode === 401) {
              why = a.auth ? `${why || 'It turned down the name and password in the address.'} Use the away-from-home name and password from Camera Keeper's Alerts page.`
                : 'It asks for a password: put the away-from-home name and password in the address, like https://name:password@bcn.tapper.co';
            } else if (res.statusCode >= 300 && res.statusCode < 400) why = `it sent GarysTV to ${res.headers.location || 'another page'}; check the address (https:// instead of http://?)`;
            return reject(new Error(`Camera Keeper answered ${res.statusCode}${why ? `: ${why}` : ''}`));
          }
          try { resolve(JSON.parse(text)); } catch (_) { reject(new Error("That address answered, but it isn't Camera Keeper.")); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (e) => reject(new Error(`Couldn't reach Camera Keeper at ${a.base} (${e.message}).${addressHint(a)}`)));
      if (data) req.write(data);
      req.end();
    });
  }

  // Settings > Arlo: the cameras Camera Keeper knows, with which are ticked.
  async cameras() {
    const r = await this.request('GET', '/api/cameras');
    const on = new Set(this.settings.cameras);
    const brandOf = (c) => c.brand || (String(c.id).startsWith('blink-') ? 'blink' : 'arlo');
    const cameras = (r.cameras || []).map((c) => ({ id: String(c.id), name: c.name, model: c.model, battery: c.battery, unavailable: !!c.unavailable, lastMotion: c.last_motion,
      brand: brandOf(c), account: c.account ? `${brandOf(c)}:${c.account}` : null, on: on.has(String(c.id)),
      // Newer Camera Keepers say whether it can be watched live, and send its newest picture.
      live: c.live !== undefined ? !!c.live : brandOf(c) !== 'blink' && !c.unavailable,
      thumb: safeThumb(c.thumb) ? `/arlo/thumb?src=${encodeURIComponent(c.thumb)}` : null }));
    // Accounts (newer Camera Keepers list them; older ones only name each camera's account).
    let accounts = Array.isArray(r.accounts) ? r.accounts.map((x) => ({ id: `${x.brand}:${x.username}`, brand: x.brand, username: x.username, connected: !!x.connected, waitingForCode: !!x.waiting_for_code })) : [];
    for (const c of cameras) if (c.account && !accounts.some((x) => x.id === c.account)) accounts.push({ id: c.account, brand: c.brand, username: c.account.split(':').slice(1).join(':'), connected: true, waitingForCode: false });
    return { connected: !!r.connected, modes: r.modes || {}, subscribed: this.subscribed, error: this.lastError, cameras, accounts };
  }

  // Ask Camera Keeper to tell this GarysTV about motion (while Arlo is turned on here), or to stop.
  async checkIn() {
    const s = this.settings;
    try {
      if (s.enabled) {
        await this.request('POST', '/api/subscribe', { port: this.core.settings.port });
        if (!this.subscribed) this.core.note('arlo: Camera Keeper will tell this GarysTV about motion');
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

  // From Camera Keeper: { camera, camera_id, time, file, live, clip }. Passed to the screens if
  // Arlo is on here and that camera is ticked; they show it only while playing TV.
  motion(ev) {
    const s = this.settings, id = String(ev.camera_id || '');
    if (!s.enabled) return { shown: false, why: 'Cameras are turned off in Settings > Cameras' };
    if (!s.cameras.includes(id)) return { shown: false, why: `${ev.camera || id} isn't ticked in Settings > Cameras` };
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
    if (!pick) throw new Error('Camera Keeper has no saved clips yet to test with.');
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
    if (account && !camera) { // an older Camera Keeper ignores account=: keep that account's cameras here
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

  // Home > Arlo > Delete: removes the saved clip (video and picture) from Camera Keeper, for every
  // screen and the BAN app too. Arlo's own cloud copy, if any, isn't touched.
  async deleteClip(key) {
    key = String(key || '');
    if (!key || key.includes('..')) throw new Error('Which clip?');
    const r = await this.request('DELETE', `/api/clip/${key.split('/').map(encodeURIComponent).join('/')}`);
    if (!r || !r.ok) throw new Error("Camera Keeper doesn't have that clip any more.");
    return { ok: true };
  }

  // Home > Cameras > Save: a saved (starred) clip is never deleted by Camera Keeper's cleanup.
  async starClip(key, on) {
    key = String(key || '');
    if (!key || key.includes('..')) throw new Error('Which clip?');
    const r = await this.request('POST', `/api/clip/${key.split('/').map(encodeURIComponent).join('/')}/star`, { on: on !== false });
    return { ok: true, starred: !!(r && r.starred) };
  }

  // Home > Cameras > select several: delete, save or unsave them together.
  async bulkClips(keys, action) {
    keys = (Array.isArray(keys) ? keys : []).map(String).filter((k) => k && !k.includes('..'));
    if (!keys.length) throw new Error('No clips selected.');
    if (keys.length > 500) throw new Error('Select at most 500 clips at a time.');
    if (!['delete', 'star', 'unstar'].includes(action)) throw new Error('Delete, save or unsave?');
    const r = await this.request('POST', '/api/clips/bulk', { keys, action });
    return { ok: true, count: (r && r.count) || 0 };
  }

  // Settings > Cameras > Storage: Camera Keeper's space for clips and what happens when it's used up.
  async storage() {
    try {
      return await this.request('GET', '/api/storage');
    } catch (e) {
      if (/answered 404/.test(e.message)) throw new Error('Update Camera Keeper to change its storage from here.');
      throw e;
    }
  }

  async setStorage(b) {
    const out = {};
    if (b.maxGb !== undefined) out.max_gb = Math.max(0, parseInt(b.maxGb, 10) || 0);
    if (b.keepDays !== undefined) out.keep_days = Math.max(0, parseInt(b.keepDays, 10) || 0);
    if (b.whenFull !== undefined) {
      if (!['overwrite', 'stop'].includes(b.whenFull)) throw new Error('When full: overwrite or stop.');
      out.when_full = b.whenFull;
    }
    return this.request('POST', '/api/storage', out);
  }

  // Home > Cameras > Watch live: Camera Keeper opens the camera's live stream (one per camera,
  // shared by every TV and phone watching it) and sends it as JPEG pictures, which GarysTV passes
  // straight through (/arlo/live). It stops a few seconds after the last viewer leaves, or after
  // 3 minutes, so a battery camera isn't drained; "Keep watching" starts it again.
  async liveStart(camera) {
    const id = safeCam(camera);
    if (!id) throw new Error('Which camera?');
    if (id.startsWith('blink-')) throw new Error("Blink cameras can't be watched live here. Use the Blink app.");
    const r = await this.request('POST', `/api/camera/${encodeURIComponent(id)}/live`);
    if (r && r.state === 'error') throw new Error(r.error || "The camera didn't start.");
    return liveState(r);
  }

  async liveState(camera) {
    const id = safeCam(camera);
    if (!id) throw new Error('Which camera?');
    return liveState(await this.request('GET', `/api/camera/${encodeURIComponent(id)}/live`));
  }

  live(req, res, camera) {
    const id = safeCam(camera);
    const a = this.address;
    if (!id || a.error) { res.writeHead(400); return res.end(); }
    const url = new URL(`${a.base}/api/camera/${encodeURIComponent(id)}/live.mjpg`);
    const lib = url.protocol === 'https:' ? https : http;
    const up = lib.get(url, { headers: { 'User-Agent': UA, ...(a.auth ? { Authorization: a.auth } : {}) } }, (r) => {
      if (r.statusCode !== 200) { r.resume(); res.writeHead(r.statusCode === 404 ? 404 : 502); return res.end(); }
      res.writeHead(200, { 'Content-Type': r.headers['content-type'] || 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' });
      r.pipe(res);
    });
    // No overall timeout (it's a stream), but give up if Camera Keeper doesn't answer at all.
    up.setTimeout(30000, () => up.destroy(new Error('timed out')));
    up.on('response', () => up.setTimeout(0));
    up.on('error', (e) => { this.core.note(`arlo: live view: ${e.message}`); if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('close', () => up.destroy()); // Camera Keeper sees the viewer leave and stops the camera
  }

  // A clip's still picture, passed through from Camera Keeper (the TVs may not be able to reach it).
  thumb(req, res, src) {
    const p = safeThumb(src);
    if (!p) { res.writeHead(400); return res.end(); }
    const a = this.address;
    if (a.error) { res.writeHead(400); return res.end(); }
    const url = new URL(a.base + p);
    const lib = url.protocol === 'https:' ? https : http;
    const up = lib.get(url, { timeout: 8000, headers: { 'User-Agent': UA, ...(a.auth ? { Authorization: a.auth } : {}) } }, (r) => {
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
    const auth = ['-user_agent', UA, ...(a.auth ? ['-headers', `Authorization: ${a.auth}\r\n`] : [])];
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
