const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');
const { Arlo, safePath } = require('../src/core/arlo');

// Just enough of the engine for arlo.js: settings, notes, change events.
function fakeCore(arlo) {
  const core = new EventEmitter();
  core.settings = { port: 5480, arlo };
  core.note = () => {};
  return core;
}

test('Arlo: only clip paths from Arlo Keeper can be shown', () => {
  assert.strictEqual(safePath('/live/AF824A75D022B-1793845876033.ts'), '/live/AF824A75D022B-1793845876033.ts');
  assert.strictEqual(safePath('/media/Front_Door/2026-11-04/20-31-16.mp4'), '/media/Front_Door/2026-11-04/20-31-16.mp4');
  for (const bad of ['/media/../clips.db', '/media/x/../../etc/passwd.mp4', '/connect', 'http://evil/x.mp4', '/live/a/b.ts', '', null]) assert.strictEqual(safePath(bad), null, String(bad));
});

test('Arlo: motion pops up only when turned on and the camera is ticked', () => {
  const sent = [];
  const ev = { event: 'motion', camera: 'Front Door', camera_id: 'AF824A75D022B', time: 1793845876033, file: 'Front_Door/2026-11-04/20-31-16.mp4',
    live: '/live/AF824A75D022B-1793845876033.ts', clip: '/media/Front_Door/2026-11-04/20-31-16.mp4' };
  const make = (arlo) => new Arlo(fakeCore(arlo), (m) => sent.push(m));

  assert.strictEqual(make({ enabled: false, cameras: ['AF824A75D022B'] }).motion(ev).shown, false);
  assert.strictEqual(make({ enabled: true, cameras: ['OTHER'] }).motion(ev).shown, false);
  assert.strictEqual(sent.length, 0);

  assert.strictEqual(make({ enabled: true, cameras: ['AF824A75D022B'] }).motion(ev).shown, true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].what, 'arlo');
  assert.deepStrictEqual({ ...sent[0].motion, view: undefined }, { camera: 'Front Door', cameraId: 'AF824A75D022B', time: 1793845876033, file: ev.file, view: undefined });
  assert.strictEqual(sent[0].motion.view, `/arlo/view?src=${encodeURIComponent(ev.live)}`); // the clip as it records

  assert.throws(() => make({ enabled: true, cameras: ['AF824A75D022B'] }).motion({ ...ev, live: '/media/../x', clip: '/etc/passwd' }));
});

test('Arlo: cameras, check-in and test pop-up go to Arlo Keeper', async () => {
  const calls = [];
  const keeper = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push(`${req.method} ${req.url} ${body}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/cameras') return res.end(JSON.stringify({ connected: true, modes: { Home: 'Arm Home' }, cameras: [{ id: 'A1', name: 'Front Door', model: 'VMC2052A', battery: 87 }, { id: 'B2', name: 'DECK' }] }));
      if (req.url.startsWith('/api/clips')) return res.end(JSON.stringify([{ camera_id: 'B2', camera_name: 'DECK', video_path: 'DECK/2026-11-04/10-00-00.mp4' }, { camera_id: 'A1', camera_name: 'Front Door', video_path: 'Front_Door/2026-11-04/09-00-00.mp4' }]));
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => keeper.listen(0, '127.0.0.1', r));
  const settings = { enabled: true, url: `http://127.0.0.1:${keeper.address().port}`, cameras: ['A1'] };
  const sent = [];
  const arlo = new Arlo(fakeCore(settings), (m) => sent.push(m));
  try {
    const cams = await arlo.cameras();
    assert.deepStrictEqual(cams.cameras.map((c) => [c.name, c.on]), [['Front Door', true], ['DECK', false]]);
    assert.deepStrictEqual(cams.modes, { Home: 'Arm Home' });

    await arlo.checkIn();
    assert.ok(calls.includes('POST /api/subscribe {"port":5480}'));
    assert.strictEqual(arlo.subscribed, true);
    settings.enabled = false;
    await arlo.checkIn();
    assert.ok(calls.includes('DELETE /api/subscribe {"port":5480}'));

    settings.enabled = true;
    const t = await arlo.test();
    assert.strictEqual(t.camera, 'Front Door'); // newest clip from a ticked camera
    assert.strictEqual(sent[0].motion.view, `/arlo/view?src=${encodeURIComponent('/media/Front_Door/2026-11-04/09-00-00.mp4')}`);
  } finally {
    keeper.close();
  }
});

test('Arlo: a wrong address gives a plain answer', async () => {
  const arlo = new Arlo(fakeCore({ enabled: true, url: 'http://127.0.0.1:1', cameras: [] }), () => {});
  await assert.rejects(arlo.cameras(), /Couldn't reach Arlo Keeper/);
});

test('Arlo: a name and password in the address are sent with every request, accounts come through', async () => {
  const { keeperAddress } = require('../src/core/arlo');
  const a = keeperAddress('https://gary:p%40ss:w@BAN.example.com/');
  assert.strictEqual(a.base, 'https://ban.example.com');
  assert.strictEqual(Buffer.from(a.auth.split(' ')[1], 'base64').toString(), 'gary:p@ss:w');
  assert.strictEqual(keeperAddress('http://10.0.0.5:8090').auth, null);
  assert.ok(keeperAddress('not a url').error);

  const seen = [];
  const keeper = http.createServer((req, res) => {
    seen.push([req.url, req.headers.authorization || null]);
    if (req.headers.authorization !== 'Basic ' + Buffer.from('gary:secret').toString('base64')) { res.statusCode = 401; return res.end('Sign in first'); }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/cameras') return res.end(JSON.stringify({ connected: true, cameras: [{ id: 'A1', name: 'Door', account: 'a@x' }, { id: 'blink-9', name: 'Yard', account: 'b@x', brand: 'blink' }],
      accounts: [{ username: 'a@x', brand: 'arlo', connected: true }, { username: 'b@x', brand: 'blink', connected: false, waiting_for_code: true }] }));
    if (req.url.startsWith('/api/clips')) return res.end(JSON.stringify([{ camera_id: 'blink-9', camera_name: 'Yard', video_path: 'Yard/1.mp4' }, { camera_id: 'A1', camera_name: 'Door', video_path: 'Door/1.mp4' }]));
    res.end('{}');
  });
  await new Promise((r) => keeper.listen(0, '127.0.0.1', r));
  const port = keeper.address().port;
  try {
    const arlo = new Arlo(fakeCore({ enabled: true, url: `http://gary:secret@127.0.0.1:${port}`, cameras: [] }), () => {});
    const cams = await arlo.cameras();
    assert.deepStrictEqual(cams.cameras.map((c) => c.account), ['arlo:a@x', 'blink:b@x']);
    assert.deepStrictEqual(cams.accounts.map((x) => [x.id, x.waitingForCode]), [['arlo:a@x', false], ['blink:b@x', true]]);
    // An Arlo Keeper that ignores account= still gives only that account's clips.
    const clips = await arlo.clips(null, 10, 'blink:b@x');
    assert.deepStrictEqual(clips.map((c) => c.camera), ['Yard']);
    assert.ok(seen.some(([u]) => u.includes('account=blink%3Ab%40x')));
    assert.ok(seen.every(([, h]) => h)); // sent first time, never waited to be asked

    const wrong = new Arlo(fakeCore({ enabled: true, url: `http://gary:nope@127.0.0.1:${port}`, cameras: [] }), () => {});
    await assert.rejects(wrong.cameras(), /401.*away-from-home/);
  } finally {
    keeper.close();
  }
});
