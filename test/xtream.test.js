const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const xtream = require('../src/core/sources/xtream');

// A pretend provider panel: one login, three groups.
function fakePanel() {
  const server = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const ok = q.get('username') === 'u1' && q.get('password') === 'p w';
    const send = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!ok) return send({ user_info: { auth: 0 } });
    if (!q.get('action')) return send({ user_info: { auth: 1, status: 'Active', max_connections: '2', exp_date: '1893456000', allowed_output_formats: ['m3u8', 'ts'] } });
    if (q.get('action') === 'get_live_categories') return send([{ category_id: '1', category_name: 'USA | News' }, { category_id: '2', category_name: 'UK | Sports' }, { category_id: '3', category_name: 'US Sports' }]);
    if (q.get('action') === 'get_live_streams') {
      return send([
        { num: 3, name: 'ESPN', stream_id: 30, category_id: '3', epg_channel_id: 'espn.us', stream_icon: 'http://l/espn.png' },
        { num: 1, name: 'CNN', stream_id: 10, category_id: '1', epg_channel_id: 'cnn.us' },
        { num: 2, name: 'Sky Sports', stream_id: 20, category_id: '2' },
      ]);
    }
    send(null);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('Xtream login: first working server, US groups by default, numbered from 1000', async () => {
  const panel = await fakePanel();
  const base = `http://127.0.0.1:${panel.address().port}`;
  try {
    const r = await xtream.scan({ servers: `http://127.0.0.1:1 ${base}/`, username: 'u1', password: 'p w' });
    assert.deepEqual(r.channels.map((c) => [c.number, c.name, c.group]), [['1000', 'CNN', 'USA | News'], ['1001', 'ESPN', 'US Sports']]);
    assert.equal(r.channels[0].streamUrl, `${base}/live/u1/p%20w/10.ts`);
    assert.equal(r.channels[1].tvgId, 'espn.us');
    assert.equal(r.tunerCount, 2);
    assert.match(r.epgUrl, /\/xmltv\.php\?username=u1&password=p\+w$/);
    assert.match(r.info, /2 channels in 2 groups \(of 3; US groups only/);

    const picked = await xtream.scan({ servers: base, username: 'u1', password: 'p w', groups: 'sports', firstNumber: '2000', maxStreams: '1' });
    assert.deepEqual(picked.channels.map((c) => [c.number, c.name]), [['2000', 'Sky Sports'], ['2001', 'ESPN']]);
    assert.equal(picked.tunerCount, 1);

    await assert.rejects(xtream.scan({ servers: base, username: 'u1', password: 'wrong' }), /login refused/);
  } finally {
    panel.close();
  }
});

test('Xtream server list', () => {
  assert.deepEqual(xtream.servers({ servers: 'line.a.com, http://b.com/  https://c.com' }), ['http://line.a.com', 'http://b.com', 'https://c.com']);
});
