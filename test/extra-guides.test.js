const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseXmltv } = require('../src/core/guide/xmltv');
const EXTRA = require('../src/core/guide/extra-guides.json');

test('extra-guides.json is well formed', () => {
  assert.ok(Array.isArray(EXTRA.guides) && EXTRA.guides.length);
  const ids = new Set();
  for (const g of EXTRA.guides) {
    assert.ok(g.id && g.name && /^https?:\/\//.test(g.url), `guide ${g.id} needs id, name and url`);
    assert.ok(!ids.has(g.id), `guide id ${g.id} used twice`);
    ids.add(g.id);
    assert.ok(Array.isArray(g.channels) && g.channels.length, `${g.id} lists no channels`);
    for (const c of g.channels) assert.ok(c.name && c.guideId && Array.isArray(c.match) && c.match.length, `${g.id}: ${c.name} needs name, guideId and match`);
  }
});

test('XMLTV: keep only the listed channels', () => {
  const xml = `<tv>
    <channel id="Marquee.Sports.Network.HD.us2"><display-name>Marquee Sports Network HD</display-name></channel>
    <channel id="Other.us2"><display-name>Other</display-name></channel>
    <programme channel="Marquee.Sports.Network.HD.us2" start="20261107180000 +0000" stop="20261107190000 +0000"><title>Cubs 360</title></programme>
    <programme channel="Other.us2" start="20261107180000 +0000" stop="20261107190000 +0000"><title>Something else</title></programme>
  </tv>`;
  const all = parseXmltv(xml);
  assert.equal(all.channels.length, 2);
  const some = parseXmltv(xml, ['Marquee.Sports.Network.HD.us2']);
  assert.deepEqual(some.channels.map((c) => c.id), ['Marquee.Sports.Network.HD.us2']);
  assert.deepEqual(Object.keys(some.programs), ['Marquee.Sports.Network.HD.us2']);
  assert.equal(some.programs['Marquee.Sports.Network.HD.us2'][0].title, 'Cubs 360');
});

test('Extra guides: added once, matched by name, stay removed', () => {
  const { DvrCore } = require('../src/core');
  const core = new DvrCore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-extra-')) });
  core.syncExtraGuides();
  core.syncExtraGuides(); // again: no second copy
  const us2 = EXTRA.guides.find((g) => g.id === 'epgshare-us2');
  const g = core.guides.filter((x) => x.builtin === us2.id);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].config.only, us2.channels.map((c) => c.guideId));

  // As if the listings had been downloaded.
  const gid = g[0].id;
  core.store.write('guidedata', {
    channels: us2.channels.map((c) => ({ id: `${gid}|${c.guideId}`, rawId: c.guideId, names: [c.name], number: '', logo: '', providerId: gid })),
    programs: {},
  });
  const ch = (id, name) => ({ id, sourceId: 's', number: id, name, mapMode: 'auto', guideId: null });
  core.store.write('channels', [
    ch('1398', 'US| MARQUEE SPORTS NETWORK HD'),
    ch('1399', 'US| MARQUEE SPORTS NETWORK OVERFLOW'),
    ch('1738', 'US| MGM+ MARQUEE'),
    { ...ch('1400', 'Marquee Sports Network'), mapMode: 'manual', guideId: 'x|mine' },
  ]);
  core.reconcileChannels();
  const by = Object.fromEntries(core.channels.map((c) => [c.id, c.guideId]));
  assert.equal(by['1398'], `${gid}|Marquee.Sports.Network.HD.us2`);
  assert.equal(by['1399'], `${gid}|Marquee.Sports.Network.Overflow.us2`);
  assert.notEqual(by['1738'] || '', `${gid}|Marquee.Sports.Network.HD.us2`); // MGM+ Marquee is a movie channel
  assert.equal(by['1400'], 'x|mine'); // your own choice is kept

  core.removeGuide(gid);
  core.syncExtraGuides();
  assert.equal(core.guides.filter((x) => x.builtin === us2.id).length, 0);
});

test('free-guides.json: every Free TV channel it lists is in the lineup', () => {
  const FREE = require('../src/core/guide/free-guides.json');
  const LINEUP = require('../src/core/sources/free-channels.json');
  const ids = new Set(LINEUP.channels.map((c) => c.tvgId));
  assert.ok(FREE.guides.length);
  for (const g of FREE.guides) {
    assert.ok(g.id && g.name && /^https?:\/\//.test(g.url), `guide ${g.id} needs id, name and url`);
    for (const c of g.channels) assert.ok(c.guideId && ids.has(c.tvgId), `${g.id}: ${c.name} needs guideId and a lineup tvgId`);
  }
});

test('Free TV guides: only with a Free TV source, matched by tvgId not name', () => {
  const FREE = require('../src/core/guide/free-guides.json');
  const { DvrCore } = require('../src/core');
  const core = new DvrCore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-free-')) });
  const freeIds = FREE.guides.map((g) => g.id).filter((id) => !EXTRA.guides.some((x) => x.id === id));
  core.syncExtraGuides();
  assert.equal(core.guides.filter((g) => freeIds.includes(g.builtin)).length, 0); // no Free TV yet

  core.store.write('sources', [{ id: 'f', type: 'free', name: 'Free TV', enabled: true, config: {} }]);
  core.syncExtraGuides();
  assert.equal(core.guides.filter((g) => freeIds.includes(g.builtin)).length, freeIds.length);
  const rule = FREE.guides[1].channels[0];
  const g = core.guides.find((x) => x.builtin === FREE.guides[1].id);
  assert.ok(g.config.only.includes(rule.guideId));
  const us2 = core.guides.find((x) => x.builtin === 'epgshare-us2');
  assert.ok(us2.config.only.includes('Marquee.Sports.Network.HD.us2')); // shared file keeps its own channels too

  core.store.write('guidedata', { channels: [{ id: `${g.id}|${rule.guideId}`, rawId: rule.guideId, names: [rule.name], number: '', logo: '', providerId: g.id }], programs: {} });
  core.store.write('channels', [
    { id: 'f:1', sourceId: 'f', number: '500', name: rule.name, tvgId: rule.tvgId, mapMode: 'auto', guideId: null },
    { id: 'iptv:1', sourceId: 'x', number: '9000', name: 'Some IPTV channel', tvgId: 'other', mapMode: 'auto', guideId: null },
  ]);
  core.reconcileChannels();
  const by = Object.fromEntries(core.channels.map((c) => [c.id, c]));
  assert.equal(by['f:1'].guideId, `${g.id}|${rule.guideId}`);
  assert.match(by['f:1'].matchReason, /^Free TV guide/);
  assert.notEqual(by['iptv:1'].guideId, `${g.id}|${rule.guideId}`);

  core.removeSource('f'); // Free TV removed: its guides go, US2 stays for Marquee
  assert.equal(core.guides.filter((x) => freeIds.includes(x.builtin)).length, 0);
  assert.ok(core.guides.some((x) => x.builtin === 'epgshare-us2'));
  assert.deepEqual(core.guides.find((x) => x.builtin === 'epgshare-us2').config.only, EXTRA.guides.find((x) => x.id === 'epgshare-us2').channels.map((c) => c.guideId));
});
