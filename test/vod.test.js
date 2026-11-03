const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vod, clean } = require('../src/core/vod');
const { Store } = require('../src/core/store');

// A pretend provider panel with a small movie and show library.
function fakePanel() {
  const server = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const send = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (q.get('username') !== 'u1' || q.get('password') !== 'p w') return send({ user_info: { auth: 0 } });
    const a = q.get('action');
    if (!a) return send({ user_info: { auth: 1, status: 'Active', max_connections: '1' } });
    if (a === 'get_vod_categories') return send([{ category_id: '7', category_name: 'FR | Films' }, { category_id: '5', category_name: 'EN - Action' }]);
    if (a === 'get_vod_streams' && q.get('category_id') === '5') {
      return send([
        { stream_id: 1, name: 'EN - Old Movie (1999)', added: '100', container_extension: 'mkv', rating: '6.5', stream_icon: 'http://p/1.jpg' },
        { stream_id: 2, name: 'New Movie', added: '200', year: '2026' },
      ]);
    }
    if (a === 'get_vod_streams' && !q.get('category_id')) { // the whole library, for search
      return send([
        { stream_id: 3, name: 'EN - Spider-Man (2002)', added: '50' },
        { stream_id: 4, name: 'The Amazing Spider-Man', added: '300' },
        { stream_id: 5, name: 'Cars', added: '10' },
        { stream_id: 6, name: '[X][Studio] Spider Man Night', added: '900' },
        { stream_id: 7, name: 'Batman', added: '20' },
      ]);
    }
    if (a === 'get_vod_info') return send({ info: { plot: 'Things happen.', duration_secs: 5400, genre: 'Action' }, movie_data: { name: 'New Movie' } });
    if (a === 'get_series_categories') return send([{ category_id: '9', category_name: 'US Shows' }]);
    if (a === 'get_series') return send([{ series_id: 44, name: 'A Show', cover: 'http://p/s.jpg', last_modified: '5' }]);
    if (a === 'get_series_info') {
      return send({ info: { name: 'A Show', plot: 'Ongoing.' }, episodes: {
        2: [{ id: '902', episode_num: 1, title: 'Two-one', container_extension: 'mp4', info: { duration_secs: 1800 } }],
        1: [{ id: '802', episode_num: 2, title: 'One-two' }, { id: '801', episode_num: 1, title: 'One-one' }],
      } });
    }
    send(null);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('Movies and shows from an IPTV provider', async () => {
  const panel = await fakePanel();
  const base = `http://127.0.0.1:${panel.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-vod-'));
  const core = { store: new Store(dir), note() {}, sources: [{ id: 'src1', type: 'xtream', enabled: true, name: 'IPTV', config: { servers: base, username: 'u1', password: 'p w' } }] };
  const vod = new Vod(core);
  try {
    const cats = await vod.categories('movies');
    assert.deepEqual(cats.map((c) => c.name), ['EN - Action', 'FR | Films']); // English first
    const movies = await vod.items('movies', cats[0].id);
    assert.deepEqual(movies.map((m) => [m.name, m.year]), [['New Movie', '2026'], ['Old Movie (1999)', '1999']]); // newest first, tag removed
    assert.equal(movies[1].id, 'm~src1~1~mkv');
    assert.equal(movies[1].rating, 6.5);
    const info = await vod.movie(movies[0].id);
    assert.equal(info.duration, 5400);
    assert.equal(info.plot, 'Things happen.');
    assert.equal((await vod.input('m~src1~1~mkv')).url, `${base}/movie/u1/p%20w/1.mkv`);

    const shows = await vod.items('shows', (await vod.categories('shows'))[0].id);
    assert.equal(shows[0].id, 's~src1~44');
    const show = await vod.show(shows[0].id);
    assert.deepEqual(show.seasons.map((s) => [s.season, s.episodes.map((e) => e.title)]), [[1, ['One-one', 'One-two']], [2, ['Two-one']]]);
    assert.equal((await vod.input(show.seasons[1].episodes[0].id)).url, `${base}/series/u1/p%20w/902.mp4`);
    await assert.rejects(vod.input('m~src1~1;rm~mkv'), /Not found/);

    // Search: every word must match, punctuation doesn't matter, closest name first.
    assert.deepEqual((await vod.search('movies', 'spider man')).map((m) => m.name), ['Spider-Man (2002)', 'The Amazing Spider-Man']);
    assert.deepEqual((await vod.search('movies', 'amazing spider')).map((m) => m.id), ['m~src1~4~mp4']);
    assert.deepEqual(await vod.search('movies', '  '), []);
    assert.deepEqual((await vod.search('movies', 'man')).map((m) => m.name), ['The Amazing Spider-Man', 'Spider-Man (2002)']); // not Batman, no adult titles
    assert.deepEqual((await vod.search('shows', 'show')).map((s) => s.name), ['A Show']);

    // Favorites: kept with what a poster needs, newest first; only movies and shows.
    vod.setFavorite('m~src1~4~mp4', true, { name: 'The Amazing Spider-Man', poster: 'http://p/4.jpg' });
    vod.setFavorite('s~src1~44', true, { name: 'A Show' });
    assert.deepEqual(vod.favoriteList().map((f) => f.name), ['A Show', 'The Amazing Spider-Man']);
    vod.setFavorite('s~src1~44', false);
    assert.deepEqual(vod.favoriteList().map((f) => f.id), ['m~src1~4~mp4']);
    assert.throws(() => vod.setFavorite('e~src1~902~mp4', true), /movie or a show/);

    // Where you stopped: kept part way through, dropped near the end.
    vod.saveProgress('m~src1~2~mp4', { position: 600, duration: 5400, title: 'New Movie' });
    assert.equal(vod.continueList()[0].position, 600);
    vod.saveProgress('m~src1~2~mp4', { position: 5300, duration: 5400, title: 'New Movie' });
    assert.equal(vod.continueList().length, 0);
  } finally {
    panel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Provider name tags are tidied', () => {
  assert.equal(clean('EN - The Film'), 'The Film');
  assert.equal(clean('USA | Show'), 'Show');
  assert.equal(clean('Up'), 'Up');
});
