// Backup feeds for live TV. Some IPTV feeds of a network channel die or freeze for minutes at a
// time; another feed of the same network (New York's CBS for Des Moines' CBS) usually still plays.
// When the live buffer (timeshift.js) has real trouble, it asks here for a backup, and only gets
// one when the guide says the backup is showing the same thing right now. Local news, and NFL
// games that differ by region, never match, so the viewer is never moved to a different show.
const { normTitle } = require('./scheduler');

const NETWORKS = [
  ['cbs', /\bCBS\b/i], ['abc', /\bABC\b/i], ['nbc', /\bNBC\b/i], ['fox', /\bFOX\b/i], ['pbs', /\bPBS\b/i],
  ['cw', /\bCW\b/i], ['mynetwork', /\bMY ?(NETWORK|TV)\b|\bMNT\b/i], ['telemundo', /\bTELEMUNDO\b/i], ['univision', /\bUNIVISION\b/i], ['ion', /\bION\b/i],
];
// Channels whose names carry a network's letters but aren't the network itself.
const NOT_NETWORK = /\b(NEWS|SPORTS?|BUSINESS|WEATHER|DEPORTES|SOCCER|LIFE|SOUL|COMEDY|LOCALISH|LX|LIVE ?NOW|NFL|NCAA\w*|NBA|MLB|NHL|PPV|ESPN)\b/i;

// The broadcast network a channel carries, or '' when it isn't one (or carries more than one).
function network(ch) {
  const name = String((ch && ch.name) || '');
  if (NOT_NETWORK.test(name)) return '';
  const hits = NETWORKS.filter(([, re]) => re.test(name)).map(([n]) => n);
  return hits.length === 1 ? hits[0] : '';
}

const onNow = (programs, now) => (programs || []).find((p) => p.start <= now && p.end > now && !p.filler) || null;

// Games: networks show different games in different regions under the same title ("Live: College
// Football", often without an episode name), so a game only matches when the listing says which
// game it is (teams or venue) and that's the same on both.
const SPORT = /football|basketball|baseball|hockey|soccer|\b(nfl|nba|mlb|nhl|mls|ncaa\w*|wnba|ufc|pga|lpga|nascar|indycar|f1)\b|game|bowl|racing|golf|tennis|boxing|wrestling|playoffs?|championship/i;
const isSport = (p) => SPORT.test(`${p.title} ${p.subtitle || ''}`) || (p.categories || []).some((c) => /sport/i.test(c));
const which = (p) => {
  const sub = String(p.subtitle || '').trim();
  if (sub) return normTitle(sub);
  const d = String(p.desc || '').trim();
  return /^from\s|\s(at|vs\.?|versus)\s/i.test(d) ? normTitle(d) : ''; // "From Ohio Stadium in Columbus", "Iowa at Nebraska"
};

// Same show: same title, started within 10 minutes of each other (a show that airs at a different
// hour elsewhere is at a different point, so it isn't "the same thing"), the same episode when both
// listings name one, and for games the same game.
function sameShow(a, b) {
  if (!a || !b) return false;
  const t = normTitle(String(a.title || '').replace(/^live:\s*/i, ''));
  if (!t || t !== normTitle(String(b.title || '').replace(/^live:\s*/i, '')) || /^(noinformation|tobeannounced|tba)$/.test(t)) return false;
  if (Math.abs((a.start || 0) - (b.start || 0)) > 10 * 60000) return false;
  if (isSport(a) || isSport(b)) { const w = which(a); return !!w && w === which(b); }
  if (a.subtitle && b.subtitle && normTitle(a.subtitle) !== normTitle(b.subtitle)) return false;
  return true;
}

// A backup for channelId: a channel of the same network on the viewer's favorites lists (the lists
// with this channel first, in list order), showing the same thing now. skip: channel ids already tried.
// -> { channel, program } or null
function findBackup(core, channelId, skip = [], now = Date.now()) {
  const byId = new Map(core.channels.map((c) => [c.id, c]));
  const ch = byId.get(channelId);
  const net = network(ch);
  if (!net) return null;
  const mine = onNow(core.programsFor(ch), now);
  if (!mine) return null; // no listing: there's no way to check a backup shows the same thing
  const enabled = new Set(core.sources.filter((s) => s.enabled).map((s) => s.id));
  const lists = [...(core.favLists || [])].sort((x, y) => y.channelIds.includes(channelId) - x.channelIds.includes(channelId));
  const pool = [...lists.flatMap((l) => l.channelIds), ...core.channels.filter((c) => c.favorite).map((c) => c.id)];
  const seen = new Set([channelId, ...skip]);
  for (const id of pool) {
    if (seen.has(id)) continue;
    seen.add(id);
    const c = byId.get(id);
    if (!c || !c.streamUrl || !enabled.has(c.sourceId) || network(c) !== net) continue;
    const p = onNow(core.programsFor(c), now);
    if (sameShow(mine, p)) return { channel: c, program: p };
  }
  return null;
}

module.exports = { network, sameShow, findBackup };
