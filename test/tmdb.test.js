const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tmdb, parseTitle, similarity } = require('../src/core/tmdb');
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

test('Quality tags never stop a match', () => {
  for (const raw of ['4K | The Matrix', '|UHD| The Matrix HDR', 'The Matrix 4K', 'The Matrix ᴴᴰ', 'The Matrix ⁴ᴷ', '4K - The Matrix',
    'HD: The Matrix', 'The Matrix FHD 2160p HEVC', 'EN | The Matrix | 4K', 'The Matrix (4K HDR)', 'The Matrix DV HDR10+ Atmos', 'The Matrix MULTI']) {
    assert.equal(parseTitle(raw).title, 'The Matrix', raw);
  }
  assert.equal(parseTitle('Sub Zero').title, 'Sub Zero'); // real words stay
  assert.equal(parseTitle('Cam').title, 'Cam');
  assert.equal(parseTitle('Spider-Man HD').title, 'Spider-Man');
});

test('Near-identical titles count as the same; sequels and others do not', () => {
  assert.ok(similarity('Spiderman', 'Spider-Man') > 0.9);
  assert.ok(similarity('Fast and Furious', 'Fast & Furious') > 0.9);
  assert.ok(similarity('Matrix', 'The Matrix') > 0.9);
  assert.ok(similarity('Harry Potter Sorcerers Stone', "Harry Potter and the Sorcerer's Stone") > 0.8);
  assert.ok(similarity('The Matrx', 'The Matrix') > 0.8);
  assert.ok(similarity('Toy Story', 'Toy Story 4') < 0.7);
  assert.ok(similarity('Breaking Bad', 'The Matrix') < 0.3);
});

test('The closest TMDb result wins, and an old "nothing found" is asked again', async () => {
  const server = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('query');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: q === 'Toy Story' ? [
      { id: 4, title: 'Toy Story 4', release_date: '2019-06-19' },
      { id: 1, title: 'Toy Story', release_date: '1995-10-30' },
    ] : q === 'Gladiator' ? [{ id: 98, title: 'Gladiator', release_date: '2000-05-01' }] : [] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-tmdb-'));
  const core = { store: new Store(dir), settings: { tmdbKey: 'k' } };
  core.store.write('tmdbcache', { 'movie|gladiator|': { status: 'none', at: Date.now() } }); // from the old matcher
  const tmdb = new Tmdb(core, { api: `http://127.0.0.1:${server.address().port}` });
  try {
    const t = await tmdb.lookup('movies', '4K | Toy Story');
    assert.equal(t.tmdbId, 1);
    assert.equal(t.confidence >= 0.9, true);
    assert.equal((await tmdb.lookup('movies', 'Gladiator 4K')).status, 'found');
    assert.equal((await tmdb.lookup('movies', 'Nope HD')).status, 'none');
  } finally {
    clearTimeout(tmdb.saveTimer);
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
