// Adding your own videos to My Recordings: a DVD in this computer's drive, a video file on
// this computer (or a folder of them), or one sent from a browser (My Recordings >
// Add a video or DVD). Each is converted to one standard file (H.264 video, AAC stereo sound,
// MP4) in the recordings folder, one at a time, at low priority, and listed like a recording.
//
// DVDs: the main title is the largest set of VTS_nn_1..n.VOB files in VIDEO_TS. Home-made and
// other unprotected discs work; copy-protected (CSS) discs aren't supported.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { findFfmpeg } = require('./tools');

const VIDEO_EXT = /\.(mp4|m4v|mkv|avi|mov|wmv|mpg|mpeg|ts|m2ts|mts|vob|webm|flv|3gp|dv|divx|ogv)$/i;
const safe = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Video';
const newId = () => crypto.randomBytes(5).toString('hex');

// "MY_HOME_VIDEOS_2004" / "my.home.video.mkv" -> "My Home Videos 2004" / "My Home Video"
function niceTitle(name) {
  const base = String(name || '').replace(VIDEO_EXT, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return 'Video';
  return base === base.toUpperCase() || base === base.toLowerCase()
    ? base.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
    : base;
}

// A VIDEO_TS folder -> the main title's VOB files, in order (or null).
function dvdTitle(videoTs) {
  let names;
  try { names = fs.readdirSync(videoTs); } catch (_) { return null; }
  const sets = new Map();
  for (const n of names) {
    const m = /^VTS_(\d\d)_([1-9]\d*)\.VOB$/i.exec(n); // _0 is the title's menu
    if (!m) continue;
    const size = (() => { try { return fs.statSync(path.join(videoTs, n)).size; } catch (_) { return 0; } })();
    if (!sets.has(m[1])) sets.set(m[1], { files: [], size: 0 });
    const s = sets.get(m[1]);
    s.files.push({ file: path.join(videoTs, n), part: +m[2], size });
    s.size += size;
  }
  const best = [...sets.values()].sort((a, b) => b.size - a.size)[0];
  if (!best || !best.size) return null;
  return { files: best.files.sort((a, b) => a.part - b.part).map((f) => f.file), size: best.size };
}

// The VIDEO_TS folder for a path that's a disc, its VIDEO_TS folder, or a copy of one.
function videoTsOf(p) {
  if (/^VIDEO_TS$/i.test(path.basename(p))) return p;
  for (const n of ['VIDEO_TS', 'video_ts']) {
    const d = path.join(p, n);
    try { if (fs.statSync(d).isDirectory()) return d; } catch (_) { /* not there */ }
  }
  return null;
}

// DVDs in this computer's drives (or mounted on the home server): [{ path, label }].
async function findDvds() {
  const roots = [];
  if (process.platform === 'win32') {
    for (const l of 'DEFGHIJKLMNOPQRSTUVWXYZ') roots.push(`${l}:\\`);
  } else {
    for (const base of ['/media', '/run/media', '/mnt']) {
      for (const a of ls(base)) { roots.push(path.join(base, a)); for (const b of ls(path.join(base, a))) roots.push(path.join(base, a, b)); }
    }
  }
  const found = [];
  for (const r of roots) {
    const vts = videoTsOf(r);
    if (!vts || !dvdTitle(vts)) continue;
    found.push({ path: r, label: niceTitle(await volumeLabel(r)) });
  }
  return found;
}
function ls(d) { try { return fs.readdirSync(d).filter((n) => !n.startsWith('.')); } catch (_) { return []; } }
function volumeLabel(root) {
  if (process.platform !== 'win32') return Promise.resolve(path.basename(root));
  return new Promise((resolve) => execFile('cmd.exe', ['/c', 'vol', root.slice(0, 2)], { timeout: 4000, windowsHide: true }, (err, out) => {
    const m = /drive \w is (.+)/i.exec(String(out || ''));
    resolve(m ? m[1].trim() : `DVD ${root.slice(0, 2)}`);
  }));
}

function ffprobeFor(ffmpeg) {
  const p = ffmpeg && path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
  return p && fs.existsSync(p) ? p : null;
}
// -> { duration (s), video: { codec, pixFmt }, audio: { codec } } or null
function probe(ffmpeg, file) {
  const p = ffprobeFor(ffmpeg);
  if (!p) return Promise.resolve(null);
  return new Promise((resolve) => execFile(p, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,pix_fmt', '-of', 'json', file],
    { timeout: 30000, windowsHide: true, maxBuffer: 4e6 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s) => s.codec_type === 'video');
        const a = (j.streams || []).find((s) => s.codec_type === 'audio');
        resolve({ duration: +((j.format || {}).duration) || 0, video: v ? { codec: v.codec_name, pixFmt: v.pix_fmt } : null, audio: a ? { codec: a.codec_name } : null });
      } catch (_) { resolve(null); }
    }));
}

// The ffmpeg command for one conversion. input: a file path, or 'pipe:0' for a DVD's VOBs fed in.
// H.264 (8-bit) video is kept as it is; anything else is converted. Interlaced video (DVDs, camcorders)
// is deinterlaced, and stretched DVD pictures are made square-pixel so every player shows them right.
function convertArgs({ input, dvd, info, out }) {
  const copyVideo = !dvd && info && info.video && info.video.codec === 'h264' && /^yuv(j)?420p$/.test(info.video.pixFmt || '');
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y',
    ...(dvd ? ['-f', 'mpeg', '-probesize', '50M', '-analyzeduration', '30M'] : []),
    '-fflags', '+genpts', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1',
    ...(copyVideo ? ['-c:v', 'copy'] : ['-vf', 'yadif=deint=interlaced,scale=trunc(ih*dar/2)*2:ih,setsar=1,scale=-2:min(ih\\,1080)',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p', '-profile:v', 'high']),
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-movflags', '+faststart', '-f', 'mp4', out,
  ];
}

class Importer {
  constructor(core) {
    this.core = core;
    this.queue = []; // rec ids waiting
    this.busy = null; // { id, proc, feed }
  }

  get tmpDir() { return path.join(this.core.storage.localDir, '.import'); }

  async overview() {
    return { ffmpeg: !!findFfmpeg(this.core.settings), dvds: await findDvds(), working: this.busy ? this.busy.id : null, waiting: this.queue.length, platform: process.platform };
  }

  // { path, title } from My Recordings: a DVD, a video file, or a folder of video files.
  async addPath({ path: p, title }) {
    p = String(p || '').trim().replace(/^"(.*)"$/, '$1');
    if (!p) throw new Error('Choose a DVD, or type where the video is.');
    let st;
    try { st = fs.statSync(p); } catch (_) { throw new Error(`Nothing found at ${p}.`); }
    if (st.isDirectory()) {
      const vts = videoTsOf(p);
      if (vts) {
        const t = dvdTitle(vts);
        if (!t) throw new Error('That DVD has no video on it.');
        return [this.add({ source: { dvd: t.files, size: t.size }, title: title || niceTitle(await volumeLabel(p)), kind: 'dvd' })];
      }
      const files = ls(p).filter((n) => VIDEO_EXT.test(n)).map((n) => path.join(p, n)).filter((f) => fs.statSync(f).isFile());
      if (!files.length) throw new Error('No video files in that folder.');
      return files.map((f) => this.add({ source: { file: f }, title: files.length === 1 && title ? title : niceTitle(path.basename(f)), kind: 'file' }));
    }
    if (!VIDEO_EXT.test(p)) throw new Error("That doesn't look like a video file.");
    return [this.add({ source: { file: p }, title: title || niceTitle(path.basename(p)), kind: 'file' })];
  }

  // A video sent from a browser: saved to a temporary file, then converted (and the copy removed).
  async addUpload(req, name, title) {
    name = path.basename(String(name || ''));
    if (!VIDEO_EXT.test(name)) throw new Error("That doesn't look like a video file.");
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const tmp = path.join(this.tmpDir, `${newId()}-${safe(name)}`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.pipe(out);
      req.on('aborted', () => { out.destroy(); reject(new Error('The upload was cut off.')); });
      out.on('finish', resolve);
      out.on('error', reject);
    }).catch((e) => { try { fs.unlinkSync(tmp); } catch (_) {} throw e; });
    return [this.add({ source: { file: tmp, temp: true }, title: title || niceTitle(name), kind: 'file' })];
  }

  add({ source, title, kind }) {
    const now = Date.now();
    title = safe(title);
    const dir = path.join(this.core.storage.recordDir(), title);
    let file = path.join(dir, `${title}.mp4`);
    for (let i = 2; fs.existsSync(file) || this.core.recordings.some((r) => r.file === file); i++) file = path.join(dir, `${title} (${i}).mp4`);
    const rec = {
      id: newId(), imported: kind, source, title, subtitle: '', desc: '', channelNumber: '', channelName: kind === 'dvd' ? 'DVD' : 'Video file',
      start: now, end: now, recordedAt: now, file, size: 0, status: 'importing', progress: 0, error: null, position: 0, watched: false, commercials: [],
    };
    this.core.store.write('recordings', [rec, ...this.core.recordings]);
    this.core.note(`importing ${kind === 'dvd' ? 'a DVD' : 'a video'}: ${title}`);
    this.core.changed('recordings');
    this.queue.push(rec.id);
    this.next();
    return { id: rec.id, title };
  }

  // At startup: imports the app was closed during start again (if what they came from is still there).
  resume() {
    for (const r of this.core.recordings.filter((x) => x.status === 'importing')) {
      const there = r.source && (r.source.dvd ? r.source.dvd.every((f) => fs.existsSync(f)) : fs.existsSync(r.source.file));
      if (there) { this.core.patchRecording(r.id, { progress: 0 }); this.queue.push(r.id); } else this.core.patchRecording(r.id, { status: 'failed', error: 'The app was closed while this was being added, and the video is no longer there.' });
    }
    this.next();
  }

  async next() {
    if (this.busy) return;
    const id = this.queue.shift();
    if (!id) return;
    const rec = this.core.recordings.find((r) => r.id === id);
    if (!rec) return this.next();
    this.busy = { id };
    try {
      await this.convert(rec);
    } catch (e) {
      try { fs.unlinkSync(`${rec.file}.part`); } catch (_) {}
      if (this.core.recordings.some((r) => r.id === id) && !(this.busy && this.busy.cancelled)) {
        this.core.patchRecording(id, { status: 'failed', error: e.message, progress: null });
        this.core.note(`import failed: ${rec.title}: ${e.message}`);
      }
    }
    this.busy = null;
    this.next();
  }

  async convert(rec) {
    const ffmpeg = findFfmpeg(this.core.settings);
    if (!ffmpeg) throw new Error('ffmpeg is not installed (Settings > Status), so videos can\'t be converted.');
    const dvd = !!rec.source.dvd;
    const info = dvd ? null : await probe(ffmpeg, rec.source.file);
    if (!dvd && info && !info.video) throw new Error('That file has no video in it.');
    fs.mkdirSync(path.dirname(rec.file), { recursive: true });
    const part = `${rec.file}.part`;
    const proc = spawn(ffmpeg, convertArgs({ input: dvd ? 'pipe:0' : rec.source.file, dvd, info, out: part }), { stdio: [dvd ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    this.busy.proc = proc;
    try { os.setPriority(proc.pid, 10); } catch (_) { /* fine at normal priority */ }
    let err = '';
    let fed = 0;
    let lastPct = -1;
    let lastPatch = 0;
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const report = (pct) => {
      pct = Math.max(0, Math.min(99, Math.floor(pct)));
      if (pct === lastPct || Date.now() - lastPatch < 3000) return;
      lastPct = pct; lastPatch = Date.now();
      this.core.patchRecording(rec.id, { progress: pct });
    };
    proc.stdout.on('data', (d) => {
      if (dvd) return report((fed / rec.source.size) * 100);
      const m = /out_time_us=(\d+)/.exec(String(d));
      if (m && info && info.duration) report((+m[1] / 1e6 / info.duration) * 100);
    });
    if (dvd) {
      // The title's VOB files one after another, as one stream (the way the DVD player sees them).
      (async () => {
        for (const f of rec.source.dvd) {
          for await (const chunk of fs.createReadStream(f, { highWaterMark: 1 << 20 })) {
            fed += chunk.length;
            if (!proc.stdin.write(chunk)) await new Promise((r) => proc.stdin.once('drain', r));
            if (proc.exitCode != null || proc.killed) return;
          }
        }
        proc.stdin.end();
      })().catch(() => { try { proc.stdin.destroy(); } catch (_) {} });
      proc.stdin.on('error', () => { /* ffmpeg stopped early: its exit says why */ });
    }
    const code = await new Promise((resolve) => proc.on('close', resolve));
    if (this.busy && this.busy.cancelled) throw new Error('cancelled');
    if (code !== 0) throw new Error((err.trim().split('\n').pop() || `ffmpeg stopped (${code})`).slice(0, 300));
    fs.renameSync(part, rec.file);
    const done = await probe(ffmpeg, rec.file);
    const ms = Math.round(((done && done.duration) || (info && info.duration) || 0) * 1000);
    const size = fs.statSync(rec.file).size;
    if (rec.source.temp) { try { fs.unlinkSync(rec.source.file); } catch (_) {} }
    const now = Date.now();
    // The player reads the length as finishedAt - recordedAt, as for a recording.
    this.core.patchRecording(rec.id, { status: 'complete', progress: null, size, recordedAt: now, finishedAt: now + ms, start: now, end: now + ms, source: rec.source.temp ? null : rec.source });
    this.core.note(`import finished: ${rec.title} (${Math.round(ms / 60000)} min, ${(size / 1e9).toFixed(1)} GB)`);
  }

  // Deleting one that's waiting or being converted.
  async cancel(id) {
    this.queue = this.queue.filter((x) => x !== id);
    const rec = this.core.recordings.find((r) => r.id === id);
    if (rec && rec.source && rec.source.temp) { try { fs.unlinkSync(rec.source.file); } catch (_) {} }
    if (!this.busy || this.busy.id !== id) return;
    this.busy.cancelled = true;
    const proc = this.busy.proc;
    if (proc && proc.exitCode == null) {
      await new Promise((r) => { proc.once('close', r); proc.kill(); });
    }
    if (rec) { try { fs.unlinkSync(`${rec.file}.part`); } catch (_) {} }
  }

  stop() { this.queue = []; if (this.busy && this.busy.proc) { this.busy.cancelled = true; this.busy.proc.kill(); } }
}

module.exports = { Importer, convertArgs, dvdTitle, videoTsOf, niceTitle, VIDEO_EXT };
