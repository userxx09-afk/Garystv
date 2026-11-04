// Which plan each stream uses. An IPTV plan allows so many streams at once (most allow one);
// an antenna box has so many tuners. Watching live TV and recording both use one, and so does
// a linked GarysTV at another location using the same plan (core/peers.js reports those).
// When the plan a channel is on is busy, the same channel on another plan with room is used
// instead (same guide listing, or the same name).
const crypto = require('crypto');

const REMOTE_FRESH_MS = 90000; // a linked server reports every 30s; older than this, it's gone

// How many streams a source allows at once. Free internet channels have no limit, and neither
// does a playlist that doesn't say.
function capacity(src) {
  if (!src || src.type === 'free') return Infinity;
  if (src.type === 'm3u' && !parseInt(src.config && src.config.maxStreams, 10)) return Infinity;
  return src.tunerCount || 1;
}

// The same plan has the same key on every GarysTV (provider, login), without giving the login away.
function planKey(src) {
  const c = src.config || {};
  const where = String(c.servers || c.url || c.host || c.deviceId || '').split(/\s+/).filter(Boolean)
    .map((u) => u.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()).sort().join(' ');
  return crypto.createHash('sha1').update(`${src.type}|${where}|${c.username || ''}`).digest('hex').slice(0, 16);
}

const normName = (s) => String(s || '').toLowerCase().replace(/\b(hd|fhd|uhd|4k|sd|us|usa)\b|[^a-z0-9]/g, '');

class Tuners {
  constructor(core) {
    this.core = core;
    this.uses = new Map(); // lease id -> { id, sourceId, channelId, kind: 'live'|'rec', what, since, onBump }
    this.remote = new Map(); // peer id -> { at, name, uses: [{ plan, kind, what }] }
    this.n = 0;
  }

  source(id) { return this.core.sources.find((s) => s.id === id); }

  // Streams on a plan right now: here, and at linked locations.
  using(src) {
    const here = [...this.uses.values()].filter((u) => u.sourceId === src.id);
    const key = planKey(src);
    const away = [];
    for (const r of this.remote.values()) {
      if (Date.now() - r.at > REMOTE_FRESH_MS) continue;
      for (const u of r.uses) if (u.plan === key) away.push({ ...u, where: r.name });
    }
    return [...here, ...away];
  }

  free(src) { return capacity(src) - this.using(src).length; }

  // The channel, then the same channel on the other plans (enabled ones only).
  // (The scheduler asks this for every upcoming recording, hundreds with a few series timers, so
  // the channels are indexed by guide listing and by name, again only when they change.)
  choices(channelId) {
    const { byId, byGuide, byName } = this.index();
    const ch = byId.get(channelId);
    if (!ch) throw new Error('Channel not found');
    const name = normName(ch.name);
    const seen = new Set([ch.id]);
    const same = [];
    // Same guide listing first, then the same name; each in channel order.
    for (const c of [...((ch.guideId && byGuide.get(ch.guideId)) || []), ...((name.length > 2 && byName.get(name)) || [])]) {
      if (seen.has(c.id) || c.sourceId === ch.sourceId) continue;
      seen.add(c.id);
      same.push(c);
    }
    return [ch, ...same];
  }

  index() {
    const channels = this.core.channels, sources = this.core.sources;
    if (this.idx && this.idx.channels === channels && this.idx.sources === sources) return this.idx;
    const on = new Set(sources.filter((s) => s.enabled).map((s) => s.id));
    const byId = new Map(), byGuide = new Map(), byName = new Map();
    const add = (m, k, c) => { if (!m.has(k)) m.set(k, []); m.get(k).push(c); };
    for (const c of channels) {
      byId.set(c.id, c);
      if (!on.has(c.sourceId) || !c.streamUrl) continue;
      if (c.guideId) add(byGuide, c.guideId, c);
      const n = normName(c.name);
      if (n.length > 2) add(byName, n, c);
    }
    this.idx = { channels, sources, byId, byGuide, byName };
    return this.idx;
  }

  // Takes a plan for a stream of this channel. -> { id, channel } (channel may be the same channel
  // on another plan). kind 'rec' may take a plan from someone watching here (they get a message).
  acquire(channelId, kind, what = '', onBump = null) {
    const list = this.choices(channelId);
    let pick = list.find((c) => this.free(this.source(c.sourceId)) > 0);
    if (!pick && kind === 'rec') {
      for (const c of list) {
        const watching = [...this.uses.values()].find((u) => u.kind !== 'rec' && u.sourceId === c.sourceId);
        if (watching) { this.bump(watching, `Stopped so "${what}" could record`); pick = c; break; }
      }
    }
    if (!pick) {
      // Someone watching at the other place (sharing.js) can be asked to let a recording have the plan.
      const ask = kind !== 'rec' ? [] : list.flatMap((c) => {
        const key = planKey(this.source(c.sourceId));
        return [...this.remote].filter(([, r]) => Date.now() - r.at <= REMOTE_FRESH_MS && r.uses.some((u) => u.plan === key && u.kind !== 'rec')).map(([peerId]) => ({ peerId, plan: key }));
      });
      throw Object.assign(new Error(this.busyMessage(list[0])), { status: 409, ask });
    }
    const id = `t${++this.n}`;
    this.uses.set(id, { id, sourceId: pick.sourceId, channelId: pick.id, kind, what, since: Date.now(), onBump });
    this.core.emit('tuners');
    return { id, channel: pick };
  }

  // A movie or episode: only its own plan has it. Jumping ahead opens a new stream before the old
  // one closes, so a movie already playing on the plan gives way to the new one.
  acquireSource(sourceId, what = '', onBump = null) {
    const src = this.source(sourceId);
    if (!src) throw new Error('Not found');
    if (this.free(src) <= 0) {
      const movie = [...this.uses.values()].find((u) => u.kind === 'vod' && u.sourceId === sourceId);
      if (!movie) throw Object.assign(new Error(this.busyMessage({ sourceId })), { status: 409 });
      this.bump(movie, 'Replaced by another movie stream');
    }
    const id = `t${++this.n}`;
    this.uses.set(id, { id, sourceId, channelId: null, kind: 'vod', what, since: Date.now(), onBump });
    this.core.emit('tuners');
    return { id };
  }

  release(id) {
    if (id && this.uses.delete(id)) this.core.emit('tuners');
  }

  bump(use, why) {
    this.release(use.id);
    this.core.note(`${use.what || 'live TV'}: ${why}`);
    if (use.onBump) use.onBump(why);
  }

  busyMessage(ch) {
    const src = this.source(ch.sourceId);
    const users = this.using(src).map((u) => `${u.kind === 'rec' ? 'recording' : 'watching'} ${u.what || (u.kind === 'vod' ? 'a movie' : 'a channel')}${u.where ? ` at ${u.where}` : ''}`);
    const n = capacity(src);
    return `${src.name} is in use (${n} stream${n === 1 ? '' : 's'} at once): ${users.join(', ') || 'busy'}.${ch.id ? ' No other plan has this channel free.' : ''}`;
  }

  // Each limited plan and what's using it, for Settings > Status.
  overview() {
    return this.core.sources.filter((s) => s.enabled && capacity(s) !== Infinity).map((s) => ({
      name: s.name, capacity: capacity(s),
      using: this.using(s).map((u) => `${u.kind === 'rec' ? 'Recording' : 'Watching'} ${u.what || (u.kind === 'vod' ? 'a movie' : 'a channel')}${u.where ? ` (at ${u.where})` : ''}`),
    }));
  }

  // What this server is using, for linked servers: by plan key, never by login.
  report() {
    return [...this.uses.values()].map((u) => {
      const src = this.source(u.sourceId);
      return src && capacity(src) !== Infinity ? { plan: planKey(src), kind: u.kind, what: u.what } : null;
    }).filter(Boolean);
  }
}

module.exports = { Tuners, capacity, planKey };
