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
