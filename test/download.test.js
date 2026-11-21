// Download (Movies, Shows, the Guide): the provider's video saved into My Recordings (importer.js),
// on a free stream only, giving way to anyone who wants to watch (tuners.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { Importer } = require('../src/core/importer');
const { Tuners } = require('../src/core/tuners');
const { findFfmpeg } = require('../src/core/tools');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-dl-'));
const ffmpeg = findFfmpeg();

// Just enough of the engine: one IPTV plan with one stream, and a movie at `url`.
function fakeCore(dir, url) {
  let recs = [];
  const core = {
    settings: {}, notes: [], inputs: 0,
    sources: [{ id: 'src1', type: 'xtream', name: 'Plan', enabled: true, config: { servers: 'http://p', username: 'u' } }],
    channels: [{ id: 'src1:5', sourceId: 'src1', name: 'News', streamUrl: 'http://p/live/5' }],
    get recordings() { return recs; },
    store: { write: (k, v) => { if (k === 'recordings') recs = v; } },
    storage: { recordDir: () => dir, localDir: dir },
    note: (m) => core.notes.push(m), changed: () => {}, emit: () => {},
    patchRecording: (id, p) => { recs = recs.map((r) => (r.id === id ? { ...r, ...p } : r)); },
    vod: {
      provider: (id) => { if (id !== 'src1') throw new Error('That IPTV provider is no longer set up.'); return core.sources[0]; },
      input: async () => { core.inputs++; return { url, title: '' }; },
    },
  };
  core.tuners = new Tuners(core);
  return core;
}
const rec = (core, id) => core.recordings.find((x) => x.id === id);
const until = async (fn, ms = 60000) => {
  for (let t = 0; t < ms; t += 100) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('timed out');
};

test('a download only takes a free stream; watching takes it back, a recording too', () => {
  const core = fakeCore(tmp(), 'http://x');
  const t = core.tuners;
  let bumped = 0;
  const dl = t.acquireDownload('src1', 'The Movie', () => bumped++);
  assert.throws(() => t.acquireDownload('src1', 'Another'), /in use.*downloading The Movie/);
  // Watching a channel on the same plan: the download lets go.
  const live = t.acquire('src1:5', 'live', 'News');
  assert.strictEqual(bumped, 1);
  assert.ok(!t.uses.has(dl.id));
  assert.throws(() => t.acquireDownload('src1', 'The Movie'), /in use/); // waits while someone watches
  t.release(live.id);
  // A movie too.
  t.acquireDownload('src1', 'The Movie', () => bumped++);
  t.acquireSource('src1', 'a movie');
  assert.strictEqual(bumped, 2);
  assert.match(t.overview()[0].using[0], /^Watching/);
});

test('only movies, episodes and archived shows can be downloaded, once each', () => {
  const core = fakeCore(tmp(), 'http://x');
  const imp = new Importer(core);
  imp.next = () => {}; // don't start it
  assert.throws(() => imp.addDownload('s~src1~9', { title: 'A show' }), /Only a movie/);
  assert.throws(() => imp.addDownload('m~gone~1~mp4', { title: 'X' }), /no longer set up/);
  const a = imp.addDownload('e~src1~77~mkv', { title: 'Some Show', subtitle: 'Pilot', season: 1, episode: 2, poster: 'http://p/i.jpg' });
  const r = rec(core, a.id);
  assert.strictEqual(path.basename(r.file), 'Some Show - S01E02.mp4');
  assert.strictEqual(path.basename(path.dirname(r.file)), 'Some Show'); // one folder per show in My Recordings
  assert.deepStrictEqual([r.imported, r.channelName, r.subtitle, r.season, r.episode, r.source.vod], ['download', 'Download', 'Pilot', 1, 2, 'e~src1~77~mkv']);
  assert.ok(!JSON.stringify(r).includes('password'));
  const again = imp.addDownload('e~src1~77~mkv', { title: 'Some Show' });
  assert.ok(again.already);
  assert.strictEqual(core.recordings.length, 1);
  const m = imp.addDownload('m~src1~5~mp4', { title: 'Big Movie', year: '1999' });
  assert.strictEqual(path.basename(rec(core, m.id).file), 'Big Movie (1999).mp4');
});

test('a movie downloads into My Recordings, waiting for the stream and starting again after giving it up', { skip: !ffmpeg && 'ffmpeg not installed', timeout: 120000 }, async () => {
  const src = tmp(), out = tmp();
  const movie = path.join(src, 'movie.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', movie]);
  // The "provider": sends the movie slowly, so the download is still going when someone starts watching.
  const data = fs.readFileSync(movie);
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const from = m ? +m[1] : 0, to = m && m[2] ? +m[2] + 1 : data.length;
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': to - from, 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${from}-${to - 1}/${data.length}` } : {}) });
    let i = from;
    const tick = setInterval(() => { if (i >= to) { clearInterval(tick); res.end(); return; } res.write(data.subarray(i, i = Math.min(to, i + 16384))); }, 20);
    req.on('close', () => clearInterval(tick));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const core = fakeCore(out, `http://127.0.0.1:${server.address().port}/movie/u/p/5.mp4`);
    const imp = new Importer(core);
    const watching = core.tuners.acquire('src1:5', 'live', 'News'); // the plan's one stream is in use
    imp.pause = (ms) => new Promise((r) => setTimeout(r, 200)); // don't wait a minute in a test
    const { id } = imp.addDownload('m~src1~5~mp4', { title: 'Test Movie', duration: 6 });
    await until(() => (rec(core, id).waiting || '').startsWith('Waiting for a free stream'));
    assert.strictEqual(core.inputs, 0);
    core.tuners.release(watching.id);
    await until(() => core.inputs === 1 && [...core.tuners.uses.values()].some((u) => u.kind === 'dl'));
    await new Promise((r) => setTimeout(r, 300));
    const again = core.tuners.acquire('src1:5', 'live', 'News'); // someone sits down to watch: it gives way
    await until(() => /Paused/.test(rec(core, id).waiting || ''));
    core.tuners.release(again.id);
    const r = await until(() => rec(core, id).status !== 'importing' && rec(core, id));
    assert.strictEqual(r.status, 'complete', r.error);
    assert.ok(core.inputs >= 2, 'started again');
    assert.ok(fs.existsSync(r.file) && !fs.existsSync(`${r.file}.part`));
    const secs = (r.finishedAt - r.recordedAt) / 1000;
    assert.ok(secs > 5 && secs < 7, `length ${secs}`);
    assert.strictEqual(r.waiting, null);
    assert.strictEqual(core.tuners.uses.size, 0, 'the stream is given back');
  } finally { server.close(); }
});

test('a download can be paused (freeing its stream), resumed, and cancelled (deleting what was saved)', { skip: !ffmpeg && 'ffmpeg not installed', timeout: 120000 }, async () => {
  const src = tmp(), out = tmp();
  const movie = path.join(src, 'movie.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', movie]);
  const data = fs.readFileSync(movie);
  const server = http.createServer((req, res) => { // sends it slowly, so it's still going when paused
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const from = m ? +m[1] : 0, to = m && m[2] ? +m[2] + 1 : data.length;
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': to - from, 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${from}-${to - 1}/${data.length}` } : {}) });
    let i = from;
    const tick = setInterval(() => { if (i >= to) { clearInterval(tick); res.end(); return; } res.write(data.subarray(i, i = Math.min(to, i + 16384))); }, 20);
    req.on('close', () => clearInterval(tick));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const core = fakeCore(out, `http://127.0.0.1:${server.address().port}/movie/u/p/5.mp4`);
    const imp = new Importer(core);
    imp.pause = () => new Promise((r) => setTimeout(r, 200));
    const downloading = () => [...core.tuners.uses.values()].some((u) => u.kind === 'dl');
    const { id } = imp.addDownload('m~src1~5~mp4', { title: 'Test Movie', duration: 6 });
    const file = rec(core, id).file;
    await until(() => downloading() && fs.existsSync(`${file}.part`));
    await imp.hold(id);
    await until(() => !imp.busy);
    assert.strictEqual(rec(core, id).paused, true);
    assert.strictEqual(rec(core, id).status, 'importing', 'paused, not failed');
    assert.ok(!downloading(), 'the stream is free while paused');
    assert.ok(!fs.existsSync(`${file}.part`));
    // A restart keeps it paused.
    const imp2 = new Importer(core);
    imp2.resume();
    assert.ok(!imp2.busy && !imp2.queue.length);
    // Resume: it starts again and finishes.
    const inputs = core.inputs;
    imp.unhold(id);
    const r = await until(() => rec(core, id).status !== 'importing' && rec(core, id));
    assert.strictEqual(r.status, 'complete', r.error);
    assert.ok(core.inputs > inputs);
    assert.ok(fs.existsSync(r.file));
    // Cancel while downloading: the partial file goes, and the stream is given back.
    const two = imp.addDownload('e~src1~9~mp4', { title: 'Other', season: 1, episode: 1, duration: 6 });
    const file2 = rec(core, two.id).file;
    await until(() => downloading() && fs.existsSync(`${file2}.part`));
    await imp.cancel(two.id);
    await until(() => !imp.busy);
    assert.ok(!fs.existsSync(`${file2}.part`) && !fs.existsSync(file2));
    assert.ok(!downloading());
    // Cancel while paused.
    const three = imp.addDownload('e~src1~10~mp4', { title: 'Other', season: 1, episode: 2, duration: 6 });
    await until(() => downloading());
    await imp.hold(three.id);
    await until(() => !imp.busy);
    await imp.cancel(three.id);
    assert.ok(!fs.existsSync(`${rec(core, three.id).file}.part`));
  } finally { server.close(); }
});
