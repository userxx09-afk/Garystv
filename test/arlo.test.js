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

test('Arlo: only clip paths from Camera Keeper can be shown', () => {
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

test('Arlo: cameras, check-in and test pop-up go to Camera Keeper', async () => {
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
  await assert.rejects(arlo.cameras(), /Couldn't reach Camera Keeper/);
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
    // An Camera Keeper that ignores account= still gives only that account's clips.
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

test('Arlo: deleting a clip asks Camera Keeper to delete it', async () => {
  const seen = [];
  const keeper = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: !req.url.includes('gone') }));
  });
  await new Promise((r) => keeper.listen(0, '127.0.0.1', r));
  try {
    const arlo = new Arlo(fakeCore({ enabled: true, url: `http://127.0.0.1:${keeper.address().port}`, cameras: [] }), () => {});
    assert.deepStrictEqual(await arlo.deleteClip('Front Door/2026-11-04/20-31-16'), { ok: true });
    assert.strictEqual(seen[0], 'DELETE /api/clip/Front%20Door/2026-11-04/20-31-16');
    await assert.rejects(arlo.deleteClip('gone/x'), /doesn't have that clip/);
    await assert.rejects(arlo.deleteClip('../clips.db'), /Which clip/);
  } finally {
    keeper.close();
  }
});

test('Arlo: watching a camera live starts it at Camera Keeper and passes the pictures through', async () => {
  const calls = [];
  const keeper = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url} ${req.headers.authorization || ''}`);
    if (req.url === '/api/camera/A1/live.mjpg') {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
      return res.end('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\nJPG\r\n');
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/camera/A1/live') return res.end(JSON.stringify({ state: 'starting', error: null, seconds_left: 180, viewers: 0 }));
    if (req.url === '/api/camera/OFF/live') { res.statusCode = 404; return res.end(JSON.stringify({ state: 'error', error: "That camera isn't available." })); }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => keeper.listen(0, '127.0.0.1', r));
  const arlo = new Arlo(fakeCore({ enabled: true, url: `http://u:p@127.0.0.1:${keeper.address().port}`, cameras: [] }), () => {});
  const tv = http.createServer((req, res) => arlo.live(req, res, new URL(req.url, 'http://x').searchParams.get('camera')));
  await new Promise((r) => tv.listen(0, '127.0.0.1', r));
  try {
    assert.deepStrictEqual(await arlo.liveStart('A1'), { state: 'starting', error: null, secondsLeft: 180, viewers: 0 });
    assert.strictEqual((await arlo.liveState('A1')).state, 'starting');
    await assert.rejects(arlo.liveStart('OFF'), /isn't available/);
    await assert.rejects(arlo.liveStart('blink-12'), /Blink/);
    await assert.rejects(arlo.liveStart('../x'), /Which camera/);
    const body = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${tv.address().port}/arlo/live?camera=A1`, (r) => {
      assert.match(r.headers['content-type'], /multipart\/x-mixed-replace/);
      let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve(t));
    }).on('error', reject));
    assert.match(body, /JPG/);
    assert.ok(calls.includes(`POST /api/camera/A1/live Basic ${Buffer.from('u:p').toString('base64')}`));
    assert.ok(calls.some((c) => c.startsWith('GET /api/camera/A1/live.mjpg Basic ')));
  } finally { keeper.close(); tv.close(); }
});
