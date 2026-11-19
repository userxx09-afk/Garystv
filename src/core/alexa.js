// Voice control through the Tapper Alexa relay (the alexa/ folder of the Tapper IPTV
// repository): "Alexa, ask Tapper to play ESPN". The same relay and skill serve
// Tapper and GarysTV; whichever TV was linked last is the one Alexa controls.
//
// The relay is set once here, on the engine (Settings > Alexa). Each screen (a Fire TV,
// the PC app, a browser) registers with the relay as its own TV and keeps its own id and
// token. Its requests come through these routes, so the screens never talk to the relay
// themselves (no cross-site requests, and the relay key stays on the engine).
//
// Relay protocol (same as Tapper's AlexaLink.kt):
//   POST /tv/register {name, app} -> {tvId, token}      (X-Tapper-Key when the relay has one)
//   POST /tv/pair                 -> {code, expiresInSec, linked}
//   GET  /tv/status               -> {linked}
//   POST /tv/unlink               -> {ok}
//   GET  /tv/next  (long poll 25s) -> {commands: [{type, query?, number?}]}
//     types: tune, number, channelUp, channelDown, pause, resume, stop, linked,
//            guide, recordings, home, back (the last four need relay 1.0 / alexa/relay)
// Authenticated calls carry X-Tapper-Tv: tvId and Authorization: Bearer token.

class Alexa {
  constructor(core, { env = process.env, fetchImpl = (...a) => fetch(...a) } = {}) {
    this.core = core;
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  get url() { return String((this.core.settings.alexa && this.core.settings.alexa.url) || this.env.ALEXA_RELAY_URL || '').trim().replace(/\/+$/, ''); }
  key() { return String(this.core.settings.alexaKey || this.env.ALEXA_RELAY_KEY || '').trim(); }
  keySource() { return this.core.settings.alexaKey ? 'settings' : this.env.ALEXA_RELAY_KEY ? 'secrets' : null; }
  get configured() { return /^https?:\/\/[^/]/i.test(this.url); }

  overview() { return { configured: this.configured, url: this.url, hasKey: !!this.key(), keyFrom: this.keySource() }; }

  // Settings > Alexa. The key is write-only: screens only learn whether there is one.
  save({ url, key } = {}) {
    if (url !== undefined) {
      const v = String(url || '').trim().replace(/\/+$/, '');
      if (v && !/^https?:\/\/[^/]/i.test(v)) throw new Error('The relay address starts with https://');
      this.core.updateSettings({ alexa: { ...(this.core.settings.alexa || {}), url: v } });
    }
    if (key !== undefined) this.core.updateSettings({ alexaKey: String(key || '').trim() });
    return this.overview();
  }

  async call(method, path, { body, tv, ms = 15000 } = {}) {
    if (!this.configured) throw Object.assign(new Error('Alexa is off: set the relay address in Settings > Alexa.'), { status: 400 });
    const headers = { 'Content-Type': 'application/json' };
    if (this.key()) headers['X-Tapper-Key'] = this.key();
    if (tv) { headers['X-Tapper-Tv'] = String(tv.tvId || ''); headers.Authorization = `Bearer ${String(tv.token || '')}`; }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const res = await this.fetchImpl(this.url + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    } catch (e) {
      throw Object.assign(new Error(`Can't reach the Alexa relay (${e.name === 'AbortError' ? 'no answer' : e.message}).`), { status: 502 });
    } finally {
      clearTimeout(t);
    }
  }

  async register(name) {
    const { status, data } = await this.call('POST', '/tv/register', { body: { name: String(name || 'GarysTV').slice(0, 60), app: 'garystv' } });
    if (status === 403) throw Object.assign(new Error("The relay's key doesn't match. Check the key in Settings > Alexa."), { status: 403 });
    if (status !== 200 || !data || !data.tvId) throw Object.assign(new Error(`The relay answered HTTP ${status}.`), { status: 502 });
    return { tvId: data.tvId, token: data.token };
  }

  // A fresh six-digit code to say to Alexa. Registers this screen first when it has no id
  // yet (or the relay forgot it). -> {code, expiresInSec, linked, tv} (tv: the id to keep).
  async pair({ tv, name } = {}) {
    let creds = tv && tv.tvId && tv.token ? tv : await this.register(name);
    let r = await this.call('POST', '/tv/pair', { tv: creds });
    if (r.status === 401) { creds = await this.register(name); r = await this.call('POST', '/tv/pair', { tv: creds }); }
    if (r.status !== 200 || !r.data || !r.data.code) throw Object.assign(new Error(`The relay answered HTTP ${r.status}.`), { status: 502 });
    return { code: String(r.data.code), expiresInSec: r.data.expiresInSec || 600, linked: !!r.data.linked, tv: creds };
  }

  async status({ tv } = {}) {
    if (!tv || !tv.tvId) return { linked: false, known: false };
    const r = await this.call('GET', '/tv/status', { tv });
    if (r.status === 401) return { linked: false, known: false };
    return { linked: !!(r.data && r.data.linked), known: true };
  }

  async unlink({ tv } = {}) {
    if (tv && tv.tvId) await this.call('POST', '/tv/unlink', { tv }).catch(() => null);
    return { ok: true };
  }

  // Waits (up to ~25s, the relay's long poll) for what Alexa queued for this screen.
  // -> {commands} or {unknown: true} when the relay doesn't know this screen any more.
  async next({ tv } = {}) {
    if (!tv || !tv.tvId) return { unknown: true, commands: [] };
    const r = await this.call('GET', '/tv/next', { tv, ms: 35000 });
    if (r.status === 401) return { unknown: true, commands: [] };
    if (r.status !== 200) throw Object.assign(new Error(`The relay answered HTTP ${r.status}.`), { status: 502 });
    return { commands: clean((r.data && r.data.commands) || []).map((c) => this.resolve(c)) };
  }

  // "play ESPN" / "channel 204": which channel that is here, so every screen agrees.
  resolve(c) {
    if (c.type !== 'tune' && c.type !== 'number') return c;
    const ch = c.type === 'number' ? byNumber(c.number, this.core.channels) : (/^\d+(\.\d+)?$/.test(String(c.query || '').trim()) ? byNumber(c.query.trim(), this.core.channels) : null) || bestMatch(c.query, this.core.channels);
    return ch ? { ...c, channelId: ch.id, channel: [ch.number, ch.name].filter(Boolean).join(' ') } : c;
  }
}

function byNumber(n, channels) {
  const want = String(n);
  const live = channels.filter((c) => !c.hidden);
  return live.find((c) => String(c.number) === want) || live.find((c) => String(c.number).startsWith(`${want}.`)) || null;
}

const TYPES = new Set(['tune', 'number', 'channelUp', 'channelDown', 'pause', 'resume', 'stop', 'linked', 'guide', 'recordings', 'home', 'back']);
function clean(list) {
  return (Array.isArray(list) ? list : []).filter((c) => c && TYPES.has(c.type)).slice(0, 20).map((c) => ({
    type: c.type,
    ...(c.query != null ? { query: String(c.query).slice(0, 100) } : {}),
    ...(Number.isFinite(+c.number) && c.number !== null && c.number !== '' ? { number: +c.number } : {}),
  }));
}

// The channel that best matches what was said: exact name, then starts with, then contains.
// Pinned (favorite) channels win ties, then the shorter name ("ESPN" over "ESPN Deportes").
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/^[a-z]{2,3}\s*[:|-]\s*/, '') // "US: ", "UK | "
    .replace(/\b(fhd|uhd|hd|sd|4k|hevc|east|west)\b|\(.*?\)|\[.*?]/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}
function bestMatch(query, channels) {
  const q = norm(String(query || '').replace(/\b(channel|the)\b/gi, ''));
  if (!q) return null;
  const live = channels.filter((c) => !c.hidden);
  const pick = (list) => list.sort((a, b) => (!!b.favorite - !!a.favorite) || String(a.name).length - String(b.name).length)[0] || null;
  return pick(live.filter((c) => norm(c.name) === q))
    || pick(live.filter((c) => norm(c.name).startsWith(q)))
    || pick(live.filter((c) => norm(c.name).includes(q)));
}

module.exports = { Alexa, bestMatch, byNumber, norm, clean };
