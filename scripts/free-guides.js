// Finds guide listings for the built-in Free TV channels (src/core/sources/free-channels.json)
// in public XMLTV files (epgshare01 and i.mjh.nz carry the Plex, Roku, Pluto and Samsung TV Plus
// schedules most of these channels are on) and writes src/core/guide/free-guides.json. The engine
// adds those files like the extra guides, keeps only these channels from them, and matches each
// one by its tvgId, so a channel with the same name from an IPTV plan isn't affected.
// Run: npm run free-guides (npm run free-channels runs it too).
const fs = require('fs');
const path = require('path');
const { parseXmltv } = require('../src/core/guide/xmltv');
const zlib = require('zlib');

const LINEUP = require('../src/core/sources/free-channels.json');
const OUT = path.join(__dirname, '..', 'src', 'core', 'guide', 'free-guides.json');

// In order of preference: a channel takes its listings from the first file that has it with
// at least a day ahead. epgshare-us2 is already downloaded for the extra guides, so it's first.
const FILES = [
  { id: 'epgshare-us2', name: 'Extra guide (epgshare01 US2)', url: 'https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz' },
  { id: 'free-plex', name: 'Free TV guide (Plex)', url: 'https://epgshare01.online/epgshare01/epg_ripper_PLEX1.xml.gz' },
  { id: 'free-roku', name: 'Free TV guide (Roku)', url: 'https://i.mjh.nz/Roku/all.xml.gz' },
  { id: 'free-pluto', name: 'Free TV guide (Pluto)', url: 'https://i.mjh.nz/PlutoTV/us.xml.gz' },
  { id: 'free-samsung', name: 'Free TV guide (Samsung TV Plus)', url: 'https://i.mjh.nz/SamsungTVPlus/us.xml.gz' },
  { id: 'free-distro', name: 'Free TV guide (DistroTV)', url: 'https://epgshare01.online/epgshare01/epg_ripper_DISTROTV1.xml.gz' },
];

// The lineup's name -> the name a guide file uses, where they differ.
const ALIASES = {
  'bon appetit': ['Bon Appétit TV'],
  'FIFA+ United States': ['FIFA+'],
  FNX: ['FNX First Nations Experience'],
  'NTD TV English': ['NTD News'],
  'The Young Turks': ['TYT The Young Turks'],
  Wired2FishTV: ['Wired2Fish'],
  'Curiosity NOW EN': ['Curiosity NOW'],
  'MovieSphere Gold WFXT': ['MovieSphere Gold'],
  'Roar KOKI-TV': ['ROAR TV'],
  'Samsung Wildlife': ['Samsung Wild Life'],
  'Tennis Channel': ['Tennis Channel HD'],
  'Outside TV': ['Outside'],
  'Dry Bar Comedy+': ['Dry Bar Comedy'],
  'Mr Bean Animated': ['Mr. Bean Animated'],
};
// Free feeds of local stations are mostly their own newscasts, not the broadcast schedule a
// guide lists, so they're left without one rather than shown the wrong shows.
const SKIP = (c) => c.category === 'Iowa & Midwest locals';

const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(the|tv|channel|network|us|usa|hd|east|west)\b/g, '').replace(/[^a-z0-9]/g, '');

async function load(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return parseXmltv(buf.toString('utf8'));
}

(async () => {
  const now = Date.now();
  const files = [];
  for (const f of FILES) {
    try {
      const data = await load(f.url);
      const byName = new Map();
      for (const c of data.channels) {
        const list = data.programs[c.id] || [];
        const hoursAhead = list.length ? (list[list.length - 1].end - now) / 3600000 : 0;
        if (hoursAhead <= 0) continue; // no listings left
        for (const n of c.names) { const k = norm(n); if (k && !byName.has(k)) byName.set(k, { id: c.id, name: c.names[0], hoursAhead }); }
      }
      files.push({ ...f, byName });
      console.log(`${f.id}: ${data.channels.length} channels`);
    } catch (e) {
      console.log(`${f.id}: skipped (${e.message})`);
    }
  }
  const picked = new Map(files.map((f) => [f.id, []]));
  const missing = [];
  for (const c of LINEUP.channels) {
    if (SKIP(c)) continue;
    const keys = [c.name, ...(ALIASES[c.name] || [])].map(norm);
    const hits = files.map((f) => ({ f, hit: keys.map((k) => f.byName.get(k)).find(Boolean) })).filter((x) => x.hit);
    const best = hits.find((x) => x.hit.hoursAhead >= 24) || hits.sort((a, b) => b.hit.hoursAhead - a.hit.hoursAhead)[0];
    if (!best) { missing.push(c.name); continue; }
    picked.get(best.f.id).push({ name: c.name, guideId: best.hit.id, tvgId: c.tvgId });
  }
  const guides = files.filter((f) => picked.get(f.id).length).map((f) => ({ id: f.id, name: f.name, url: f.url, freeTv: true, channels: picked.get(f.id) }));
  const found = guides.reduce((n, g) => n + g.channels.length, 0);
  fs.writeFileSync(OUT, JSON.stringify({
    about: 'Built by `npm run free-guides`: where each Free TV channel gets its listings. Each channel is matched by its tvgId (from free-channels.json); guideId is its <channel id> in that file. Do not edit by hand; add aliases or files in scripts/free-guides.js instead.',
    updated: new Date().toISOString().slice(0, 10),
    guides,
  }, null, 1) + '\n');
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${found} channels with listings from ${guides.length} files`);
  for (const g of guides) console.log(`  ${g.id}: ${g.channels.length}`);
  console.log(`No listings (${missing.length}): ${missing.join(', ')}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
