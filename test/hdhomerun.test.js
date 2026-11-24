const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const hdhr = require('../src/core/sources/hdhomerun');

function fakeTuner(deviceId) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/discover.json') return res.end(JSON.stringify({ DeviceID: deviceId, DeviceAuth: 'auth-' + deviceId, TunerCount: 4 }));
      if (req.url === '/lineup.json') return res.end(JSON.stringify([{ GuideNumber: '5.1', GuideName: 'WMAQ', URL: 'http://x/auto/v5.1' }]));
      res.statusCode = 404; res.end('{}');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, host: `127.0.0.1:${srv.address().port}` }));
  });
}

test('hdhomerun: a tuner that moved to a new address is found again by its device ID', async (t) => {
  const other = await fakeTuner('OTHER');
  const mine = await fakeTuner('MINE');
  t.after(() => { other.srv.close(); mine.srv.close(); });
  const discover = hdhr.discover;
  hdhr.discover = async () => [{ host: other.host }, { host: mine.host }];
  t.after(() => { hdhr.discover = discover; });
  const result = await hdhr.scan({ host: '127.0.0.1:1', deviceId: 'MINE' });
  assert.equal(result.config.host, mine.host);
  assert.equal(result.config.deviceAuth, 'auth-MINE');
  assert.equal(result.channels.length, 1);
});

test('hdhomerun: the saved address is used while the tuner answers there', async (t) => {
  const mine = await fakeTuner('MINE');
  t.after(() => mine.srv.close());
  const discover = hdhr.discover;
  hdhr.discover = async () => { throw new Error('should not search'); };
  t.after(() => { hdhr.discover = discover; });
  assert.equal((await hdhr.locate({ host: mine.host, deviceId: 'MINE' })).host, mine.host);
});
