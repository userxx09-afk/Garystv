const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Importer, dvdTitle, videoTsOf, niceTitle, convertArgs } = require('../src/core/importer');
const { findFfmpeg } = require('../src/core/tools');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-import-'));

// Just enough of the engine for the importer.
function fakeCore(dir) {
  let recs = [];
  const core = {
    settings: {}, notes: [],
    get recordings() { return recs; },
    store: { write: (k, v) => { if (k === 'recordings') recs = v; } },
    storage: { recordDir: () => dir, localDir: dir },
    note: (m) => core.notes.push(m), changed: () => {},
    patchRecording: (id, p) => { recs = recs.map((r) => (r.id === id ? { ...r, ...p } : r)); },
  };
  return core;
}
const waitDone = async (core, id) => {
  for (let i = 0; i < 600; i++) {
    const r = core.recordings.find((x) => x.id === id);
    if (r && r.status !== 'importing') return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('import did not finish');
};

test('names from disc labels and file names', () => {
  assert.strictEqual(niceTitle('MY_HOME_VIDEOS_2004'), 'My Home Videos 2004');
  assert.strictEqual(niceTitle('wedding.day.mkv'), 'Wedding Day');
  assert.strictEqual(niceTitle('Christmas at Grandma\'s.AVI'), 'Christmas at Grandma\'s');
});

test("a DVD's main title is its biggest VTS set, without the menu", () => {
  const d = tmp();
  const v = path.join(d, 'VIDEO_TS');
  fs.mkdirSync(v);
  for (const [n, size] of [['VIDEO_TS.IFO', 10], ['VTS_01_0.VOB', 5000], ['VTS_01_1.VOB', 100], ['VTS_02_0.VOB', 10], ['VTS_02_2.VOB', 300], ['VTS_02_1.VOB', 300], ['VTS_02_10.VOB', 1]]) fs.writeFileSync(path.join(v, n), Buffer.alloc(size));
  assert.strictEqual(videoTsOf(d), v);
  assert.strictEqual(videoTsOf(v), v);
  const t = dvdTitle(v);
  assert.deepStrictEqual(t.files.map((f) => path.basename(f)), ['VTS_02_1.VOB', 'VTS_02_2.VOB', 'VTS_02_10.VOB']);
  assert.strictEqual(t.size, 601);
});

test('H.264 is kept as it is; everything else is converted to H.264, always with AAC sound in MP4', () => {
  const keep = convertArgs({ input: 'a.mkv', info: { video: { codec: 'h264', pixFmt: 'yuv420p' } }, out: 'o.mp4' });
  assert.ok(keep.join(' ').includes('-c:v copy'));
  const ten = convertArgs({ input: 'a.mkv', info: { video: { codec: 'h264', pixFmt: 'yuv420p10le' } }, out: 'o.mp4' });
  assert.ok(ten.join(' ').includes('libx264'));
  const dvd = convertArgs({ input: 'pipe:0', dvd: true, out: 'o.mp4' }).join(' ');
  assert.ok(dvd.includes('-f mpeg') && dvd.includes('libx264') && dvd.includes('yadif') && dvd.includes('-c:a aac') && dvd.includes('-f mp4 o.mp4'));
});

const ffmpeg = findFfmpeg();
test('a DVD and a video file become playable MP4 recordings', { skip: !ffmpeg && 'ffmpeg not installed', timeout: 120000 }, async () => {
  const src = tmp(), out = tmp();
  const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  // A "DVD": MPEG-2 video and AC-3 sound in program-stream VOBs, split in two like a real disc.
  const v = path.join(src, 'MY_DVD', 'VIDEO_TS');
  fs.mkdirSync(v, { recursive: true });
  for (const [n, from] of [['VTS_01_1.VOB', 0], ['VTS_01_2.VOB', 3]]) {
    ff(['-f', 'lavfi', '-i', `testsrc2=size=720x480:rate=30000/1001,trim=start=${from}:duration=3,setpts=PTS-STARTPTS`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v', 'mpeg2video', '-b:v', '4M', '-aspect', '16:9', '-c:a', 'ac3', '-ac', '6', '-output_ts_offset', String(from), '-f', 'vob', path.join(v, n)]);
  }
  // A video file in an old format.
  const avi = path.join(src, 'old.camcorder.avi');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=duration=4', '-c:v', 'mpeg4', '-c:a', 'mp3', avi]);

  const core = fakeCore(out);
  const imp = new Importer(core);
  const [dvd] = await imp.addPath({ path: path.join(src, 'MY_DVD'), title: 'Our DVD' });
  const [file] = await imp.addPath({ path: avi });
  assert.strictEqual(file.title, 'Old Camcorder');
  assert.strictEqual(core.recordings.length, 2);
  assert.ok(core.recordings.every((r) => r.status === 'importing'));

  for (const id of [dvd.id, file.id]) {
    const r = await waitDone(core, id);
    assert.strictEqual(r.status, 'complete', r.error);
    assert.ok(r.file.endsWith('.mp4') && fs.existsSync(r.file) && !fs.existsSync(`${r.file}.part`));
    const probe = JSON.parse(execFileSync(ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m, x) => `ffprobe${x || ''}`), ['-v', 'error', '-show_entries', 'stream=codec_name,channels,width,height,sample_aspect_ratio:format=duration', '-of', 'json', r.file]));
    const vs = probe.streams.find((s) => s.width), as = probe.streams.find((s) => s.channels);
    assert.strictEqual(vs.codec_name, 'h264');
    assert.strictEqual(as.codec_name, 'aac');
    assert.strictEqual(as.channels, 2);
    const secs = (r.finishedAt - r.recordedAt) / 1000;
    if (id === dvd.id) {
      assert.strictEqual(vs.width, 852); // 16:9 DVD made square-pixel
      assert.ok(secs > 5 && secs < 7, `DVD length ${secs}`); // both VOBs, one after the other
      assert.strictEqual(path.basename(r.file), 'Our DVD.mp4');
    } else assert.ok(secs > 3 && secs < 5, `file length ${secs}`);
  }
  assert.ok(fs.existsSync(avi), 'the original is left alone');
});

test('stopping an import removes it and its half-made file', { skip: !ffmpeg && 'ffmpeg not installed', timeout: 60000 }, async () => {
  const src = tmp(), out = tmp();
  const f = path.join(src, 'long.avi');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=60', '-c:v', 'mpeg4', '-q:v', '10', f]);
  const core = fakeCore(out);
  const imp = new Importer(core);
  const [a] = await imp.addPath({ path: f });
  await new Promise((r) => setTimeout(r, 1500));
  const rec = core.recordings.find((r) => r.id === a.id);
  await imp.cancel(a.id);
  assert.ok(!fs.existsSync(`${rec.file}.part`));
  assert.ok(!core.notes.some((n) => /failed/.test(n)));
});
