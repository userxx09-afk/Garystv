// Playback health: when live TV stutters, says why.
//
// Two halves are put together:
//  - what the engine sees of each channel's stream (timeshift.js): whether ffmpeg keeps up with
//    real time, how often the source drops, how busy this computer's processor is
//  - what each TV sees while playing (player.js reports every 15s): stutters, how long video pieces
//    take to download, dropped frames, player errors
// and each viewing gets a verdict: played smoothly, or the cause was the channel's own stream,
// this computer, the network to the TV, or the player/TV itself (something to fix in GarysTV).
const os = require('os');

const WINDOW_MS = 10000; // keeping-up is measured over 10-second windows
const BEHIND = 0.9; // a window that got less than 90% of real time's worth of video fell behind
const BUSY_CPU = 85; // above this (% of the whole processor), falling behind is this computer's fault
const KEEP_MS = 4 * 3600e3; // stream history kept per channel
const IDLE_MS = 60000; // a TV that stopped reporting for this long has stopped watching
const KEEP_SESSIONS = 100;

// ffmpeg errors that mean the source (provider, station, antenna) let us down rather than GarysTV.
const SOURCE_ERR = /connection|timed? ?out|refused|reset|broken pipe|end of file|\beof\b|i\/o error|server returned|http error|\b[45]\d\d\b|unreachable|network|resolv|no such host|forbidden|not found|invalid data|error while decoding|corrupt|non-existing pps|missing picture|stream ended|no video from/i;
const classifyError = (msg) => (!msg || SOURCE_ERR.test(msg) ? 'source' : 'internal');

function cpuTimes() {
  return os.cpus().reduce((a, c) => {
    const t = c.times;
    a.idle += t.idle;
    a.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return a;
  }, { idle: 0, total: 0 });
}

// What the engine saw of a channel's stream between two times.
function serverEvidence(ch, from, to) {
  const ev = { drops: 0, sourceDrops: 0, internalDrops: 0, reasons: [], behindSource: 0, behindServer: 0, windows: 0, transcoding: false, encoder: null, cpuMax: 0 };
  if (!ch) return ev;
  ev.transcoding = !ch.copy;
  ev.encoder = ch.encoder;
  for (const w of ch.windows) {
    if (w.t < from || w.t > to) continue;
    ev.windows++;
    ev.cpuMax = Math.max(ev.cpuMax, w.cpu);
    if (w.ratio >= BEHIND) continue;
    // Passing the video straight through costs next to nothing, so falling behind then is the source.
    if (!w.copy && w.cpu >= BUSY_CPU) ev.behindServer++; else ev.behindSource++;
  }
  for (const d of ch.drops) {
    if (d.t < from || d.t > to) continue;
    ev.drops++;
    if (d.kind === 'internal') ev.internalDrops++; else ev.sourceDrops++;
    if (d.reason && !ev.reasons.includes(d.reason) && ev.reasons.length < 3) ev.reasons.push(d.reason);
  }
  return ev;
}

// srv: serverEvidence(); cli: the TV's totals (player.js). -> { level: ok|minor|problem, cause, headline, detail, evidence[] }
function verdict(srv, cli, host = 'the GarysTV computer') {
  const evidence = [];
  const stalls = cli.stalls || 0;
  const dropRate = cli.frames > 300 ? (cli.dropped || 0) / cli.frames : 0;
  if (stalls) evidence.push(`${stalls} stutter${stalls > 1 ? 's' : ''} on the TV (${Math.round((cli.stallMs || 0) / 1000)}s frozen in all)`);
  if (srv.sourceDrops) evidence.push(`the channel's stream dropped ${srv.sourceDrops}× and was reconnected${srv.reasons.length ? ` (${srv.reasons.join('; ')})` : ''}`);
  if (srv.internalDrops) evidence.push(`GarysTV's converter stopped ${srv.internalDrops}× by itself${srv.reasons.length ? ` (${srv.reasons.join('; ')})` : ''}`);
  if (srv.behindSource) evidence.push(`the stream arrived slower than real time for ${srv.behindSource * 10}s`);
  if (srv.behindServer) evidence.push(`${host} fell behind converting the video for ${srv.behindServer * 10}s (processor at ${Math.round(srv.cpuMax)}%)`);
  if (cli.slowFrags) evidence.push(`${cli.slowFrags} of ${cli.fragLoads} video pieces were slow to reach the TV${cli.kbpsMin ? ` (slowest ${(cli.kbpsMin / 1000).toFixed(1)} Mbit/s)` : ''}`);
  if (cli.fragErrors) evidence.push(`${cli.fragErrors} video piece${cli.fragErrors > 1 ? 's' : ''} failed to download to the TV`);
  if (cli.stallsWithBuffer) evidence.push(`${cli.stallsWithBuffer} stutter${cli.stallsWithBuffer > 1 ? 's' : ''} happened with video already waiting on the TV`);
  if (cli.mediaErrors) evidence.push(`the TV's video decoder reported ${cli.mediaErrors} error${cli.mediaErrors > 1 ? 's' : ''}`);
  if (dropRate >= 0.02) evidence.push(`the TV dropped ${Math.round(dropRate * 100)}% of frames`);
  if (cli.appErrors) evidence.push(`${cli.appErrors} error${cli.appErrors > 1 ? 's' : ''} in GarysTV's screens`);

  // Points for each cause. Stutters with nothing waiting on the TV mean video didn't arrive in
  // time: blamed on whatever upstream also misbehaved.
  const emptyStalls = Math.max(0, stalls - (cli.stallsWithBuffer || 0));
  const score = {
    source: srv.sourceDrops * 3 + srv.behindSource,
    server: srv.behindServer + srv.internalDrops * 3,
    network: (cli.fragErrors || 0) * 2 + (cli.slowFrags || 0),
    player: (cli.stallsWithBuffer || 0) * 3 + (cli.mediaErrors || 0) * 2 + (dropRate >= 0.05 ? 4 : dropRate >= 0.02 ? 2 : 0) + (cli.appErrors || 0),
  };
  if (emptyStalls) {
    const up = ['source', 'server', 'network'].filter((k) => score[k] > 0);
    if (up.length) for (const k of up) score[k] += emptyStalls; else score.unclear = emptyStalls;
  }
  const [cause, points] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  if (!points && !stalls) return { level: 'ok', cause: 'none', headline: 'Played smoothly', detail: '', evidence };
  const level = stalls >= 3 || (cli.stallMs || 0) > 10000 || points >= 6 ? 'problem' : 'minor';
  const say = {
    source: ['Poor stream from the channel', 'The channel\'s own stream dropped out or came in slower than real time. Not a GarysTV problem: try again later, another channel, or another provider for it.'],
    server: [`${host} couldn't keep up`, `${host} was too busy to convert the video in real time. Close other programs there, or record fewer channels at once while watching.`],
    network: ['Weak network to this TV', `The video was ready on ${host} but took too long to reach the TV. Check the TV's Wi-Fi signal, move the router closer, or use a wired connection.`],
    player: ['Problem inside GarysTV or the TV', 'The TV had video ready and the stream was fine, but playback still stuttered. This points at GarysTV\'s player or the TV itself: worth reporting.'],
    unclear: ['Stuttered, cause unclear', 'The TV ran out of video, but the stream, the computer and the network all looked fine. If it keeps happening, report it.'],
  }[cause];
  return { level, cause, headline: say[0], detail: say[1], evidence };
}

class Diagnostics {
  constructor(core) {
    this.core = core;
    this.channels = new Map(); // channelId -> { copy, encoder, sample, win, windows[], drops[], lastProgress, running }
    this.sessions = new Map(); // sid -> a TV's viewing (see report)
    this.cpu = 0;
    this.lastCpu = cpuTimes();
    this.timer = setInterval(() => this.tick(), 5000);
    if (this.timer.unref) this.timer.unref();
  }

  get host() { return os.hostname(); }

  tick() {
    const now = cpuTimes();
    const total = now.total - this.lastCpu.total;
    if (total > 0) this.cpu = Math.max(0, Math.min(100, 100 * (1 - (now.idle - this.lastCpu.idle) / total)));
    this.lastCpu = now;
    const t = Date.now();
    for (const [id, ch] of this.channels) {
      // ffmpeg running but nothing coming out: the source has gone quiet.
      if (ch.running && ch.lastProgress && t - ch.lastProgress > WINDOW_MS) {
        ch.windows.push({ t, ratio: 0, cpu: this.cpu, copy: ch.copy });
        ch.lastProgress = t;
        ch.win = null;
      }
      ch.windows = ch.windows.filter((w) => t - w.t < KEEP_MS);
      ch.drops = ch.drops.filter((d) => t - d.t < KEEP_MS);
      if (!ch.running && !ch.windows.length && !ch.drops.length) this.channels.delete(id);
    }
    for (const [sid, s] of this.sessions) if (t - s.last > IDLE_MS) this.finish(sid);
  }

  channel(id) {
    let ch = this.channels.get(id);
    if (!ch) this.channels.set(id, ch = { copy: false, encoder: null, win: null, windows: [], drops: [], lastProgress: 0, running: false });
    return ch;
  }

  // ---- from the live buffer (timeshift.js) ----
  bufferStarted(channelId, args) {
    const ch = this.channel(channelId);
    const v = args.indexOf('-c:v');
    ch.encoder = v >= 0 ? args[v + 1] : null;
    ch.copy = ch.encoder === 'copy';
    ch.running = true;
    ch.win = null;
    ch.lastProgress = Date.now();
  }

  // ffmpeg's -progress: how much video it has written (microseconds) by now.
  progress(channelId, outUs) {
    const ch = this.channel(channelId);
    const t = Date.now();
    ch.lastProgress = t;
    if (!ch.win || outUs < ch.win.out) { ch.win = { t, out: outUs }; return; }
    if (t - ch.win.t < WINDOW_MS) return;
    const ratio = (outUs - ch.win.out) / 1000 / (t - ch.win.t);
    ch.windows.push({ t, ratio, cpu: this.cpu, copy: ch.copy });
    ch.win = { t, out: outUs };
  }

  bufferExited(channelId, err) {
    const ch = this.channel(channelId);
    ch.drops.push({ t: Date.now(), kind: classifyError(err), reason: err ? String(err).slice(0, 120) : 'stream ended' });
    ch.win = null;
  }

  bufferStopped(channelId) {
    const ch = this.channels.get(channelId);
    if (ch) { ch.running = false; ch.win = null; }
  }

  // ---- from the TVs (player.js) ----
  // body: { sid, device, kind, channelId, name, started, final, stalls, stallMs, ... }. -> the verdict so far.
  report(body, ip) {
    if (!body || typeof body.sid !== 'string' || !/^[a-z0-9]{4,20}$/.test(body.sid)) throw Object.assign(new Error('Bad report'), { status: 400 });
    const num = (k) => (Number.isFinite(+body[k]) ? Math.max(0, +body[k]) : 0);
    const cli = {};
    for (const k of ['stalls', 'stallMs', 'stallsWithBuffer', 'fragLoads', 'slowFrags', 'fragErrors', 'mediaErrors', 'fatal', 'dropped', 'frames', 'kbpsMin', 'appErrors', 'watchMs']) cli[k] = num(k);
    let s = this.sessions.get(body.sid);
    if (!s) {
      const started = Math.min(Date.now(), num('started') || Date.now());
      s = { sid: body.sid, started, device: String(body.device || 'TV').slice(0, 60), ip: String(ip || '').replace(/^::ffff:/, ''),
        kind: ['live', 'rec', 'vod'].includes(body.kind) ? body.kind : 'live', channelId: String(body.channelId || '').slice(0, 200), name: String(body.name || '').slice(0, 100) };
      this.sessions.set(s.sid, s);
    }
    s.last = Date.now();
    s.cli = cli;
    s.result = this.judge(s);
    if (body.final) this.finish(s.sid);
    return s.result;
  }

  judge(s) {
    const srv = s.kind === 'live' ? serverEvidence(this.channels.get(s.channelId), s.started, s.last) : serverEvidence(null);
    return { ...verdict(srv, s.cli, this.host), server: srv };
  }

  finish(sid) {
    const s = this.sessions.get(sid);
    if (!s) return;
    this.sessions.delete(sid);
    const r = s.result || this.judge(s);
    const mins = (s.last - s.started) / 60000;
    if (mins < 0.33 && r.level === 'ok') return; // flipping through channels
    const done = { device: s.device, ip: s.ip, kind: s.kind, name: s.name, started: s.started, ended: s.last, level: r.level, cause: r.cause, headline: r.headline, detail: r.detail, evidence: r.evidence };
    const list = [done, ...this.core.store.read('playback', [])].slice(0, KEEP_SESSIONS);
    this.core.store.writeSoon('playback', list).catch(() => {});
    const icon = { ok: '✅', minor: '⚠️', problem: '❌' }[r.level];
    this.core.note(`playback ${icon} ${s.device}: ${s.name || s.channelId} for ${mins < 1 ? `${Math.round(mins * 60)}s` : `${Math.round(mins)} min`}: ${r.headline}${r.evidence.length ? ` (${r.evidence.join('; ')})` : ''}`);
  }

  // GET /api/diag: right now, and the recent viewings.
  overview() {
    const t = Date.now();
    const live = [];
    for (const [id, ch] of this.channels) {
      if (!ch.running) continue;
      const recent = ch.windows.filter((w) => t - w.t < 60000);
      const ratio = recent.length ? recent.reduce((a, w) => a + w.ratio, 0) / recent.length : null;
      const c = this.core.channels.find((x) => x.id === id);
      live.push({ channelId: id, name: c ? [c.number, c.name].filter(Boolean).join(' ') : id, encoder: ch.encoder, transcoding: !ch.copy, keepingUp: ratio, dropsLastHour: ch.drops.filter((d) => t - d.t < 3600e3).length });
    }
    const watching = [...this.sessions.values()].map((s) => ({ device: s.device, ip: s.ip, kind: s.kind, name: s.name, started: s.started, ...s.result }));
    return { host: this.host, cpu: Math.round(this.cpu), cores: os.cpus().length, live, watching, recent: this.core.store.read('playback', []) };
  }

  stop() {
    clearInterval(this.timer);
    for (const sid of [...this.sessions.keys()]) this.finish(sid);
  }
}

module.exports = { Diagnostics, verdict, serverEvidence, classifyError };
