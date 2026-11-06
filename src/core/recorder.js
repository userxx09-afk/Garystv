// Captures a channel's stream to a .ts file until the job's end time.
// If the stream drops (antenna glitch, provider hiccup, tuner busy) it keeps
// retrying and appends to the same file, so a blip costs seconds, not the show.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { bestVariant, HLS_INPUT, RECONNECT } = require('./hls');

const RETRY_MS = 5000;
// (The abort listener is removed when the wait ends; leaving it piled one up per retry.)
const sleep = (ms, signal) => new Promise((r) => {
  const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); r(); };
  const t = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

// Node's fetch says only "fetch failed" when it can't connect at all; the reason
// (no answer, refused, name not found, certificate) is in e.cause.
function reason(e) {
  const c = e && e.cause;
  if (!c) return (e && e.message) || String(e);
  const why = {
    UND_ERR_CONNECT_TIMEOUT: 'the stream server did not answer',
    ECONNREFUSED: 'the stream server refused the connection',
    ENOTFOUND: "the stream server's name could not be found",
    EAI_AGAIN: "the stream server's name could not be looked up (no internet or DNS?)",
    ENETUNREACH: 'no network route to the stream server',
    EHOSTUNREACH: 'no network route to the stream server',
    ECONNRESET: 'the connection was cut',
  }[c.code];
  const detail = [c.code, c.message].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(': ');
  return `${e.message}: ${why ? `${why} (${detail})` : detail}`;
}

const safe = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Recording';

function recordingPath(dir, job) {
  const d = new Date(job.start);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const se = job.season != null && job.episode != null ? ` - S${String(job.season).padStart(2, '0')}E${String(job.episode).padStart(2, '0')}` : '';
  const sub = job.subtitle ? ` - ${safe(job.subtitle)}` : '';
  return path.join(dir, safe(job.title), `${safe(job.title)}${se}${sub} (${stamp}).ts`);
}

// One attempt to copy the stream into `out`. Resolves when the stream ends or is aborted.
async function copyOnce(url, out, signal, ffmpeg) {
  if (/\.m3u8(\?|$)/i.test(url)) {
    if (!ffmpeg) throw new Error('This IPTV channel uses HLS; install ffmpeg to record it.');
    // One quality only (the best), and just picture + sound.
    const src = await bestVariant(url);
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...HLS_INPUT, ...RECONNECT, '-i', src, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    signal.addEventListener('abort', () => proc.kill(), { once: true });
    await pipeline(proc.stdout, out, { end: false }).catch(() => {});
    if (!signal.aborted && err) throw new Error(err.trim().split('\n').pop());
    return;
  }
  const res = await fetch(url, { signal });
  if (res.status === 503) throw new Error('All tuners are busy');
  if (!res.ok) throw new Error(`Stream returned ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), out, { end: false, signal });
}

// Returns { stop(), done: Promise<{ status, error }> }. onProgress(bytes) is called as data arrives.
function startRecording({ url, file, until, ffmpeg, simulated, onProgress, log = () => {} }) {
  const ac = new AbortController();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file, { flags: 'a' });
  let bytes = 0;
  const origWrite = out.write.bind(out);
  out.write = (chunk, ...rest) => { bytes += chunk.length; onProgress && onProgress(bytes); return origWrite(chunk, ...rest); };

  const done = (async () => {
    let lastError = null;
    let lastLogged = null;
    let gaps = 0;
    const timer = setTimeout(() => ac.abort(), Math.max(0, until - Date.now()));
    try {
      if (simulated) {
        out.write(Buffer.from('GarysTV practice recording - no real video.\n'));
        await sleep(until - Date.now(), ac.signal);
      } else {
        while (!ac.signal.aborted && Date.now() < until) {
          try {
            await copyOnce(url, out, ac.signal, ffmpeg);
            if (!ac.signal.aborted) { gaps++; log(`stream ended early, reconnecting`); }
          } catch (e) {
            if (ac.signal.aborted) break;
            const msg = reason(e);
            lastError = /terminated|ECONNRESET|socket/i.test(e.message) ? 'signal lost' : msg;
            gaps++;
            // The same error every few seconds for a whole show is logged once, then each time it changes.
            if (msg !== lastLogged) log(`recording error: ${msg}; retrying`);
            lastLogged = msg;
          }
          if (!ac.signal.aborted) await sleep(RETRY_MS, ac.signal);
        }
      }
    } finally {
      clearTimeout(timer);
      await new Promise((r) => out.end(r));
    }
    if (bytes === 0) return { status: 'failed', error: lastError || 'No video was received' };
    return { status: gaps > 0 ? 'partial' : 'complete', error: gaps > 0 ? `${gaps} interruption(s)${lastError ? `: ${lastError}` : ''}` : null };
  })();

  return { stop: () => ac.abort(), done, get bytes() { return bytes; } };
}

// A quick look at a stream a few minutes before a timer starts: does it answer with video?
// Resolves { ok: true } or { ok: false, error }. Only the first bytes are read, then it lets go.
async function probeStream(url, timeoutMs = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.status === 503) return { ok: false, error: 'All tuners are busy' };
    if (!res.ok) return { ok: false, error: `Stream returned ${res.status}` };
    if (/\.m3u8(\?|$)/i.test(url)) {
      const text = await res.text();
      return /#EXTM3U/.test(text) ? { ok: true } : { ok: false, error: 'Stream did not send a playlist' };
    }
    const r = res.body.getReader();
    const { value } = await r.read();
    return value && value.length ? { ok: true } : { ok: false, error: 'Stream sent no video' };
  } catch (e) {
    return { ok: false, error: ac.signal.aborted && !e.cause ? `the stream did not answer within ${timeoutMs / 1000}s` : reason(e) };
  } finally {
    clearTimeout(t);
    ac.abort();
  }
}

module.exports = { startRecording, recordingPath, probeStream, reason };
