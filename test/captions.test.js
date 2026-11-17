const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Captions, moviePath } = require('../src/core/captions');

test('captions: a recording path is safe inside the movie= filter', () => {
  assert.strictEqual(moviePath("C:\\TV\\It's [x].ts"), "C\\\\:/TV/It\\\\\\'s \\[x\\].ts");
});

test('captions: read once the recording is finished, then served from the file', async (t) => {
  let ffmpeg = null;
  try { execFileSync('ffmpeg', ['-version']); ffmpeg = 'ffmpeg'; } catch (_) { return t.skip('no ffmpeg'); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtv cc's: "));
  const file = path.join(dir, 'show [1].ts');
  execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30', '-t', '1', '-c:v', 'mpeg2video', '-f', 'mpegts', file]);
  const rec = { id: 'r1', file, status: 'recording', title: 'Show' };
  const cc = new Captions({ ffmpeg: () => ffmpeg, dir: () => path.join(dir, '.captions'), find: () => rec });
  assert.deepStrictEqual(cc.get('r1'), { status: 'pending' });
  assert.equal(cc.busy, null, 'not read while still recording');
  rec.status = 'complete';
  assert.deepStrictEqual(cc.get('r1'), { status: 'pending' });
  for (let i = 0; i < 100 && cc.busy; i++) await new Promise((r) => setTimeout(r, 100));
  const r = cc.get('r1');
  assert.equal(r.status, 'ready');
  assert.match(r.text, /^WEBVTT/);
  cc.remove('r1');
  assert.equal(fs.existsSync(cc.file('r1')), false);
});
