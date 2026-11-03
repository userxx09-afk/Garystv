// HTTP API + video streaming + the screens themselves. The Windows app window
// loads this; a TV app or a browser on the home network can load it too
// (on by default; "Allow other devices" in Settings turns it off).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { findFfmpeg, findVlc } = require('./tools');
const { bestVariant, HLS_INPUT, RECONNECT } = require('./hls');
const { Timeshift } = require('./timeshift');
const hdhomerun = require('./sources/hdhomerun');
const sourceTypes = require('./sources');
const { Vod } = require('./vod');
const { Tmdb } = require('./tmdb');
const { ToolInstaller } = require('./installer');
const { Auth } = require('./auth');
const { Peers } = require('./peers');
const { Sharing, remoteRecording } = require('./sharing');

const UI_DIR = path.join(__dirname, '..', 'ui');
const VERSION = require('../../package.json').version;
const MPEGTS = require.resolve('mpegts.js/dist/mpegts.js');
const HLSJS = require.resolve('hls.js/dist/hls.min.js');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body ?? null));
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

// ffmpeg input, picture/sound selection and clean-up shared by the player stream and the live buffer.
function decodeArgs(input, { live, seek = 0, copy = false }) {
  const args = [];
  if (input.lavfi) args.push('-re', '-f', 'lavfi', '-i', input.lavfi, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000');
  else {
    if (seek > 0) args.push('-ss', String(seek));
    // Live: probe briefly instead of ffmpeg's default ~5s so channel changes feel quick.
    if (live) args.push('-probesize', '1000000', '-analyzeduration', '1000000', '-fflags', '+nobuffer');
    // Recordings: real-time pace, but send the first 6s at once. (-re made every jump wait ~5s after -ss.)
    else args.push('-readrate', '1', '-readrate_initial_burst', '6');
    if (input.hls) args.push(...HLS_INPUT);
    if (/^https?:/i.test(input.url)) args.push(...RECONNECT);
    args.push('-i', input.url);
  }
  args.push('-map', '0:v:0', '-map', input.lavfi ? '1:a:0' : '0:a:0?');
  if (!copy) args.push('-vf', 'yadif=deint=interlaced,scale=-2:min(ih\\,1080)');
  return args;
}

// Converting 1080p video in software takes about three CPU cores; on a modest PC
// that left too little for anything else and live sound broke up. So:
//  - video that's already H.264 (internet channels and their recordings) passes
//    straight through; only the sound is converted (about 10% of one core)
//  - other video (antenna TV is usually MPEG-2) uses the graphics chip's encoder
//    (Intel Quick Sync) when there is one, else the software encoder
const h264Seen = new Map(); // channel stream or recording file -> true/false
async function isH264(core, input, key) {
  if (input.lavfi || !input.url) return false;
  if (h264Seen.has(key)) return h264Seen.get(key);
  const ffmpeg = findFfmpeg(core.settings);
  const probe = ffmpeg && path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
  if (!probe || !fs.existsSync(probe)) return false;
  const codec = await new Promise((resolve) => execFile(probe, ['-v', 'error', ...(input.hls ? HLS_INPUT : []), '-probesize', '1000000', '-analyzeduration', '1000000',
    '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', input.url], { timeout: 8000, windowsHide: true },
  (err, out) => resolve(err ? '' : String(out).trim())));
  if (codec) h264Seen.set(key, codec.startsWith('h264'));
  return codec.startsWith('h264');
}

let quickSync = null; // Promise<boolean>, checked once
function hasQuickSync(ffmpeg) {
  quickSync ||= new Promise((resolve) => execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1',
    '-c:v', 'h264_qsv', '-f', 'null', '-'], { timeout: 20000, windowsHide: true }, (err) => resolve(!err)));
  return quickSync;
}

// -> { copy, video: ffmpeg video output options }. keyEvery: seconds between keyframes (live buffer pieces).
async function videoPlan(core, input, key, keyEvery = 2) {
  if (await isH264(core, input, key)) return { copy: true, video: ['-c:v', 'copy'] };
  const keys = ['-force_key_frames', `expr:gte(t,n_forced*${keyEvery})`];
  if (await hasQuickSync(findFfmpeg(core.settings))) return { copy: false, video: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', '6M', '-maxrate', '6M', ...keys] };
  return { copy: false, video: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '6M', '-bufsize', '12M', ...keys] };
}

// Transcodes to H.264/AAC MPEG-TS that the built-in player can show. Over-the-air
// TV is usually MPEG-2 (which browsers can't decode), so this is always needed.
async function streamVideo(core, req, res, input, { live, seek = 0, key }) {
  const ffmpeg = findFfmpeg(core.settings);
  if (!ffmpeg) return send(res, 501, { error: 'ffmpeg is not installed, so the built-in player is unavailable.' });
  const plan = await videoPlan(core, input, key);
  const args = ['-hide_banner', '-loglevel', 'error', ...decodeArgs(input, { live, seek, copy: plan.copy }), ...plan.video,
    '-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-f', 'mpegts', 'pipe:1'];
  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
  proc.stdout.pipe(res);
  proc.on('close', (code) => { if (code && err) core.note(`player: ${err.trim().split('\n').pop()}`); res.end(); });
  req.on('close', () => proc.kill());
}

// This PC's home-network addresses (what you'd type into the TV app). Skips virtual adapters (VirtualBox, WSL,
// VPNs); Windows often names VirtualBox's just "Ethernet 2", so its default 192.168.56.x range is skipped too.
function lanAddresses() {
  return Object.entries(require('os').networkInterfaces())
    .filter(([name]) => !/virtual|vethernet|vmware|hyper-v|loopback|vpn|tailscale|zerotier/i.test(name))
    .flatMap(([, list]) => list.filter((a) => a.family === 'IPv4' && !a.internal && !/^(169\.254|192\.168\.56)\./.test(a.address)).map((a) => a.address));
}

// ffmpeg's drawtext can't find fonts on Windows without fontconfig, so point it at one directly.
const FONT = ['C:\\Windows\\Fonts\\segoeui.ttf', 'C:\\Windows\\Fonts\\arial.ttf'].find((f) => fs.existsSync(f));
const label = (text) => FONT
  ? `,drawtext=fontfile='${FONT.replace(/\\/g, '/').replace(':', '\\:')}':text='${text.replace(/[':\\]/g, '')}':fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12:x=(w-tw)/2:y=h-120`
  : '';

// Only this PC, the home network and the TV app may use the engine. A website open
// in a browser on the PC must not be able to set timers or delete recordings, so:
//  - Host must be an IP, localhost, a bare machine name or *.local (stops DNS rebinding)
//  - a web page's Origin must be on the home network; the TV app's file:// / null origin is allowed
const HOME_HOST = /^(localhost|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|169\.254(\.\d+){2}|\[[0-9a-f:.]+\]|[a-z0-9-]+|[a-z0-9-]+\.local)$/i;
function checkCaller(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!HOME_HOST.test(host)) return { ok: false };
  const origin = req.headers.origin;
  if (!origin) return { ok: true };
  if (origin === 'null') return { ok: true, cors: 'null' }; // packaged TV app pages can report a null origin
  let u;
  try { u = new URL(origin); } catch (_) { return { ok: false }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: true, cors: origin }; // file://, app:// (TV app)
  return HOME_HOST.test(u.hostname) ? { ok: true, cors: origin } : { ok: false };
}

function playerInput(core, kind, id) {
  if (kind === 'live') {
    const ch = core.channels.find((c) => c.id === id);
    if (!ch) throw new Error('Channel not found');
    if (!ch.streamUrl) return { lavfi: `testsrc2=size=1280x720:rate=30${label(`${ch.number} ${ch.name}  (practice)`)}`, title: ch.name };
    return { url: ch.streamUrl, title: `${ch.number} ${ch.name}` };
  }
  const rec = core.recordings.find((r) => r.id === id);
  if (!rec) throw new Error('Recording not found');
  if (rec.simulated) return { lavfi: `testsrc2=size=1280x720:rate=30`, title: rec.title };
  return { url: rec.file, title: rec.title };
}

// The video as it comes, without ffmpeg, for VLC on a TV (the backup player). A recording is
// the file itself (VLC can skip around in it); a channel or movie is passed through from the
// provider, so its address (with the IPTV login in it) stays on this machine. HLS streams are
// lists of pieces at other addresses, so VLC is sent to the real one instead.
function relay(req, res, url, hops = 0) {
  const lib = url.startsWith('https:') ? require('https') : http;
  const up = lib.get(url, { headers: { 'User-Agent': 'VLC/3.0' } }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 5) {
      r.resume();
      return relay(req, res, new URL(r.headers.location, url).href, hops + 1);
    }
    res.writeHead(r.statusCode, { 'Content-Type': r.headers['content-type'] || 'video/mp2t', 'Cache-Control': 'no-store' });
    r.pipe(res);
  });
  up.on('error', (e) => send(res, 502, { error: e.message }));
  req.on('close', () => up.destroy());
}

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err) return send(res, 404, { error: 'Not found' });
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const start = m && m[1] ? +m[1] : 0;
    const end = m && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/mp2t', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(m ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}) });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

function createServer(core) {
  const clients = new Set();
  const tools = core.tools = new ToolInstaller(core);
  const auth = core.auth = new Auth(core);
  const peers = core.peers = new Peers(core, auth);
  const sharing = core.sharing = new Sharing(core, peers);
  const peerOnly = (req) => { if (!req.who.peer) throw new Error('Only for a linked GarysTV.'); return req.who.peer; };
  // A recording at the other place (sharing.js): changes go to it.
  const atPeer = (id, method, body) => {
    const at = remoteRecording(decodeURIComponent(id));
    if (!at) return null;
    sharing.forget(at.peerId);
    return peers.call(peers.find(at.peerId), method, `/api/recordings/${encodeURIComponent(at.recId)}`, body);
  };
  const timeshift = core.timeshift = new Timeshift({
    ffmpeg: () => findFfmpeg(core.settings),
    dir: () => path.join(core.settings.recordingsDir, '.live-buffer'),
    minutes: () => core.settings.timeshiftMinutes || 30,
    note: (m) => core.note(m),
    // Watching uses a plan like recording does; the same channel on another plan if this one is busy.
    claim: (channelId, onBump) => {
      const ch = core.channels.find((c) => c.id === channelId);
      return ch && ch.streamUrl ? core.tuners.acquire(channelId, 'live', ch.name, onBump) : null;
    },
    unclaim: (lease) => core.tuners.release(lease.id),
    input: async (channelId, s) => {
      if (!findFfmpeg(core.settings)) throw new Error('ffmpeg is not installed, so the built-in player is unavailable.');
      const input = playerInput(core, 'live', s && s.lease ? s.lease.channel.id : channelId);
      const key = input.url;
      if (input.url && /\.m3u8(\?|$)/i.test(input.url)) Object.assign(input, { url: await bestVariant(input.url), hls: true });
      const plan = await videoPlan(core, input, key);
      return [...decodeArgs(input, { live: true, copy: plan.copy }), ...plan.video];
    },
  });
  core.on('changed', (what) => { for (const c of clients) c.write(`data: ${JSON.stringify({ what })}\n\n`); });
  const vod = core.vod = new Vod(core);
  const tmdb = core.tmdb = new Tmdb(core);
  core.on('changed', (what) => { if (what === 'sources') vod.cache.clear(); }); // new login or server: read the library again

  const routes = [
    ['GET', '/api/ping', () => ({ app: 'GarysTV', name: require('os').hostname(), platform: process.platform, addresses: lanAddresses() })], // TV app looks for this when searching the network
    ['GET', '/api/state', () => ({
      // The TMDb key itself stays on the server; screens only learn whether there is one.
      settings: { ...core.settings, tmdbKey: undefined, tmdbKeyFrom: tmdb.keySource() }, types: core.describeTypes(), sources: core.sources, guides: core.guides,
      channels: core.channels, guideChannels: core.guideData.channels.map(({ id, names, number, providerName }) => ({ id, names, number, providerName })),
      rules: core.rules, status: { ...core.status(), tools: tools.status(), platform: process.platform, version: VERSION }, favLists: core.favLists,
    })],
    // Linked GarysTVs at other locations (peers.js).
    ['GET', '/api/peers', () => peers.overview()],
    ['POST', '/api/peers', async (q, b, p, req) => { const them = await peers.link(req, b); if (b.share) sharing.linked(); return them; }],
    ['DELETE', '/api/peers/:id', async (q, b, p) => { await peers.unlink(p.id); core.tuners.remote.delete(p.id); sharing.forget(p.id); }],
    ['DELETE', '/api/peer/self', (q, b, p, req) => { const peer = peerOnly(req); peers.dropped(peer); core.tuners.remote.delete(peer.id); sharing.forget(peer.id); }],
    // Home and work sharing (sharing.js): plans in use and timers, lists and channel choices.
    ['POST', '/api/peer/beat', (q, b, p, req) => sharing.receive(peerOnly(req), b)],
    ['GET', '/api/peer/shared', (q, b, p, req) => { peerOnly(req); return sharing.shared(); }],
    ['POST', '/api/peer/yield', (q, b, p, req) => sharing.yieldPlan(peerOnly(req), b)],
    // Other locations (auth.js): the password they sign in with, and the devices signed in.
    ['GET', '/api/remote', (q, b, p, req) => ({ ...auth.overview(), home: req.who.home, me: req.who.login ? req.who.login.id : null })],
    ['PUT', '/api/remote/password', (q, b) => auth.setPassword(b.password)],
    ['DELETE', '/api/remote/logins/:id', (q, b, p) => auth.signOut(p.id)],
    ['DELETE', '/api/remote/logins', () => auth.signOut()],
    ['POST', '/api/favlists', (q, b) => core.addFavList(b)],
    ['PUT', '/api/favlists/:id', (q, b, p) => core.updateFavList(p.id, b)],
    ['DELETE', '/api/favlists/:id', (q, b, p) => core.removeFavList(p.id)],
    ['POST', '/api/favlists/:id/toggle', (q, b, p) => core.toggleFavChannel(p.id, String(b.channelId || ''), b.on)],
    // Movies and shows from IPTV providers (core/vod.js). kind: movies | shows
    ['GET', '/api/vod', () => ({ providers: vod.providers().length, continue: vod.continueList(), favorites: vod.favoriteList() })],
    ['PUT', '/api/vod/favorite/:id', (q, b, p) => vod.setFavorite(decodeURIComponent(p.id), b.on !== false, b.item)],
    ['GET', '/api/vod/search', (q) => Promise.all(['movies', 'shows'].map((k) => vod.search(k, q.q))).then(([movies, shows]) => ({ movies, shows }))],
    ['GET', '/api/vod/movie/:id', (q, b, p) => vod.movie(decodeURIComponent(p.id))],
    ['GET', '/api/vod/show/:id', (q, b, p) => vod.show(decodeURIComponent(p.id))],
    ['GET', '/api/tmdb', (q) => tmdb.lookup(q.kind, q.name, q.year)],
    ['POST', '/api/tmdb/clear', () => tmdb.clearCache()],
    ['PUT', '/api/vod/progress/:id', (q, b, p) => vod.saveProgress(decodeURIComponent(p.id), b)],
    ['GET', '/api/vod/:kind/categories', (q, b, p) => vod.categories(p.kind)],
    ['GET', '/api/vod/:kind/category/:id', (q, b, p) => vod.items(p.kind, decodeURIComponent(p.id))],
    ['GET', '/api/guide', (q) => core.getGuide(+q.from || Date.now(), +q.to || Date.now() + 3 * 3600000)],
    ['GET', '/api/schedule', () => core.getSchedule()],
    ['GET', '/api/recordings', (q, b, p, req) => (req.who.peer ? core.getRecordings() : sharing.withShared(core.getRecordings()))],
    ['GET', '/api/search', (q) => core.search(q.q)],
    ['PUT', '/api/settings', (q, b) => core.updateSettings(b)],
    ['GET', '/api/discover', () => hdhomerun.discover()],
    ['POST', '/api/sources', (q, b) => core.addSource(b)],
    ['PUT', '/api/sources/:id', (q, b, p) => core.updateSource(p.id, b)],
    ['DELETE', '/api/sources/:id', (q, b, p) => core.removeSource(p.id)],
    ['POST', '/api/sources/:id/scan', (q, b, p) => core.scanSource(p.id).then((r) => ({ info: r.info }))],
    ['POST', '/api/sources/:id/antenna-scan', (q, b, p) => hdhomerun.startAntennaScan(core.sources.find((s) => s.id === p.id).config)],
    ['GET', '/api/sources/:id/antenna-scan', (q, b, p) => hdhomerun.antennaScanStatus(core.sources.find((s) => s.id === p.id).config)],
    ['GET', '/api/backup', (q) => core.backup({ logins: q.logins === '1', version: VERSION })],
    ['POST', '/api/backup', (q, b) => core.restore(b)],
    ['POST', '/api/channels/renumber', (q, b) => core.renumberChannels(b)],
    ['PUT', '/api/channels/:id', (q, b, p) => core.updateChannel(decodeURIComponent(p.id), b)],
    ['POST', '/api/guides', (q, b) => core.addGuide(b)],
    ['PUT', '/api/guides/:id', (q, b, p) => { core.updateGuide(p.id, b); if (b.config) core.refreshSoon(); }],
    ['DELETE', '/api/guides/:id', (q, b, p) => core.removeGuide(p.id)],
    ['POST', '/api/guides/refresh', () => core.refreshGuides()],
    ['POST', '/api/rules', (q, b) => core.addRule(b)],
    ['PUT', '/api/rules/:id', (q, b, p) => core.updateRule(p.id, b)],
    ['DELETE', '/api/rules/:id', (q, b, p) => core.removeRule(p.id)],
    ['POST', '/api/rules/:id/move', (q, b, p) => core.moveRule(p.id, b.delta)],
    ['POST', '/api/jobs/skip', (q, b) => core.skipJob(b.id, b.skip !== false)],
    ['PUT', '/api/recordings/:id', (q, b, p) => atPeer(p.id, 'PUT', b) || core.patchRecording(p.id, { position: b.position, watched: b.watched })],
    ['POST', '/api/timeshift/release', (q, b) => timeshift.release(b.channelId, b.viewer)],
    ['DELETE', '/api/recordings/:id', (q, b, p) => atPeer(p.id, 'DELETE') || core.deleteRecording(p.id)],
    ['POST', '/api/tools/:name/install', (q, b, p) => tools.install(p.name)],
    // Updates: the Windows app's own (src/app-updates.js), or a home server's (core/server-updates.js).
    ['GET', '/api/app-update', () => (core.appUpdater ? core.appUpdater.status() : { supported: false })],
    ['POST', '/api/app-update/check', () => (core.appUpdater ? core.appUpdater.check() : null)],
    ['POST', '/api/app-update/install', () => { if (!core.appUpdater) throw new Error('This GarysTV has no updater.'); return core.appUpdater.install(); }],
    ['POST', '/api/external-play', async (q, b) => {
      const vlc = findVlc(core.settings);
      if (!vlc) throw new Error('VLC is not installed.');
      const input = b.kind === 'vod' ? await vod.input(b.id) : playerInput(core, b.kind, b.id);
      if (!input.url) throw new Error('Practice channels have no real video.');
      spawn(vlc, [input.url, '--fullscreen', `--meta-title=${input.title}`], { detached: true, stdio: 'ignore' }).unref();
    }],
  ];

  const compiled = routes.map(([method, pattern, fn]) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    return { method, re, keys, fn };
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    // At home: as always. From another location: a linked GarysTV's key, or a device that signed in (auth.js).
    const who = (core.peers && core.peers.check(req)) || auth.check(req);
    req.who = who;
    // Another GarysTV linking with this one (from wherever it is): checked with this one's password (peers.js).
    if (url.pathname === '/api/peer/link' && req.method === 'POST' && !req.headers.origin) {
      try { return send(res, 200, peers.accept(req, await readBody(req))); } catch (e) { return send(res, e.status || 400, { error: e.message }); }
    }
    if (!who.home) {
      const origin = req.headers.origin;
      let sameSite = !origin;
      try { sameSite = sameSite || new URL(origin).host === req.headers.host; } catch (_) { /* odd origin */ }
      if (!sameSite) return send(res, 403, { error: 'Not allowed from this address' });
      if (url.pathname === '/api/login' && req.method === 'POST') {
        try {
          res.setHeader('Set-Cookie', auth.signIn(req, await readBody(req)));
          return send(res, 200, { ok: true });
        } catch (e) { return send(res, e.status || 400, { error: e.message }); }
      }
      if (!who.ok) {
        // The screens' own files aren't secret; the start page becomes the sign-in page.
        if (['/', '/index.html'].includes(url.pathname)) return fs.readFile(path.join(UI_DIR, 'login.html'), (err, data) => { res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }); res.end(data); });
        if (url.pathname.startsWith('/api/') || /^\/(events|stream|direct|timeshift|peer)\b/.test(url.pathname)) return send(res, 401, { error: 'Sign in first.', login: true });
      }
    }
    const caller = who.home ? checkCaller(req) : { ok: true };
    if (!caller.ok) return send(res, 403, { error: 'Not allowed from this address' });
    if (caller.cors) {
      res.setHeader('Access-Control-Allow-Origin', caller.cors);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
        return res.end();
      }
    }
    try {
      // Managing a linked GarysTV: everything for it is passed on (not by a linked one: no chains).
      const pm = /^\/peer\/([a-f0-9]+)(\/.*)$/.exec(url.pathname);
      if (pm) {
        if (who.peer) return send(res, 403, { error: 'Not allowed' });
        return peers.proxy(req, res, pm[1], pm[2] + url.search);
      }
      if (url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': hello\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      // Live TV buffer: the playlist (starts the buffer if needed) and its video pieces.
      const tsm = /^\/timeshift\/([^/]+)\/(live\.m3u8|seg\d+\.ts)$/.exec(url.pathname);
      if (tsm) {
        const channelId = decodeURIComponent(tsm[1]);
        if (tsm[2] === 'live.m3u8') await timeshift.open(channelId, q.v);
        const file = timeshift.file(channelId, tsm[2]);
        if (!file) return send(res, 404, { error: 'Not found' });
        return fs.readFile(file, (err, data) => {
          if (err) return send(res, 404, { error: 'Not found' });
          res.writeHead(200, tsm[2] === 'live.m3u8'
            ? { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }
            : { 'Content-Type': 'video/mp2t', 'Cache-Control': 'max-age=3600' });
          res.end(data);
        });
      }
      // A recording at the other place (sharing.js): played from there, through here.
      const far = /^\/(direct|stream)\/rec\/(~[^/]+)$/.exec(url.pathname);
      if (far) {
        const at = remoteRecording(decodeURIComponent(far[2]));
        if (!at) return send(res, 404, { error: 'Not found' });
        return peers.proxy(req, res, at.peerId, `/${far[1]}/rec/${encodeURIComponent(at.recId)}${url.search}`);
      }
      const d = /^\/direct\/(live|rec|vod)\/([^/]+)$/.exec(url.pathname);
      if (d) {
        const lease = leaseFor(core, req, d[1], decodeURIComponent(d[2]));
        const input = d[1] === 'vod' ? await vod.input(decodeURIComponent(d[2])) : playerInput(core, d[1], lease && lease.channel ? lease.channel.id : decodeURIComponent(d[2]));
        if (!input.url) return send(res, 404, { error: 'Practice channels have no real video.' });
        if (d[1] === 'rec') return sendFile(req, res, input.url);
        if (/\.m3u8(\?|$)/i.test(input.url)) { res.writeHead(302, { Location: input.url }); return res.end(); }
        return relay(req, res, input.url);
      }
      const m = /^\/stream\/(live|rec|vod)\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const lease = leaseFor(core, req, m[1], decodeURIComponent(m[2]));
        const input = m[1] === 'vod' ? await vod.input(decodeURIComponent(m[2])) : playerInput(core, m[1], lease && lease.channel ? lease.channel.id : decodeURIComponent(m[2]));
        const key = input.url;
        if (input.url && /\.m3u8(\?|$)/i.test(input.url)) Object.assign(input, { url: await bestVariant(input.url), hls: true });
        return streamVideo(core, req, res, input, { live: m[1] === 'live', seek: +q.t || 0, key });
      }

      if (url.pathname.startsWith('/api/')) {
        for (const r of compiled) {
          const hit = r.method === req.method && r.re.exec(url.pathname);
          if (!hit) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, hit[i + 1]]));
          const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req, url.pathname === '/api/backup' ? 50e6 : 1e6) : {}; // a backup can be big
          return send(res, 200, await r.fn(q, body, params, req));
        }
        return send(res, 404, { error: 'Not found' });
      }

      // Static screens
      const lib = { '/lib/mpegts.js': MPEGTS, '/lib/hls.js': HLSJS }[url.pathname];
      const file = lib || path.join(UI_DIR, path.normalize(url.pathname === '/' ? 'index.html' : url.pathname).replace(/^(\.\.[\\/])+/, ''));
      if (!file.startsWith(UI_DIR) && !lib) return send(res, 403, { error: 'Forbidden' });
      fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    } catch (e) {
      send(res, e.status || 400, { error: e.message });
    }
  });
}

// A plan for a channel or movie that isn't through the live buffer (VLC, movies, the older
// player), given back when the stream ends. Recordings and practice channels need none.
function leaseFor(core, req, kind, id) {
  let lease = null;
  if (kind === 'vod') {
    lease = core.tuners.acquireSource(String(id).split('~')[1], 'a movie', () => req.destroy());
  } else if (kind === 'live') {
    const ch = core.channels.find((c) => c.id === id);
    if (!ch || !ch.streamUrl) return null;
    lease = core.tuners.acquire(id, 'live', ch.name, () => req.destroy());
  } else return null;
  req.on('close', () => core.tuners.release(lease.id));
  return lease;
}

module.exports = { createServer, sourceTypes };
