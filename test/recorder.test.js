const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const { probeStream, reason, startRecording } = require('../src/core/recorder');

test('recording errors say why a stream could not be reached', () => {
  const e = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  assert.match(reason(e), /^fetch failed: the stream server did not answer \(UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error\)$/);
  const odd = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('something new'), { code: 'EWHATEVER' }) });
  assert.strictEqual(reason(odd), 'fetch failed: EWHATEVER: something new');
  assert.strictEqual(reason(new Error('Stream returned 404')), 'Stream returned 404');
});

test('stream check: answers ok for a working stream, and says why for a broken one', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok.ts') { res.writeHead(200); res.write(Buffer.alloc(188)); return; } // keeps streaming
    if (req.url === '/list.m3u8') return res.end('#EXTM3U\n#EXTINF:6,\nseg.ts');
    if (req.url === '/busy.ts') { res.writeHead(503); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // A port nothing listens on: connection refused.
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const deadPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  try {
    assert.deepStrictEqual(await probeStream(`${base}/ok.ts`), { ok: true });
    assert.deepStrictEqual(await probeStream(`${base}/list.m3u8`), { ok: true });
    assert.deepStrictEqual(await probeStream(`${base}/busy.ts`), { ok: false, error: 'All tuners are busy' });
    assert.deepStrictEqual(await probeStream(`${base}/gone.ts`), { ok: false, error: 'Stream returned 404' });
    const dead = await probeStream(`http://127.0.0.1:${deadPort}/x.ts`);
    assert.strictEqual(dead.ok, false);
    assert.match(dead.error, /fetch failed: .*ECONNREFUSED/);
  } finally {
    server.closeAllConnections && server.closeAllConnections();
    server.close();
  }
});

test('a recording that never connects fails with the real reason', async () => {
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const os = require('os'), path = require('path'), fs = require('fs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-rec-')), 'x.ts');
  const logs = [];
  const h = startRecording({ url: `http://127.0.0.1:${port}/live.ts`, file, until: Date.now() + 1500, log: (m) => logs.push(m) });
  const result = await h.done;
  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /ECONNREFUSED/);
  assert.ok(logs.length >= 1 && logs.every((m) => /ECONNREFUSED/.test(m)));
});
