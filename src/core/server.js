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

const UI_DIR = path.join(__dirname, '..', 'ui');
const MPEGTS = require.resolve('mpegts.js/dist/mpegts.js');
const HLSJS = require.resolve('hls.js/dist/hls.min.js');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body ?? null));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
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

function createServer(core) {
  const clients = new Set();
  const timeshift = core.timeshift = new Timeshift({
    ffmpeg: () => findFfmpeg(core.settings),
    dir: () => path.join(core.settings.recordingsDir, '.live-buffer'),
    minutes: () => core.settings.timeshiftMinutes || 30,
    note: (m) => core.note(m),
    input: async (channelId) => {
      if (!findFfmpeg(core.settings)) throw new Error('ffmpeg is not installed, so the built-in player is unavailable.');
      const input = playerInput(core, 'live', channelId);
      const key = input.url;
      if (input.url && /\.m3u8(\?|$)/i.test(input.url)) Object.assign(input, { url: await bestVariant(input.url), hls: true });
      const plan = await videoPlan(core, input, key);
      return [...decodeArgs(input, { live: true, copy: plan.copy }), ...plan.video];
    },
  });
  core.on('changed', (what) => { for (const c of clients) c.write(`data: ${JSON.stringify({ what })}\n\n`); });

  const routes = [
    ['GET', '/api/ping', () => ({ app: 'GarysTV', name: require('os').hostname(), addresses: lanAddresses() })], // TV app looks for this when searching the network
    ['GET', '/api/state', () => ({
      settings: core.settings, types: core.describeTypes(), sources: core.sources, guides: core.guides,
      channels: core.channels, guideChannels: core.guideData.channels.map(({ id, names, number, providerName }) => ({ id, names, number, providerName })),
      rules: core.rules, status: core.status(),
    })],
    ['GET', '/api/guide', (q) => core.getGuide(+q.from || Date.now(), +q.to || Date.now() + 3 * 3600000)],
    ['GET', '/api/schedule', () => core.getSchedule()],
    ['GET', '/api/recordings', () => core.getRecordings()],
    ['GET', '/api/search', (q) => core.search(q.q)],
    ['PUT', '/api/settings', (q, b) => core.updateSettings(b)],
    ['GET', '/api/discover', () => hdhomerun.discover()],
    ['POST', '/api/sources', (q, b) => core.addSource(b)],
    ['PUT', '/api/sources/:id', (q, b, p) => core.updateSource(p.id, b)],
    ['DELETE', '/api/sources/:id', (q, b, p) => core.removeSource(p.id)],
    ['POST', '/api/sources/:id/scan', (q, b, p) => core.scanSource(p.id).then((r) => ({ info: r.info }))],
    ['POST', '/api/sources/:id/antenna-scan', (q, b, p) => hdhomerun.startAntennaScan(core.sources.find((s) => s.id === p.id).config)],
    ['GET', '/api/sources/:id/antenna-scan', (q, b, p) => hdhomerun.antennaScanStatus(core.sources.find((s) => s.id === p.id).config)],
    ['PUT', '/api/channels/:id', (q, b, p) => core.updateChannel(decodeURIComponent(p.id), b)],
    ['POST', '/api/guides', (q, b) => core.addGuide(b)],
    ['PUT', '/api/guides/:id', (q, b, p) => core.updateGuide(p.id, b)],
    ['DELETE', '/api/guides/:id', (q, b, p) => core.removeGuide(p.id)],
    ['POST', '/api/guides/refresh', () => core.refreshGuides()],
    ['POST', '/api/rules', (q, b) => core.addRule(b)],
    ['PUT', '/api/rules/:id', (q, b, p) => core.updateRule(p.id, b)],
    ['DELETE', '/api/rules/:id', (q, b, p) => core.removeRule(p.id)],
    ['POST', '/api/rules/:id/move', (q, b, p) => core.moveRule(p.id, b.delta)],
    ['POST', '/api/jobs/skip', (q, b) => core.skipJob(b.id, b.skip !== false)],
    ['PUT', '/api/recordings/:id', (q, b, p) => core.patchRecording(p.id, { position: b.position, watched: b.watched })],
    ['POST', '/api/timeshift/release', (q, b) => timeshift.release(b.channelId, b.viewer)],
    ['DELETE', '/api/recordings/:id', (q, b, p) => core.deleteRecording(p.id)],
    ['POST', '/api/external-play', (q, b) => {
      const vlc = findVlc(core.settings);
      if (!vlc) throw new Error('VLC is not installed.');
      const input = playerInput(core, b.kind, b.id);
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
    const caller = checkCaller(req);
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
      const m = /^\/stream\/(live|rec)\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const input = playerInput(core, m[1], decodeURIComponent(m[2]));
        const key = input.url;
        if (input.url && /\.m3u8(\?|$)/i.test(input.url)) Object.assign(input, { url: await bestVariant(input.url), hls: true });
        return streamVideo(core, req, res, input, { live: m[1] === 'live', seek: +q.t || 0, key });
      }

      if (url.pathname.startsWith('/api/')) {
        for (const r of compiled) {
          const hit = r.method === req.method && r.re.exec(url.pathname);
          if (!hit) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, hit[i + 1]]));
          const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
          return send(res, 200, await r.fn(q, body, params));
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
      send(res, 400, { error: e.message });
    }
  });
}

module.exports = { createServer, sourceTypes };
