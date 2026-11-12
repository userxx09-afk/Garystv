// My Teams: pick a few teams (Settings > My Teams) and Home shows their next games, with the
// channels each game is likely on.
//
// Schedules, scores and TV networks come from ESPN's public site API (the one espn.com's own pages
// use; no key). Each game is then matched against this GarysTV's channels two ways:
//  - the guide: a listing around the game's start that names the teams ("NFL Football: Bears at
//    Packers") is the surest sign, and the only one for antenna channels named by call sign
//  - the network: ESPN says "FOX" or "ESPN2", and channels with that network in their name carry it
//    (for CBS/FOX/NBC/ABC that can be another city's station showing a different game)
// Streaming-only broadcasts (Peacock, Prime Video, ESPN+...) are listed but have no channel here.
const API = 'https://site.api.espn.com/apis/site/v2/sports';

const LEAGUES = {
  nfl: { label: 'NFL', path: 'football/nfl', words: /\bnfl\b|football/i, pkg: /\bnfl\b/i, hours: 3.5 },
  ncaaf: { label: 'College football', path: 'football/college-football', words: /football|\bncaa/i, pkg: /\bncaaf\b|college football/i, hours: 3.75, groups: 80 },
  nba: { label: 'NBA', path: 'basketball/nba', words: /\bnba\b|basketball/i, pkg: /\bnba\b/i, hours: 2.5 },
  wnba: { label: 'WNBA', path: 'basketball/wnba', words: /\bwnba\b|basketball/i, pkg: /\bwnba\b/i, hours: 2.25 },
  ncaam: { label: 'College basketball (men)', path: 'basketball/mens-college-basketball', words: /basketball|\bncaa/i, pkg: /\bncaa[bm]\b/i, hours: 2.25, groups: 50 },
  ncaaw: { label: 'College basketball (women)', path: 'basketball/womens-college-basketball', words: /basketball|\bncaa/i, pkg: /\bncaa[bw]\b|women/i, hours: 2.25, groups: 50 },
  mlb: { label: 'MLB', path: 'baseball/mlb', words: /\bmlb\b|baseball/i, pkg: /\bmlb\b/i, hours: 3.25 },
  nhl: { label: 'NHL', path: 'hockey/nhl', words: /\bnhl\b|hockey/i, pkg: /\bnhl\b/i, hours: 2.75 },
  mls: { label: 'MLS', path: 'soccer/usa.1', words: /\bmls\b|soccer|f[uú]tbol/i, pkg: /\bmls\b/i, hours: 2 },
};

// TV networks as ESPN names them -> how they show up in channel names.
const NETWORKS = [
  ['CBS', /\bcbs\b(?!\s*(sports|news))/i],
  ['FOX', /(?<!from )\bfox\b(?!\s*(sports|news|business|weather|soul|deportes))/i], // not "LiveNOW from FOX"
  ['NBC', /\bnbc\b(?!\s*(sports|news))/i],
  ['ABC', /\babc\b(?!\s*news)/i],
  ['CW', /\bcw\b/i],
  ['ESPN', /\bespn\b(?!\s*(2|u\b|news|deportes|\+|plus|classic))/i],
  ['ESPN2', /\bespn\s*2\b/i],
  ['ESPNU', /\bespn\s*u\b/i],
  ['ESPNews', /\bespn\s*news\b/i],
  ['ESPN Deportes', /\bespn\s*deportes\b/i],
  ['FS1', /\b(fs1|fox sports 1)\b/i],
  ['FS2', /\b(fs2|fox sports 2)\b/i],
  ['TNT', /\btnt\b/i],
  ['TBS', /\btbs\b/i],
  ['truTV', /\btru\s?tv\b/i],
  ['USA Net', /\busa\b(?!\s*today)/i],
  ['NFL Network', /\bnfl\s*(network|net)\b/i],
  ['NBA TV', /\bnba\s*tv\b/i],
  ['MLB Network', /\bmlb\s*(network|net)\b/i],
  ['NHL Network', /\bnhl\s*(network|net)\b/i],
  ['CBS Sports Network', /\b(cbssn|cbs sports( network)?)\b/i],
  ['Big Ten Network', /\b(btn|big ten( network)?|b1g)\b/i],
  ['SEC Network', /\bsec\s*(network|net|n)\b|\bsecn\b/i],
  ['ACC Network', /\bacc\s*(network|net|n)\b|\baccn\b/i],
  ['Golf Channel', /\bgolf\b/i],
  ['NBC Sports Chicago', /\b(nbc sports chicago|chicago sports network|chsn)\b/i],
  ['Marquee Sports Network', /\bmarquee\b/i],
  ['ION', /\bion\b/i],
];
const STREAMING = /peacock|prime video|amazon|espn\+|espn app|apple tv|netflix|paramount\+|youtube|\bmax\b|nfl\+|league pass|mlb\.tv|nhl\.tv|fubo|dazn|victory\+|\+$|stream/i;

const networkOf = (name) => (NETWORKS.find(([n, re]) => n.toLowerCase() === String(name).toLowerCase() || re.test(name)) || [])[0] || null;
const reOf = (net) => (NETWORKS.find(([n]) => n === net) || [])[1];

// ---------- reading ESPN ----------
function team(c) {
  const t = c.team || {};
  const score = c.score && typeof c.score === 'object' ? c.score.displayValue : c.score;
  return { id: String(t.id || ''), name: t.displayName || t.name || '', short: t.shortDisplayName || t.name || '', nick: t.name || '', location: t.location || '',
    abbr: t.abbreviation || '', logo: t.logo || (t.logos && t.logos[0] && t.logos[0].href) || '', score: score != null && score !== '' ? String(score) : null };
}

function broadcasts(comp) {
  const out = new Map();
  const add = (name, market, kind) => {
    name = String(name || '').trim();
    if (!name || kind === 'radio' || out.has(name)) return;
    out.set(name, { name, market: String(market || '').toLowerCase() || 'national', streaming: kind === 'streaming' || (STREAMING.test(name) && !networkOf(name)) });
  };
  for (const b of comp.broadcasts || []) {
    if (Array.isArray(b.names)) for (const n of b.names) add(n, b.market, null); // scoreboard shape
    else if (b.media) add(b.media.shortName || b.media.name, b.market && (b.market.type || b.market), (b.type && b.type.shortName || '').toLowerCase()); // team schedule shape
  }
  for (const g of comp.geoBroadcasts || []) add(g.media && (g.media.shortName || g.media.name), g.market && g.market.type, (g.type && g.type.shortName || '').toLowerCase());
  return [...out.values()];
}

// One ESPN event -> a game.
function parseEvent(ev, league) {
  const comp = (ev.competitions || [])[0] || {};
  const cs = comp.competitors || [];
  const home = cs.find((c) => c.homeAway === 'home') || cs[0];
  const away = cs.find((c) => c.homeAway === 'away') || cs[1];
  if (!home || !away) return null;
  const st = (comp.status || ev.status || {}).type || {};
  const start = Date.parse(comp.date || ev.date);
  if (!Number.isFinite(start)) return null;
  return { id: `${league}:${ev.id}`, league, leagueLabel: LEAGUES[league].label, start, name: ev.name || '', short: ev.shortName || '',
    state: st.state || 'pre', detail: st.shortDetail || st.detail || '', tbd: comp.timeValid === false, // a date but no time yet
    neutral: !!comp.neutralSite, home: team(home), away: team(away), broadcasts: broadcasts(comp) };
}

// ---------- matching games to channels ----------
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const mentions = (text, t) => [t.name, t.short, t.nick].filter((x) => x && x.length > 2).some((x) => new RegExp(`\\b${fold(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));

// The day an event channel's name says its game is on, if it says one:
// "@ Nov 11 8:00 PM", "start:2026-10-28 00:00:00", "Wed 11 Nov 18:00 EST".
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function nameDay(name, year) {
  const t = fold(name);
  let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})[ t]\d{1,2}:\d{2}/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/); // "11 Nov 18:00"
  if (m) return Date.UTC(year, MONTHS.indexOf(m[2]), +m[1]);
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b(?!:)/); // "Nov 11 8:00 PM", not "Nov 18:00"
  if (m) return Date.UTC(year, MONTHS.indexOf(m[1]), +m[2]);
  return null;
}
// The name names no day, or one within a day of the game (time zones, a late game past midnight).
// Event channels keep an old game's name until the provider renames them, so a different day is stale.
function sameDay(name, start) {
  const d = new Date(start);
  const day = nameDay(name, d.getUTCFullYear());
  if (day == null) return true;
  const gameDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const diff = Math.abs(day - gameDay) / 86400e3;
  return diff <= 1 || diff >= 364; // around New Year the name's year is a guess
}

// channels: [{ id, number, name, group, guideNames[] }]; programsFor(channel) -> its listings.
// -> [{ channelId, number, name, score, why, program }], best first.
function matchChannels(game, channels, programsFor) {
  const L = LEAGUES[game.league];
  const end = game.start + L.hours * 3600e3;
  const nets = game.broadcasts.filter((b) => !b.streaming).map((b) => ({ ...b, net: networkOf(b.name) })).filter((b) => b.net);
  const out = [];
  const now = Date.now();
  const nearGame = now > game.start - 12 * 3600e3 && now < end + 3600e3; // event channels are renamed shortly before
  for (const c of channels) {
    const names = [c.name, ...(c.guideNames || [])].join(' | ');
    const net = nets.find((b) => reOf(b.net).test(names));
    let best = null;
    // The channel's own name: a league package's event channel, renamed for this game.
    const cname = fold(c.name);
    if (sameDay(c.name, game.start) && (nearGame || nameDay(c.name, new Date(game.start).getUTCFullYear()) != null)) {
      const where = `${c.name} ${c.group || ''}`;
      const league = L.pkg.test(where) || L.words.test(cname);
      // Another league's package ("US| MLB PACKAGE") is never this game, whatever its teams are called.
      const otherLeague = !L.pkg.test(where) && Object.entries(LEAGUES).some(([k, o]) => k !== game.league && o.pkg.test(where));
      const h = !otherLeague && mentions(cname, game.home), a = !otherLeague && mentions(cname, game.away);
      if (h && a) best = { score: 95, why: 'the channel is named for this game' };
      else if ((h || a) && league) best = { score: 65, why: `the channel is named for a ${(h ? game.home : game.away).short} game` };
    }
    for (const p of programsFor(c)) {
      if (p.filler || p.end <= game.start - 30 * 60000 || p.start >= end) continue;
      // The game itself, or coverage that began a little earlier (a pregame show running into it).
      if (Math.abs(p.start - game.start) > 75 * 60000 && !(p.start < game.start && p.end > game.start + 60 * 60000)) continue;
      const title = fold(`${p.title} ${p.subtitle || ''}`), desc = fold(p.desc);
      const sport = L.words.test(title);
      const h = mentions(title, game.home), a = mentions(title, game.away);
      let score = 0, why = '';
      if (h && a) { score = 100; why = 'the guide shows this game'; }
      else if ((h || a) && sport) { score = 90; why = 'the guide shows this game'; }
      else if (sport && mentions(desc, game.home) && mentions(desc, game.away)) { score = 85; why = 'the guide shows this game'; }
      else if (sport && net) { score = 70; why = `the guide shows a game at that time, on ${net.net}`; }
      else if (h || a) { score = 60; why = `the guide shows ${(h ? game.home : game.away).short} at that time`; } // second choice: a team named at game time
      if (score && (!best || score > best.score)) best = { score, why, program: { start: p.start, end: p.end, title: p.title, subtitle: p.subtitle || '', desc: p.desc || '', categories: p.categories || [], programId: p.programId || '' } };
    }
    if (!best && net) {
      const national = net.market === 'national' && !/^(CBS|FOX|NBC|ABC|CW|ION)$/.test(net.net);
      best = { score: national ? 75 : 40, why: national ? `${net.net} has this game nationally` : `${net.net} has this game${net.market === 'national' ? '' : ` (${net.market} market)`}, but this station may show a different one` };
    }
    if (best) out.push({ channelId: c.id, number: c.number, name: c.name, ...best });
  }
  return out.sort((x, y) => y.score - x.score || String(x.number).localeCompare(String(y.number), undefined, { numeric: true })).slice(0, 8);
}

class Sports {
  constructor(core, { api = process.env.GTV_SPORTS_API || API, fetchImpl = (...a) => fetch(...a) } = {}) {
    Object.assign(this, { core, api, fetchImpl });
    this.memo = new Map(); // url -> { at, data } for the short-lived answers (scores)
  }

  leagues() { return Object.entries(LEAGUES).map(([id, l]) => ({ id, label: l.label })); }

  get cache() { return this.core.store.read('sportscache', {}); }

  async get(url, keepMs, stored = false) {
    const box = stored ? this.cache : Object.fromEntries(this.memo);
    const hit = box[url];
    if (hit && Date.now() - hit.at < keepMs) return hit.data;
    try {
      const res = await this.fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'GarysTV' }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`ESPN answered ${res.status}`);
      const data = await res.json();
      if (stored) this.core.store.writeSoon('sportscache', { ...this.cache, [url]: { at: Date.now(), data } }).catch(() => {});
      else this.memo.set(url, { at: Date.now(), data });
      return data;
    } catch (e) {
      if (hit) return hit.data; // ESPN down or no internet: what we had is better than nothing
      throw new Error(`Couldn't get sports schedules (${e.message})`);
    }
  }

  // Every team in a league, A-Z.
  async teams(league) {
    const L = LEAGUES[league];
    if (!L) throw Object.assign(new Error('Unknown league'), { status: 400 });
    const data = await this.get(`${this.api}/${L.path}/teams?limit=1000${L.groups ? `&groups=${L.groups}` : ''}`, 14 * 86400e3, true);
    const list = ((((data.sports || [])[0] || {}).leagues || [])[0] || {}).teams || [];
    return list.map(({ team: t }) => ({ league, id: String(t.id), name: t.displayName, short: t.shortDisplayName || t.name, abbr: t.abbreviation || '', logo: (t.logos && t.logos[0] && t.logos[0].href) || '', color: t.color ? `#${t.color}` : '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  myTeams() { return (this.core.settings.sportsTeams || []).filter((t) => LEAGUES[t.league] && t.id); }

  // The next games for my teams (and any on now), each with the channels it's likely on.
  async games() {
    const mine = this.myTeams();
    if (!mine.length) return { teams: [], games: [], errors: [] };
    const now = Date.now();
    const errors = [];
    const games = new Map();
    await Promise.all(mine.map(async (t) => {
      try {
        const data = await this.get(`${this.api}/${LEAGUES[t.league].path}/teams/${encodeURIComponent(t.id)}/schedule`, 3 * 3600e3, true);
        for (const ev of data.events || []) {
          const g = parseEvent(ev, t.league);
          if (g && g.start > now - 6 * 3600e3 && g.start < now + 14 * 86400e3) games.set(g.id, g);
        }
      } catch (e) { errors.push(`${t.name}: ${e.message}`); }
    }));
    // Today's games: fresh scores and status, and the TV networks once they're announced.
    const today = [...new Set([...games.values()].filter((g) => g.start < now + 12 * 3600e3).map((g) => g.league))];
    await Promise.all(today.map(async (league) => {
      const L = LEAGUES[league];
      const day = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
      try {
        const data = await this.get(`${this.api}/${L.path}/scoreboard?dates=${day(now - 12 * 3600e3)}-${day(now + 12 * 3600e3)}&limit=500${L.groups ? `&groups=${L.groups}` : ''}`, 90e3);
        for (const ev of data.events || []) {
          const g = parseEvent(ev, league);
          const had = g && games.get(g.id);
          if (had) games.set(g.id, { ...had, ...g, broadcasts: g.broadcasts.length ? g.broadcasts : had.broadcasts });
        }
      } catch (e) { errors.push(`${L.label} scores: ${e.message}`); }
    }));

    const guideNames = new Map(this.core.guideData.channels.map((c) => [c.id, c.names || []]));
    const channels = this.core.visibleChannels().map((c) => ({ ...c, guideNames: (c.guideId && guideNames.get(c.guideId)) || [] }));
    const programsFor = (c) => this.core.programsFor(c);
    const ids = new Set(mine.map((t) => `${t.league}:${t.id}`));
    const list = [...games.values()]
      .filter((g) => g.state !== 'post' || g.start > now - 4 * 3600e3) // a final score stays up for a while
      .sort((a, b) => a.start - b.start)
      .map((g) => ({ ...g, mine: [g.home, g.away].filter((x) => ids.has(`${g.league}:${x.id}`)).map((x) => x.id), channels: matchChannels(g, channels, programsFor), endGuess: g.start + LEAGUES[g.league].hours * 3600e3 }));
    // Up to four games per team.
    const per = new Map();
    const shown = list.filter((g) => g.mine.some((id) => { const n = per.get(id) || 0; per.set(id, n + 1); return n < 4; }));
    return { teams: mine, games: shown, errors };
  }
}

module.exports = { Sports, LEAGUES, parseEvent, broadcasts, matchChannels, networkOf };
