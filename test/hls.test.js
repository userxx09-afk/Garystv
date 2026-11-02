const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { bestVariant } = require('../src/core/hls');

test('IPTV: picks the best quality up to 1080p', async () => {
  const master = ['#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240', 'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080', 'hd/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720', 'mid/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160', 'uhd/index.m3u8'].join('\n');
  const server = http.createServer((req, res) => res.end(req.url.startsWith('/live/master') ? master : '#EXTM3U\n#EXTINF:6,\nseg.ts'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.strictEqual(await bestVariant(`${base}/live/master.m3u8`), `${base}/live/hd/index.m3u8`);
    assert.strictEqual(await bestVariant(`${base}/live/media.m3u8`), `${base}/live/media.m3u8`); // already a single quality
    assert.strictEqual(await bestVariant(`${base}/tuner/v5.1`), `${base}/tuner/v5.1`); // not HLS: left alone
  } finally {
    server.close();
  }
});
