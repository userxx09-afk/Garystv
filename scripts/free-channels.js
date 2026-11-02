// Builds the built-in "Free TV" lineup (src/core/sources/free-channels.json) from iptv-org's
// US playlist. Only streams served by the channel's owner or a licensed free service are used
// (no re-broadcasts from unknown servers), and each one must stream on two separate checks.
// Run: npm run free-channels
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { bestVariant, HLS_INPUT } = require('../src/core/hls');
const { findFfmpeg } = require('../src/core/tools');

const SOURCE = 'https://iptv-org.github.io/iptv/countries/us.m3u';
const OUT = path.join(__dirname, '..', 'src', 'core', 'sources', 'free-channels.json');

// Owner sites and licensed free services (Tubi, Xumo, Stirr, Samsung TV Plus, Plex, Roku and the
// Amagi / Wurl / Xumo platforms they stream from).
const LICENSED = /(amagi\.tv|wurl\.(com|tv)|tubi\.video|xumo|cbsnews\.com|cbsivideo\.com|abcnews-streams\.akamaized\.net|foxweather\.com|twc-tv\.com|bloomberg\.com|pbs\.org|pbskids\.org|stirr|samsung|plex|roku)/i;

// Iowa first, then nearby Midwest stations (their free feeds are mostly local news).
const LOCALS = [
  [/@KAAL/, 'KAAL ABC 6 - Mason City / Austin'],
  [/@KCCI/, 'KCCI CBS 8 - Des Moines'],
  [/@WHO/, 'WHO NBC 13 - Des Moines'],
  [/@WOI/, 'WOI ABC 5 - Des Moines'],
  [/@KDSM/, 'KDSM FOX 17 - Des Moines'],
  [/@KCRG/, 'KCRG ABC 9 - Cedar Rapids'],
  [/@KGAN/, 'KGAN CBS 2 - Cedar Rapids'],
  [/@KWWL/, 'KWWL NBC 7 - Waterloo'],
  [/@KWQC/, 'KWQC NBC 6 - Quad Cities'],
  [/@WQAD/, 'WQAD ABC 8 - Quad Cities'],
  [/@KTIV/, 'KTIV NBC 4 - Sioux City'],
  [/@KCAU/, 'KCAU ABC 9 - Sioux City'],
  [/@KIMT/, 'KIMT CBS 3 - Mason City'],
  [/@KSTP/, 'KSTP ABC 5 - Minneapolis'],
  [/@WDIO/, 'WDIO ABC 10 - Duluth'],
  [/@WMAQ/, 'WMAQ NBC 5 - Chicago'],
  [/@WITI/, 'WITI FOX 6 - Milwaukee'],
  [/@WISN/, 'WISN ABC 12 - Milwaukee'],
  [/@WTMJ/, 'WTMJ NBC 4 - Milwaukee'],
  [/@WGBA/, 'WGBA NBC 26 - Green Bay'],
];

// DISH-style number blocks. First matching rule wins.
const BLOCKS = [
  { start: 100, name: 'Iowa & Midwest locals' }, // filled from LOCALS
  { start: 200, name: 'News', test: (c) => /News|LiveNOW|Reuters|USA TODAY|Newsmax|OAN|Real America|Salem News|Young Turks|NTD|The First|CNN|Bloomberg Originals$/i.test(c.name) || /^News/.test(c.group) },
  { start: 250, name: 'Weather', test: (c) => /Weather/.test(c.group) },
  { start: 300, name: 'Sports & outdoors', test: (c) => /Sports|Outdoor|Auto/.test(c.group) || /Wired2Fish|PowerNation/.test(c.name) },
  { start: 400, name: 'Movies', test: (c) => /Movies|Classic/.test(c.group) || /Hi-YAH|Tribeca|Stories by AMC/.test(c.name) },
  { start: 600, name: 'Kids & family', test: (c) => /Kids|Animation|Family/.test(c.group) || /Love Pets/.test(c.name) },
  { start: 700, name: 'PBS, documentaries & lifestyle', test: (c) => /Education|Documentary|Lifestyle|Cooking|Travel|Culture/.test(c.group) || /Wild|Homeful|Wildlife/.test(c.name) },
  { start: 800, name: 'Music', test: (c) => /Music/.test(c.group) },
  { start: 500, name: 'Entertainment', test: () => true },
];

const SKIP = [
  /Religious|Shop/, // categories
  /Espa[nñ]ol|Estrella|LATV|Telemundo|Romantico|Latino|K-POP|K\.MOVIES|Bollywood|RTVi/i, // not English
  /Live Event|Originals SD|PBS Kids (Alaska|Hawaii|Mountain|Pacific)|PBS (KMOS|KQED|KVIE|WEDQ)|World Channel WGTV/i, // event-only feeds and duplicates
  /News12|WSOC Now|CBS News (Baltimore|Miami|Sacramento)|KNXV|MNT WFLD|INFAST|Impact Network|Wu Tang|WCVB/i, // other cities' local news, duplicates, misc
];
// A network station elsewhere in the country, e.g. "NBC WBAL-TV" (but not "PBS Kids").
const OTHER_MARKET = /^(ABC|CBS|NBC|FOX|PBS) [KW][A-Z]{2,3}\b/;

function parse(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF')) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith('#')) j++;
    const attr = (k) => (lines[i].match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
    out.push({
      name: lines[i].replace(/.*,/, '').replace(/\s*\((\d+p)\)/, '').replace(/\s*\[[^\]]*\]/g, '').replace(/^Fox \(United States\)/, 'FOX').trim(),
      rawName: lines[i].replace(/.*,/, ''),
      tvgId: attr('tvg-id'), logo: attr('tvg-logo'), group: attr('group-title') || 'Undefined', url: lines[j],
    });
  }
  return out;
}

async function get(url, ms = 9000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return { ok: r.ok, url: r.url, buf: Buffer.from(await r.arrayBuffer()) };
  } catch (_) { return { ok: false }; } finally { clearTimeout(t); }
}
const firstUri = (text, base) => {
  const l = text.split(/\r?\n/).find((x) => x && !x.startsWith('#'));
  return l ? new URL(l.trim(), base).href : null;
};
// Streams if the playlist, a variant and a real video segment all load.
async function streams(url) {
  const m = await get(url);
  if (!m.ok) return false;
  let text = m.buf.toString(), base = m.url;
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const v = await get(firstUri(text, base));
    if (!v.ok) return false;
    text = v.buf.toString(); base = v.url;
  }
  const seg = firstUri(text, base);
  const s = seg && await get(seg, 12000);
  return !!(s && s.ok && s.buf.length > 20000);
}
async function check(list) {
  const ok = new Set();
  let next = 0;
  await Promise.all(Array.from({ length: 20 }, async () => {
    while (next < list.length) { const c = list[next++]; if (await streams(c.url)) ok.add(c); }
  }));
  return list.filter((c) => ok.has(c));
}

// Last check: ffmpeg (what the app plays and records with) must get real video out of it.
function ffmpegPlays(ffmpeg, url) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...HLS_INPUT, '-i', url, '-t', '4', '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'mpegts', 'pipe:1']);
    let bytes = 0;
    p.stdout.on('data', (d) => { bytes += d.length; });
    p.stderr.resume();
    const t = setTimeout(() => p.kill(), 25000);
    p.on('close', () => { clearTimeout(t); resolve(bytes > 100000); });
  });
}
async function playable(list) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) { console.log('(ffmpeg not found; skipping the player check)'); return list; }
  const ok = new Set();
  let next = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (next < list.length) { const c = list[next++]; if (await ffmpegPlays(ffmpeg, await bestVariant(c.url))) ok.add(c); }
  }));
  return list.filter((c) => ok.has(c));
}

(async () => {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`iptv-org returned ${res.status}`);
  const all = parse(await res.text());
  const cands = all.filter((c) => /^https:/.test(c.url) && LICENSED.test(c.url) && !/Not 24\/7/.test(c.rawName));
  const keep = cands.filter((c) => LOCALS.some(([re]) => re.test(c.tvgId)) || (!OTHER_MARKET.test(c.name) &&!SKIP.some((re) => re.test(`${c.group} ${c.name}`))));
  console.log(`${all.length} channels in iptv-org US, ${cands.length} from owners/licensed services, ${keep.length} fit the lineup`);
  const pass1 = await check(keep);
  await new Promise((r) => setTimeout(r, 60000)); // second check a minute later weeds out flaky streams
  const both = await check(pass1);
  const stable = await playable(both);
  console.log(`${pass1.length} streamed on the first check, ${both.length} on both, ${stable.length} play in the app's player (ffmpeg)`);

  const seen = new Set();
  const lineup = [];
  const next = {};
  for (const [re, name] of LOCALS) {
    const c = stable.find((x) => re.test(x.tvgId));
    const [short, city] = name.split(' - '); // short name fits the guide's channel column
    if (c) { seen.add(c); lineup.push({ ...c, name: short, city, category: BLOCKS[0].name, number: String(101 + lineup.length) }); }
  }
  for (const c of stable.sort((a, b) => a.name.localeCompare(b.name))) {
    if (seen.has(c) || seen.has(c.name)) continue;
    if (!LOCALS.some(([re]) => re.test(c.tvgId)) && OTHER_MARKET.test(c.name)) continue;
    const b = BLOCKS.slice(1).find((x) => x.test(c));
    next[b.start] = (next[b.start] || b.start) + 1;
    seen.add(c.name);
    lineup.push({ ...c, category: b.name, number: String(next[b.start]) });
  }
  const channels = lineup.map(({ name, city, number, category, tvgId, logo, url }) => ({ number, name, ...(city ? { city } : {}), category, tvgId, logo, url }));
  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), source: SOURCE, channels }, null, 1) + '\n');
  console.log(`Wrote ${channels.length} channels to ${path.relative(process.cwd(), OUT)}`);
  for (const b of BLOCKS) console.log(`  ${b.start}s ${b.name}: ${channels.filter((c) => c.category === b.name).length}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
