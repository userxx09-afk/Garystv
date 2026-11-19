const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Alexa, bestMatch, byNumber } = require('../src/core/alexa');

const CHANNELS = [
  { id: 'a', number: '204', name: 'US: ESPN HD' },
  { id: 'b', number: '205', name: 'ESPN Deportes' },
  { id: 'c', number: '2.1', name: 'WBBM-DT' },
  { id: 'd', number: '300', name: 'Fox News Channel' },
  { id: 'e', number: '301', name: 'ESPN2', hidden: true },
  { id: 'f', number: '400', name: 'Marquee Sports Network', favorite: true },
];

test('What was said finds the right channel', () => {
  assert.equal(bestMatch('ESPN', CHANNELS).id, 'a');
  assert.equal(bestMatch('fox news', CHANNELS).id, 'd');
  assert.equal(bestMatch('the Marquee channel', CHANNELS).id, 'f');
  assert.equal(bestMatch('ESPN2', CHANNELS), null); // hidden channels aren't put on
  assert.equal(bestMatch('', CHANNELS), null);
  assert.equal(byNumber(204, CHANNELS).id, 'a');
  assert.equal(byNumber(2, CHANNELS).id, 'c'); // "channel 2" is 2.1
  assert.equal(byNumber(999, CHANNELS), null);
});

// A pretend Tapper relay: one registered TV ("tv1"/"tok"), key "k" required.
function fakeRelay(seen) {
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const out = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-tapper-key'] !== 'k') return out(403, { error: 'wrong key' });
    if (req.url === '/tv/register') return out(200, { tvId: 'tv1', token: 'tok' });
    if (req.headers['x-tapper-tv'] !== 'tv1' || req.headers.authorization !== 'Bearer tok') return out(401, { error: 'unknown tv' });
    if (req.url === '/tv/pair') return out(200, { code: '123456', expiresInSec: 600, linked: false });
    if (req.url === '/tv/status') return out(200, { linked: true });
    if (req.url === '/tv/next') return out(200, { commands: [{ type: 'tune', query: 'ESPN' }, { type: 'number', number: 300 }, { type: 'tune', query: 'Nothing Like It' }, { type: 'pause' }, { type: 'evil' }] });
    return out(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('Links a screen through the relay and turns what Alexa heard into channels', async () => {
  const seen = [];
  const server = await fakeRelay(seen);
  const settings = {};
  const core = { channels: CHANNELS, get settings() { return settings; }, updateSettings(p) { Object.assign(settings, p); } };
  const alexa = new Alexa(core, { env: {} });
  try {
    assert.equal(alexa.overview().configured, false);
    await assert.rejects(alexa.pair({ name: 'x' }), /relay address/);
    assert.throws(() => alexa.save({ url: 'alexa.example.com' }), /https/);
    alexa.save({ url: `http://127.0.0.1:${server.address().port}/`, key: 'k' });
    assert.deepEqual(alexa.overview(), { configured: true, url: `http://127.0.0.1:${server.address().port}`, hasKey: true, keyFrom: 'settings' });

    // A screen with an id the relay forgot registers again.
    const p = await alexa.pair({ tv: { tvId: 'old', token: 'gone' }, name: 'GarysTV Fire TV' });
    assert.deepEqual(p, { code: '123456', expiresInSec: 600, linked: false, tv: { tvId: 'tv1', token: 'tok' } });
    assert.deepEqual(await alexa.status({ tv: p.tv }), { linked: true, known: true });
    assert.deepEqual(await alexa.status({ tv: { tvId: 'x', token: 'y' } }), { linked: false, known: false });
    assert.deepEqual(await alexa.next({ tv: { tvId: 'x', token: 'y' } }), { unknown: true, commands: [] });

    const { commands } = await alexa.next({ tv: p.tv });
    assert.deepEqual(commands, [
      { type: 'tune', query: 'ESPN', channelId: 'a', channel: '204 US: ESPN HD' },
      { type: 'number', number: 300, channelId: 'd', channel: '300 Fox News Channel' },
      { type: 'tune', query: 'Nothing Like It' }, // the TV says no channel matches
      { type: 'pause' },
    ]);

    alexa.save({ key: 'wrong' });
    await assert.rejects(alexa.pair({ name: 'x' }), /key doesn't match/);
  } finally {
    server.close();
  }
});

test('keeps the navigation commands the relay sends (guide, recordings, home, back)', () => {
  const { clean } = require('../src/core/alexa');
  const got = clean([{ type: 'guide' }, { type: 'recordings' }, { type: 'home' }, { type: 'back' }, { type: 'volume' }]).map((c) => c.type);
  assert.deepStrictEqual(got, ['guide', 'recordings', 'home', 'back']);
});
