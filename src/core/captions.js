// Closed captions for recordings. TV channels carry captions inside the video itself
// (CEA-608/708, in MPEG-2 and H.264 picture data). Live TV keeps them in the stream and the
// player reads them there; recordings are played through a player that can't, so after a
// recording finishes ffmpeg reads its captions out into a WebVTT file the player shows
// alongside. One recording at a time; reading means decoding the whole video, so it takes
// a few minutes per hour of TV. The files are kept in .captions in this computer's
// recordings folder (named by recording id), and deleted with the recording.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// A path inside a filtergraph's movie= filter: escaped once for the option value, once for the graph.
function moviePath(file) {
  const value = String(file).replace(/\\/g, '/').replace(/([:'\\])/g, '\\$1');
  return value.replace(/([\\'[\],;])/g, '\\$1');
}

class Captions {
  // ffmpeg(): its path; dir(): where the .vtt files go; find(id): the recording
  constructor({ ffmpeg, dir, find, note = () => {} }) {
    Object.assign(this, { ffmpeg, dir, find, note });
    this.queue = [];
    this.busy = null; // recording id being read now
  }

  file(id) { return path.join(this.dir(), `${String(id).replace(/[^a-z0-9_-]/gi, '')}.vtt`); }

  // -> { status: 'ready', text } | { status: 'pending' } | { status: 'none' }
  get(id) {
    const rec = this.find(id);
    if (!rec || rec.simulated || !rec.file) return { status: 'none' };
    try { return { status: 'ready', text: fs.readFileSync(this.file(id), 'utf8') }; } catch (_) { /* not read yet */ }
    if (rec.status === 'recording' || rec.status === 'importing') return { status: 'pending' }; // read once it's finished
    this.add(id);
    return { status: 'pending' };
  }

  add(id) {
    if (this.busy === id || this.queue.includes(id)) return;
    this.queue.push(id);
    if (!this.busy) this.next();
  }

  next() {
    const id = this.queue.shift();
    this.busy = id || null;
    if (!id) return;
    const rec = this.find(id);
    const ffmpeg = this.ffmpeg();
    if (!rec || !ffmpeg || !fs.existsSync(rec.file)) { this.next(); return; }
    const out = this.file(id);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.part`;
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-f', 'lavfi', '-i', `movie=${moviePath(rec.file)}[out0+subcc]`,
      '-map', '0:s?', '-f', 'webvtt', '-y', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
    proc.on('error', () => {});
    proc.on('close', (code) => {
      try {
        if (code === 0) fs.renameSync(tmp, out);
        else { fs.rmSync(tmp, { force: true }); fs.writeFileSync(out, 'WEBVTT\n'); this.note(`captions: couldn't read them from "${rec.title}": ${err.trim().split('\n').pop()}`); }
      } catch (_) { /* tried again next time it's asked for */ }
      this.next();
    });
  }

  remove(id) { try { fs.rmSync(this.file(id), { force: true }); } catch (_) { /* gone already */ } }
}

module.exports = { Captions, moviePath };
