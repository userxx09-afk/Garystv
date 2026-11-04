const test = require('node:test');
const assert = require('node:assert');
const { parseM3u } = require('../src/core/sources/m3u');
const { parseXmltv, parseTime } = require('../src/core/guide/xmltv');
const { reconcile, normCallsign, normNumber } = require('../src/core/guide/reconcile');
const { buildSchedule } = require('../src/core/scheduler');

test('M3U playlist parsing', () => {
  const { epgUrl, channels } = parseM3u(`#EXTM3U url-tvg="http://x/epg.xml"
#EXTINF:-1 tvg-id="wabc.us" tvg-name="WABC" tvg-logo="http://l/a.png" tvg-chno="7" group-title="USA",ABC 7 New York
http://p/live/1.ts
#EXTINF:-1 group-title="Sports",ESPN
http://p/live/2.m3u8
`);
  assert.equal(epgUrl, 'http://x/epg.xml');
  assert.equal(channels.length, 2);
  assert.deepEqual([channels[0].tvgId, channels[0].number, channels[0].group, channels[0].name], ['wabc.us', '7', 'USA', 'ABC 7 New York']);
  assert.equal(channels[1].streamUrl, 'http://p/live/2.m3u8');
});

test('XMLTV times and episodes', () => {
  assert.equal(parseTime('20261027200000 -0500'), Date.UTC(2026, 9, 28, 1, 0, 0));
  const { channels, programs } = parseXmltv(`<?xml version="1.0"?><tv>
    <channel id="I5.1.KDAB"><display-name>KDAB-DT</display-name><display-name>5.1</display-name><icon src="http://l.png"/></channel>
    <programme start="20261027200000 +0000" stop="20261027210000 +0000" channel="I5.1.KDAB">
      <title lang="en">Detective Lane</title><sub-title>The Long Night</sub-title><desc>A case.</desc>
      <episode-num system="xmltv_ns">2.4.</episode-num><new/></programme></tv>`);
  assert.equal(channels[0].number, '5.1');
  const p = programs['I5.1.KDAB'][0];
  assert.deepEqual([p.title, p.subtitle, p.season, p.episode, p.isNew], ['Detective Lane', 'The Long Night', 3, 5, true]);
});

test('channel matching to guide', () => {
  assert.equal(normCallsign('KDAB-DT'), 'KDAB');
  assert.equal(normCallsign('WABCDT2'), 'WABC');
  assert.equal(normNumber('5-1'), '5.1');
  const channels = [
    { id: 'a', number: '5.1', name: 'KDAB', callsign: 'KDAB' },
    { id: 'b', number: '5.2', name: 'MeTV' },
    { id: 'c', number: '', name: 'ESPN', tvgId: 'espn.us' },
    { id: 'd', number: '99.9', name: 'Mystery' },
  ];
  const guide = [
    { id: 'g1', rawId: 'x', names: ['KDAB-DT', '5.1'], number: '5.1' },
    { id: 'g2', rawId: 'y', names: ['KDAB-DT2', 'MeTV', '5.2'], number: '5.2' },
    { id: 'g3', rawId: 'espn.us', names: ['ESPN HD'], number: '' },
  ];
  const m = reconcile(channels, guide);
  assert.equal(m.get('a').guideId, 'g1');
  assert.ok(m.get('a').score >= 90);
  assert.equal(m.get('b').guideId, 'g2');
  assert.equal(m.get('c').guideId, 'g3');
  assert.equal(m.get('d').guideId, null);
});

test('scheduler: series, new-only, duplicates, conflicts', () => {
  const H = 3600000;
  const now = Date.UTC(2026, 9, 27, 12);
  const chans = [{ id: 's:2.1', sourceId: 's', number: '2.1', name: 'A' }, { id: 's:4.1', sourceId: 's', number: '4.1', name: 'B' }, { id: 's:5.1', sourceId: 's', number: '5.1', name: 'C' }];
  const progs = {
    's:2.1': [
      { start: now + H, end: now + 2 * H, title: 'Show X', season: 1, episode: 1, isNew: true },
      { start: now + 5 * H, end: now + 6 * H, title: 'Show X', season: 1, episode: 1, isNew: false },
      { start: now + 24 * H, end: now + 25 * H, title: 'Show X', season: 1, episode: 2, isNew: false },
    ],
    's:4.1': [{ start: now + H, end: now + 2 * H, title: 'Game', isNew: true }],
    's:5.1': [{ start: now + H, end: now + 2 * H, title: 'Movie', isNew: true }],
  };
  const rules = [
    { id: 'r1', type: 'series', title: 'show x', channelId: null, newOnly: false },
    { id: 'r2', type: 'once', channelId: 's:4.1', ...progs['s:4.1'][0] },
    { id: 'r3', type: 'once', channelId: 's:5.1', ...progs['s:5.1'][0] },
  ];
  const jobs = buildSchedule({ rules, channels: chans, programsFor: (c) => progs[c.id] || [], tunerCount: () => 2, recordedKeys: new Set(['showx|s1e2']), now, settings: { prePadMin: 0, postPadMin: 0 } });
  const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));
  assert.equal(byId[`s:2.1@${now + H}`].status, 'scheduled');
  assert.equal(byId[`s:2.1@${now + 5 * H}`].reason, 'Recording an earlier airing');
  assert.equal(byId[`s:2.1@${now + 24 * H}`].reason, 'Already recorded');
  assert.equal(byId[`s:4.1@${now + H}`].status, 'scheduled');
  assert.equal(byId[`s:5.1@${now + H}`].status, 'conflict', 'third show at once exceeds 2 tuners');

  const newOnly = buildSchedule({ rules: [{ id: 'r', type: 'series', title: 'Show X', newOnly: true }], channels: chans, programsFor: (c) => progs[c.id] || [], now });
  assert.equal(newOnly.length, 1);
});

test('scheduler: manual repeating timer', () => {
  const now = new Date(2026, 9, 27, 9, 0).getTime(); // a Tuesday
  const jobs = buildSchedule({
    rules: [{ id: 'm', type: 'manual', channelId: 'c', title: 'News', time: '18:00', minutes: 30, days: [1, 2, 3, 4, 5] }],
    channels: [{ id: 'c', sourceId: 's', number: '2.1', name: 'A' }], programsFor: () => [], now, horizonMs: 7 * 86400000,
  });
  assert.equal(jobs.length, 5);
  assert.equal(new Date(jobs[0].start).getHours(), 18);
});

test('Favorites lists', () => {
  const { DvrCore } = require('../src/core');
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gtv-fav-'));
  const core = new DvrCore({ dataDir: dir });
  const gary = core.addFavList({ name: "  Gary's Favorites " });
  core.addFavList({ name: "Barbara's Favorites" });
  assert.equal(gary.name, "Gary's Favorites");
  assert.deepEqual(core.toggleFavChannel(gary.id, 'src:ABC'), { on: true });
  assert.deepEqual(core.toggleFavChannel(gary.id, 'src:ABC', true), { on: true }); // already on: stays once
  core.toggleFavChannel(gary.id, 'src:NBC');
  assert.deepEqual(core.favLists[0].channelIds, ['src:ABC', 'src:NBC']);
  assert.deepEqual(core.toggleFavChannel(gary.id, 'src:ABC'), { on: false });
  core.updateFavList(gary.id, { name: 'Dad' });
  assert.deepEqual(core.favLists.map((l) => [l.name, l.channelIds]), [['Dad', ['src:NBC']], ["Barbara's Favorites", []]]);
  assert.throws(() => core.addFavList({ name: '  ' }), /name/);
  core.removeFavList(gary.id);
  assert.deepEqual(core.favLists.map((l) => l.name), ["Barbara's Favorites"]);
});

test('Your own channel numbers', () => {
  const { DvrCore } = require('../src/core');
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gtv-num-'));
  const core = new DvrCore({ dataDir: dir });
  core.store.write('sources', [{ id: 's', type: 'm3u', enabled: true, name: 'P', config: {} }]);
  core.store.write('channels', ['A', 'B', 'C'].map((n, i) => ({ id: `s:${n}`, sourceId: 's', number: String(1000 + i), name: n })));
  core.updateChannel('s:C', { alias: '007' });
  assert.deepEqual(core.channels.find((c) => c.id === 's:C'), { id: 's:C', sourceId: 's', number: '7', sourceNumber: '1002', alias: '7', name: 'C' });
  assert.deepEqual(core.visibleChannels().map((c) => c.name), ['C', 'A', 'B']); // the guide goes by your numbers
  assert.throws(() => core.updateChannel('s:A', { alias: '12a' }), /digits/);
  core.renumberChannels({ ids: ['s:B', 's:A'], start: 20 });
  assert.deepEqual(core.visibleChannels().map((c) => `${c.number} ${c.name}`), ['7 C', '20 B', '21 A']);
  core.renumberChannels({ ids: ['s:A', 's:B', 's:C'], clear: true });
  assert.deepEqual(core.channels.map((c) => c.number), ['1000', '1001', '1002']);
  assert.throws(() => core.renumberChannels({ ids: ['s:A'], start: 0 }), /first/);
});

test('Backup and restore', () => {
  const { DvrCore } = require('../src/core');
  const mk = () => new DvrCore({ dataDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gtv-bk-')) });
  const a = mk();
  a.store.write('sources', [{ id: 's1', type: 'xtream', enabled: true, name: 'WebTV', config: { servers: 'http://p', username: 'u1', password: 'pw123' } }]);
  a.store.write('guides', [{ id: 'g1', type: 'xmltv', name: 'P guide', config: { url: 'http://p/xmltv.php?username=u1&password=pw123' } }, { id: 'g2', type: 'xmltv', name: 'Free', config: { url: 'http://free/epg.xml' } }]);
  a.store.write('channels', [{ id: 's1:7', sourceId: 's1', number: '1000', name: 'ESPN', streamUrl: 'http://p/live/u1/pw123/7.ts' }, { id: 's1:8', sourceId: 's1', number: '1001', name: 'X' }]);
  a.updateChannel('s1:7', { alias: '6', favorite: true });
  a.updateSettings({ prePadMin: 3, recordingsDir: 'D:\TV', tmdbKey: 'k123' });
  a.addFavList({ name: 'Gary' });

  // Without logins: no password anywhere in the file, not even in the provider's guide address.
  const plain = a.backup();
  assert.equal(JSON.stringify(plain).includes('pw123'), false);
  assert.equal(JSON.stringify(plain).includes('k123'), false);
  assert.deepEqual(plain.channels, [{ id: 's1:7', favorite: true, alias: '6', mapMode: undefined }].map(({ mapMode, ...c }) => c));
  assert.equal(plain.settings.recordingsDir, undefined); // this computer's own folders stay behind

  // Restored elsewhere: settings and lists come over, this computer's folder stays, the missing login is asked for.
  const b = mk();
  b.updateSettings({ recordingsDir: 'C:\Rec' });
  const r = require('../src/core/backup').restoreBackup(b, JSON.parse(JSON.stringify(plain)));
  assert.deepEqual(r.needLogin, ['WebTV']);
  assert.equal(b.settings.prePadMin, 3);
  assert.equal(b.settings.recordingsDir, 'C:\Rec');
  assert.deepEqual(b.favLists.map((l) => l.name), ['Gary']);
  assert.deepEqual(b.store.read('channelchoices').s1_7, undefined);
  assert.deepEqual(b.store.read('channelchoices')['s1:7'], { favorite: true, alias: '6' });

  // With logins: they travel (for a new computer with nothing set up).
  const full = a.backup({ logins: true });
  require('../src/core/backup').restoreBackup(b, JSON.parse(JSON.stringify(full)));
  assert.equal(b.sources[0].config.password, 'pw123');
  assert.equal(b.settings.tmdbKey, 'k123');
  assert.throws(() => b.restore({ hello: 1 }), /isn't a GarysTV backup/);
});

test('Plans: one stream each, the same channel on another plan when one is busy', () => {
  const { DvrCore } = require('../src/core');
  const core = new DvrCore({ dataDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gtv-plan-')) });
  const plan = (id, user) => ({ id, type: 'xtream', enabled: true, name: `Plan ${id}`, tunerCount: 1, config: { servers: 'http://p.example', username: user } });
  core.store.write('sources', [plan('a', 'u1'), plan('b', 'u2'), { id: 'f', type: 'free', enabled: true, name: 'Free', tunerCount: 6, config: {} }]);
  core.store.write('channels', [
    { id: 'a:1', sourceId: 'a', number: '1', name: 'ESPN HD', guideId: 'g|espn', streamUrl: 'http://a/1' },
    { id: 'b:1', sourceId: 'b', number: '2', name: 'ESPN', guideId: 'g|espn', streamUrl: 'http://b/1' },
    { id: 'a:2', sourceId: 'a', number: '3', name: 'Hallmark', streamUrl: 'http://a/2' },
    { id: 'f:1', sourceId: 'f', number: '4', name: 'News', streamUrl: 'http://f/1' },
  ]);
  const t = core.tuners;
  const one = t.acquire('a:1', 'live', 'ESPN');
  assert.equal(one.channel.id, 'a:1');
  assert.equal(t.acquire('a:1', 'live', 'ESPN').channel.id, 'b:1'); // plan a busy: ESPN on plan b
  assert.throws(() => t.acquire('a:2', 'live', 'Hallmark'), (e) => e.status === 409 && /Plan a is in use.*watching ESPN/.test(e.message));
  for (let i = 0; i < 8; i++) t.acquire('f:1', 'live'); // free channels have no limit
  // A recording takes the plan from someone watching here; they're told why.
  let told = '';
  t.release(one.id);
  t.acquire('a:2', 'live', 'Hallmark', (why) => { told = why; });
  assert.equal(t.acquire('a:2', 'rec', 'Movie').channel.id, 'a:2');
  assert.match(told, /Stopped so "Movie" could record/);
  // The same plan in use at a linked location counts too (by plan key, not login).
  assert.equal(t.report().some((u) => JSON.stringify(u).includes('u1')), false);
  t.uses.clear();
  t.remote.set('work', { at: Date.now(), name: 'Work', uses: [{ plan: require('../src/core/tuners').planKey(plan('a', 'u1')), kind: 'live', what: 'CNN' }] });
  assert.throws(() => t.acquire('a:2', 'live'), /watching CNN at Work/);
});

test('scheduler: a full plan records the same channel on another plan', () => {
  const now = Date.UTC(2026, 9, 27, 12);
  const ch = [{ id: 'a:1', sourceId: 'a', name: 'ESPN' }, { id: 'a:2', sourceId: 'a', name: 'TNT' }, { id: 'b:2', sourceId: 'b', name: 'TNT' }];
  const show = (title) => [{ start: now + 3600000, end: now + 7200000, title }];
  const jobs = buildSchedule({
    rules: [{ id: 'r1', type: 'series', title: 'Game' }, { id: 'r2', type: 'series', title: 'Movie', channelId: 'a:2' }],
    channels: ch.slice(0, 2), programsFor: (c) => show(c.id === 'a:1' ? 'Game' : 'Movie'), now,
    tunerCount: () => 1, choices: (job) => (job.channelId === 'a:2' ? [ch[1], ch[2]] : [ch[0]]),
  });
  const movie = jobs.find((j) => j.title === 'Movie');
  assert.deepEqual([movie.status, movie.viaChannelId], ['scheduled', 'b:2']);
});

test('Updates: when they may go in, and which version is newer', () => {
  const { due, newer, lastSlot, plan } = require('../src/core/update-plan');
  const sun330 = new Date(2026, 10, 1, 3, 30); // a Sunday
  assert.equal(due({}, sun330), true); // Sundays 3:00 by default, for two hours
  assert.equal(due({}, new Date(2026, 10, 1, 5, 30)), false);
  assert.equal(due({}, new Date(2026, 10, 2, 3, 30)), false); // Monday
  assert.equal(due({ updateDay: 'daily', updateTime: '23:30' }, new Date(2026, 10, 3, 0, 15)), true); // just past midnight
  assert.equal(due({ updatePlan: 'ask' }, sun330), false);
  assert.equal(due({ updatePlan: 'anytime' }, new Date(2026, 10, 4, 14)), true);
  assert.equal(lastSlot(plan({ updateDay: 'mon' }), sun330), null);
  assert.equal(newer('0.2.31', '0.2.9'), true);
  assert.equal(newer('0.2.9', '0.2.31'), false);
  assert.equal(newer('0.2.31', '0.2.31'), false);
});

test('Other locations: home just works, elsewhere signs in once', () => {
  const { DvrCore } = require('../src/core');
  const { Auth, isHome } = require('../src/core/auth');
  const core = new DvrCore({ dataDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gtv-auth-')) });
  const auth = new Auth(core);
  const req = (ip, cookie = '') => ({ socket: { remoteAddress: ip }, headers: { cookie } });
  assert.deepEqual(['192.168.5.20', '::ffff:10.0.0.4', '127.0.0.1', '100.64.0.7', '8.8.8.8', 'fd7a:115c:a1e0::3'].map((ip) => isHome(ip.replace(/^::ffff:/, ''))), [true, true, true, false, false, false]);
  assert.equal(auth.check(req('192.168.5.20')).ok, true);
  assert.equal(auth.check(req('100.64.0.7')).ok, false); // Tailscale is another location
  assert.throws(() => auth.signIn(req('100.64.0.7'), { password: 'x' }), /doesn't allow other locations/); // no password set yet
  assert.throws(() => auth.setPassword('abc'), /6 characters/);
  auth.setPassword('secret99');
  assert.throws(() => auth.signIn(req('100.64.0.7'), { password: 'nope' }), (e) => e.status === 401);
  const cookie = auth.signIn(req('100.64.0.7'), { password: 'secret99', device: 'Fire TV' }).split(';')[0];
  assert.equal(auth.check(req('100.64.0.7', cookie)).login.device, 'Fire TV');
  assert.equal(JSON.stringify(auth.overview()).includes(cookie.split('=')[1]), false); // the token never leaves
  for (let i = 0; i < 5; i++) assert.throws(() => auth.signIn(req('100.64.0.9'), { password: 'guess' }));
  assert.throws(() => auth.signIn(req('100.64.0.9'), { password: 'secret99' }), (e) => e.status === 429); // too many tries
  auth.setPassword(''); // off: everyone from away is signed out
  assert.equal(auth.check(req('100.64.0.7', cookie)).ok, false);
});

test('Linked GarysTVs: link with the password, then manage one through the other', async () => {
  const { DvrCore } = require('../src/core');
  const { createServer } = require('../src/core/server');
  const mk = async (name) => {
    const core = new DvrCore({ dataDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gtv-peer-')) });
    core.updateSettings({ serverName: name, recordingsDir: core.store.dir });
    const srv = createServer(core);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { core, srv, base: `http://127.0.0.1:${srv.address().port}` };
  };
  const home = await mk('Home');
  const work = await mk('Work');
  try {
    const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let r = await post(home.base, '/api/peers', { url: work.base, password: 'x', share: true });
    assert.match((await r.json()).error, /doesn't allow other locations/); // Work has no password yet
    work.core.auth.setPassword('workpass1');
    r = await post(home.base, '/api/peers', { url: work.base, password: 'workpass1', share: true });
    assert.deepEqual(await r.json(), { id: work.core.peers.me.id, name: 'Work' });
    assert.equal(work.core.peers.list[0].name, 'Home'); // both sides know each other
    // Home's screens can now manage Work through Home.
    work.core.addFavList({ name: 'Work list' });
    const id = home.core.peers.list[0].id;
    const st = await (await fetch(`${home.base}/peer/${id}/api/state`)).json();
    assert.deepEqual(st.favLists.map((l) => l.name), ['Work list']);
    // Without the key, Work turns callers from elsewhere away (here everything is 127.0.0.1, so fake a wrong key).
    r = await fetch(`${work.base}/api/state`, { headers: { 'x-garystv-peer': `${home.core.peers.me.id} wrongkey` } });
    assert.equal(r.status, 401);
    // Unlinking tells the other one.
    await fetch(`${home.base}/api/peers/${id}`, { method: 'DELETE' });
    assert.equal(work.core.peers.list.length, 0);
  } finally {
    for (const x of [home, work]) { x.srv.close(); x.core.timeshift.stopAll(); }
  }
});

test('Home and work sharing: plans in use, lists, channel numbers and recordings', async () => {
  const { DvrCore } = require('../src/core');
  const { createServer } = require('../src/core/server');
  const mk = async (name, sid) => {
    const core = new DvrCore({ dataDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gtv-share-')) });
    core.updateSettings({ serverName: name, recordingsDir: core.store.dir });
    core.store.write('sources', [{ id: sid, type: 'xtream', enabled: true, name: 'Plan 1', tunerCount: 1, config: { servers: 'http://p.example', username: 'u1', password: 'pw' } }]);
    core.store.write('channels', [{ id: `${sid}:7`, sourceId: sid, number: '1007', name: 'KAAL', streamUrl: 'http://p/7' }]);
    const srv = createServer(core);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { core, srv, base: `http://127.0.0.1:${srv.address().port}` };
  };
  const home = await mk('Home', 'h1');
  const work = await mk('Work', 'w1');
  const until = async (ok) => { for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(ok()); };
  try {
    work.core.auth.setPassword('workpass1');
    await fetch(`${home.base}/api/peers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: work.base, password: 'workpass1', share: true }) });
    // Changed at home: copied to work (its own ids for the same plan's channels).
    home.core.updateChannel('h1:7', { alias: '6' });
    const list = home.core.addFavList({ name: 'Gary' });
    home.core.toggleFavChannel(list.id, 'h1:7');
    await home.core.sharing.beat();
    await until(() => work.core.favLists.length === 1 && work.core.channels[0].number === '6');
    assert.deepEqual(work.core.favLists[0].channelIds, ['w1:7']);
    // Watching on the one-stream plan at home: work can't use it, and says why.
    home.core.tuners.acquire('h1:7', 'live', 'KAAL');
    await home.core.sharing.beat();
    assert.throws(() => work.core.tuners.acquire('w1:7', 'live'), /watching KAAL at Home/);
    // A recording at work asks home to let go of the plan.
    let told = '';
    home.core.tuners.uses.clear();
    home.core.tuners.acquire('h1:7', 'live', 'KAAL', (why) => { told = why; });
    await home.core.sharing.beat();
    let err;
    try { work.core.tuners.acquire('w1:7', 'rec', 'News'); } catch (e) { err = e; }
    work.core.sharing.askToYield(err.ask, 'News');
    await until(() => told);
    assert.match(told, /Stopped so "News" could record at Work/);
    // Work lists home's recordings too.
    home.core.store.write('recordings', [{ id: 'r1', title: 'Old Movie', start: 5, file: '/x.ts', status: 'complete' }]);
    const recs = await (await fetch(`${work.base}/api/recordings`)).json();
    assert.deepEqual(recs.map((r) => [r.id, r.at, r.file]), [[`~${home.core.peers.me.id}~r1`, 'Home', undefined]]);
  } finally {
    for (const x of [home, work]) { x.srv.close(); x.core.timeshift.stopAll(); x.core.sharing.stop(); }
  }
});

test('Big guides and lists: read off the main thread, sent zipped, no logins in the channel list', async () => {
  const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), zlib = require('zlib');
  const xmltv = require('../src/core/guide/xmltv');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-big-'));
  const file = path.join(dir, 'guide.xml');
  fs.writeFileSync(file, `<tv><channel id="a"><display-name>WABC</display-name><display-name>7</display-name></channel>
    <programme start="20261027200000 +0000" stop="20261027210000 +0000" channel="a"><title>News</title></programme></tv>`);
  const g = await xmltv.fetch({ url: file });
  assert.equal(g.channels[0].number, '7');
  assert.equal(g.programs.a[0].title, 'News');
  await assert.rejects(xmltv.fetch({ url: path.join(dir, 'missing.xml') }));

  const { DvrCore } = require('../src/core');
  const { createServer } = require('../src/core/server');
  const core = new DvrCore({ dataDir: dir });
  core.updateSettings({ recordingsDir: dir });
  core.store.write('sources', [{ id: 's1', type: 'xtream', name: 'P', enabled: true, config: {} }]);
  core.store.write('channels', Array.from({ length: 300 }, (_, i) => ({ id: `s1:${i}`, sourceId: 's1', number: String(i + 1), name: `Channel ${i}`, streamUrl: `http://p/live/user/secret/${i}.ts` })));
  const srv = createServer(core);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const get = (headers) => new Promise((ok, no) => http.get(`http://127.0.0.1:${srv.address().port}/api/state`, { headers }, (res) => {
    const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => ok({ res, body: Buffer.concat(parts) }));
  }).on('error', no));
  try {
    const zipped = await get({ 'accept-encoding': 'gzip' });
    assert.equal(zipped.res.headers['content-encoding'], 'gzip');
    const st = JSON.parse(zlib.gunzipSync(zipped.body));
    assert.equal(st.channels.length, 300);
    assert.ok(!JSON.stringify(st.channels).includes('/live/user/'));
    const plain = await get({});
    assert.equal(plain.res.headers['content-encoding'], undefined);
    assert.equal(JSON.parse(plain.body).channels.length, 300);
  } finally {
    srv.closeAllConnections(); srv.close(); core.timeshift.stopAll(); core.sharing.stop();
  }
});

test('Guide in parts: favorites and the top first, the rest behind', () => {
  const { DvrCore } = require('../src/core');
  const core = new DvrCore({ dataDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gtv-page-')) });
  core.store.write('sources', [{ id: 's1', type: 'm3u', name: 'P', enabled: true, config: {} }]);
  core.store.write('channels', Array.from({ length: 50 }, (_, i) => ({ id: `s1:${i}`, sourceId: 's1', number: String(i + 1), name: `Ch ${i}`, favorite: i === 30 })));
  const whole = core.getGuide(0, 3600000);
  assert.equal(whole.length, 50);
  assert.equal(whole[0].id, 's1:30'); // pinned first
  assert.equal(whole[0].i, undefined);
  const top = core.guidePage(0, 3600000, { start: 0, count: 10 });
  assert.equal(top.total, 50);
  assert.deepEqual(top.rows.map((r) => r.i), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(top.rows.map((r) => r.id), whole.slice(0, 10).map((r) => r.id));
  const rest = core.guidePage(0, 3600000, { start: 10, count: 100 });
  assert.equal(rest.rows.length, 40);
  const mine = core.guidePage(0, 3600000, { ids: ['s1:45', 's1:2', 'nope'] });
  assert.deepEqual(mine.rows.map((r) => [r.id, r.i]), [['s1:2', 3], ['s1:45', 45]]);
});
