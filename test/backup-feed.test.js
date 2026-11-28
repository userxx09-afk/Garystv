const test = require('node:test');
const assert = require('node:assert');
const { network, sameShow, findBackup } = require('../src/core/backup-feed');

const H = 3600000;
const now = Date.parse('2026-11-29T01:10:00Z'); // 7:10 PM Central
const at = (h) => Date.parse('2026-11-29T01:00:00Z') + h * H;

test('network: the broadcast network in a channel name, not lookalikes', () => {
  assert.equal(network({ name: 'US| CBS 8 DES MOINES IA (KCCI)' }), 'cbs');
  assert.equal(network({ name: 'TV| A3 NEW YORK 04 WNBC NBC ᴿᴬᵂ' }), 'nbc');
  assert.equal(network({ name: 'US| FOX 5 NEW YORK NY (WNYW)' }), 'fox');
  for (const n of ['US| FOX WEATHER', 'US| NBC SPORTS CHICAGO', 'CBS SPORTS NETWORK', 'NCAAF 05: CBS', 'ABC NEWS LIVE', 'PBS']) {
    if (n === 'PBS') { assert.equal(network({ name: n }), 'pbs'); continue; }
    assert.equal(network({ name: n }), '', n);
  }
});

test('sameShow: same title, same episode or game, same start', () => {
  const a = { title: 'Survivor', start: at(0), end: at(1) };
  assert.ok(sameShow(a, { title: 'Survivor', start: at(0), end: at(1) }));
  assert.ok(!sameShow(a, { title: 'Survivor', start: at(2), end: at(3) })); // West Coast: hours later
  assert.ok(!sameShow(a, { title: 'KCCI 8 News at 6', start: at(0), end: at(1) }));
  const game = { title: 'NFL Football', subtitle: 'Bears at Packers', start: at(0), end: at(3) };
  assert.ok(!sameShow(game, { title: 'NFL Football', subtitle: 'Giants at Eagles', start: at(0), end: at(3) }));
  assert.ok(sameShow(game, { title: 'NFL Football', subtitle: 'Bears at Packers', start: at(0), end: at(3) }));
  assert.ok(!sameShow(game, { title: 'NFL Football', start: at(0), end: at(3) })); // can't tell which game
  // As the guide really lists them (2026-11-28): no episode name, the venue in the description.
  const cfb = (desc) => ({ title: 'Live: College Football', subtitle: '', desc, start: at(0), end: at(3) });
  assert.ok(sameShow(cfb('From Ohio Stadium in Columbus, Ohio.'), cfb('From Ohio Stadium in Columbus, Ohio.')));
  assert.ok(!sameShow(cfb('From Ohio Stadium in Columbus, Ohio.'), cfb('From JMA Dome in Syracuse, N.Y.')));
  assert.ok(!sameShow(cfb('All the action from college football.'), cfb('All the action from college football.'))); // could be regional
  assert.ok(sameShow({ title: 'Survivor', subtitle: 'Blindside', start: at(0) }, { title: 'Survivor', start: at(0) })); // one guide has no episode name
  assert.ok(!sameShow({ title: 'No information', start: at(0) }, { title: 'No information', start: at(0) }));
  assert.ok(!sameShow(a, null));
});

test('findBackup: same network on the favorites list, only when showing the same thing', () => {
  const chans = [
    { id: 's:dsm', sourceId: 's', number: '6861', name: 'US| CBS 8 DES MOINES IA (KCCI)', guideId: 'g|kcci', streamUrl: 'x' },
    { id: 's:la', sourceId: 's', number: '6806', name: 'US| CBS 2 LOS ANGELES CA (KCBS)', guideId: 'g|kcbs', streamUrl: 'x' },
    { id: 's:ny', sourceId: 's', number: '6918', name: 'US| CBS 2 NEW YORK NY (WCBS)', guideId: 'g|wcbs', streamUrl: 'x' },
    { id: 's:abc', sourceId: 's', number: '6700', name: 'US| ABC 7 NEW YORK NY (WABC)', guideId: 'g|wabc', streamUrl: 'x' },
  ];
  const progs = {
    'g|kcci': [{ title: 'Survivor', start: at(0), end: at(1) }],
    'g|kcbs': [{ title: 'Survivor', start: at(-2), end: at(-1) }, { title: 'Local news', start: at(-1), end: at(2) }],
    'g|wcbs': [{ title: 'Survivor', start: at(0), end: at(1) }],
    'g|wabc': [{ title: 'Survivor', start: at(0), end: at(1) }], // not CBS
  };
  const core = { channels: chans, sources: [{ id: 's', enabled: true }], favLists: [{ id: 'f', name: 'Gary', channelIds: ['s:dsm', 's:abc', 's:la', 's:ny'] }],
    programsFor: (c) => progs[c.guideId] || [] };
  assert.equal(findBackup(core, 's:dsm', [], now).channel.id, 's:ny');
  assert.equal(findBackup(core, 's:dsm', ['s:ny'], now), null); // LA is showing something else
  progs['g|wcbs'] = [{ title: 'NCIS', start: at(0), end: at(1) }];
  assert.equal(findBackup(core, 's:dsm', [], now), null);
  progs['g|kcci'] = [];
  assert.equal(findBackup(core, 's:dsm', [], now), null); // no listing: can't check
});

test('live buffer switches to the backup after a real failure, and keeps the viewer on their channel', async () => {
  const { Timeshift } = require('../src/core/timeshift');
  const fs = require('fs'), path = require('path'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-bk-'));
  // A fake ffmpeg: the main feed writes one piece of video then quits at once; the backup keeps going.
  const bin = path.join(dir, 'ffmpeg.js');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2);
const out = a[a.length - 1]; const seg = a[a.indexOf('-hls_segment_filename') + 1].replace('%06d', '000001');
fs.writeFileSync(seg, 'x'); fs.writeFileSync(out, '#EXTM3U\\n#EXTINF:2,\\nseg000001.ts\\n');
if (a.includes('main')) process.exit(1);
let t = 0; setInterval(() => { t += 1e6; process.stdout.write('out_time_us=' + t + '\\n'); }, 100);
`);
  fs.chmodSync(bin, 0o755);
  const claims = [];
  const switched = [];
  const ts = new Timeshift({
    ffmpeg: () => bin, dir: () => path.join(dir, 'buf'), minutes: () => 5,
    input: async (id, s) => ['-i', s.lease.channel.id],
    claim: (id) => { claims.push(id); return { id: `l${claims.length}`, channel: { id } }; },
    unclaim: () => {},
    backup: (id, skip) => (skip.includes('backup') ? null : { id: 'backup' }),
    switched: (id, from, to) => switched.push([id, from, to]),
  });
  try {
    const s = await ts.open('main', 'tv1');
    for (let i = 0; i < 80 && !switched.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual(switched, [['main', 'main', 'backup']]);
    assert.deepStrictEqual(claims, ['main', 'backup']);
    assert.ok(ts.sessions.get('main') === s, 'the viewer still watches "main"');
    assert.equal(s.lease.channel.id, 'backup');
  } finally { ts.stopAll(); }
});
