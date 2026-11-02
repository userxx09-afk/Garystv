const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tmdb, parseTitle } = require('../src/core/tmdb');
const { Store } = require('../src/core/store');

test('Provider names become a title and year', () => {
  assert.deepEqual(parseTitle('EN - The Matrix (1999) [4K]'), { title: 'The Matrix', year: '1999' });
  assert.deepEqual(parseTitle('Dune Part Two 2024'), { title: 'Dune Part Two', year: '2024' });
  assert.deepEqual(parseTitle('USA | Breaking Bad'), { title: 'Breaking Bad', year: '' });
  assert.deepEqual(parseTitle('Blade.Runner.2049.HD'), { title: 'Blade Runner 2049', year: '' });
});

// A pretend TMDb: knows one movie; key "good-v3" as ?api_key=, or a long token as a Bearer header.
function fakeTmdb(calls) {
  const long = 'x'.repeat(200);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push(u.pathname + u.search);
    const ok = u.searchParams.get('api_key') === 'good-v3' || req.headers.authorization === `Bearer ${long}`;
    if (u.searchParams.get('query') === 'Outage') { res.writeHead(503); return res.end(); }
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    if (!ok) return res.end('{"status_message":"Invalid API key"}');
    const found = u.pathname === '/search/movie' && u.searchParams.get('query') === 'The Matrix' && u.searchParams.get('year') !== '2001';
    res.end(JSON.stringify({ results: found ? [{ id: 603, title: 'The Matrix', release_date: '1999-03-30', vote_average: 8.217, vote_count: 20000, overview: 'A hacker learns the truth.', poster_path: '/m.jpg' }] : [] }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, long })));
}

test('TMDb lookups: either key type, kept answers, failures not kept', async () => {
  const calls = [];
  const { server, long } = await fakeTmdb(calls);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-tmdb-'));
  const settings = {};
  const core = { store: new Store(dir), get settings() { return settings; } };
  const tmdb = new Tmdb(core, { api: `http://127.0.0.1:${server.address().port}` });
  try {
    assert.equal((await tmdb.lookup('movies', 'The Matrix')).status, 'nokey');
    settings.tmdbKey = 'good-v3';
    const m = await tmdb.lookup('movies', 'EN - The Matrix (1999)');
    assert.equal(m.status, 'found');
    assert.equal(m.rating, 8.2);
    assert.match(m.poster, /\/w342\/m\.jpg$/);
    const before = calls.length;
    await tmdb.lookup('movies', 'The Matrix', '1999');
    assert.equal(calls.length, before); // from the cache
    assert.equal((await tmdb.lookup('movies', 'The Matrix', '2001')).status, 'found'); // wrong year: asked again without it
    assert.equal((await tmdb.lookup('shows', 'Nothing Here')).status, 'none');

    tmdb.clearCache();
    settings.tmdbKey = long; // v4 token
    assert.equal((await tmdb.lookup('movies', 'The Matrix', '1999')).status, 'found');

    const out = await tmdb.lookup('movies', 'Outage');
    assert.equal(out.status, 'error');
    assert.ok(!Object.keys(tmdb.cache).some((k) => k.includes('outage'))); // not kept
    settings.tmdbKey = 'bad';
    tmdb.clearCache();
    assert.match((await tmdb.lookup('movies', 'The Matrix')).error, /refused the key/);
  } finally {
    clearTimeout(tmdb.saveTimer);
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
