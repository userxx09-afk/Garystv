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
