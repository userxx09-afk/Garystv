// Xfinity first: picking a live channel that Xfinity carries opens the Xfinity app on this
// device (Fire TV, Samsung TV) or Xfinity's website (Windows). If Xfinity can't be opened, the
// channel plays in GarysTV as usual. The Xfinity login stays in Xfinity's own app; GarysTV never
// sees it. Set up in Settings > Xfinity (saved on the engine, so every TV shares it).
//
// Xfinity doesn't document a way to open its app straight to a channel. Each device's "link"
// can hold one once it's found on that device; {channel} becomes the Xfinity channel number.
// With no link, the app just opens.
/* global GTVAndroid, tizen, XFINITY_LINEUPS, Modal */
const XFINITY_DEFAULTS = {
  enabled: false,
  channels: {}, // GarysTV channel id -> Xfinity channel number ('' = Xfinity has it, number unknown)
  lineup: 'chicago-popular', // which lineup Gary's suggestions come from (xfinity-lineup.js)
  // garystv: play in GarysTV, and offer Xfinity when a ticked channel won't play here (the default:
  // Xfinity can't be opened on a given channel, so going there first lands on its Home screen).
  // xfinity: open Xfinity first.
  order: 'garystv',
  firetvPackage: 'com.xfinity.cloudtvr.tenfoot',
  firetvLink: '', // e.g. a URI the app accepts; blank = just open the app
  tizenAppId: '', // the Xfinity app's ID on the Samsung TV
  webLink: 'https://www.xfinity.com/stream/live', // Windows and other browsers
};

const Xfinity = {
  failed: false, // opening failed this session: play here without trying again each channel change

  settings() { return { ...XFINITY_DEFAULTS, ...((App.state.settings || {}).xfinity || {}) }; },

  device() {
    if (window.GTVAndroid && GTVAndroid.openApp) return 'firetv';
    if (typeof tizen !== 'undefined' && tizen.application) return 'tizen';
    return 'web';
  },

  // Whether Xfinity can take this channel here (on, ticked in Settings > Xfinity, and this device can open it).
  carries(channel) {
    const s = this.settings();
    if (!s.enabled || this.failed || !channel) return false;
    if (!Object.prototype.hasOwnProperty.call(s.channels, channel.id)) return false;
    const d = this.device();
    if (d === 'tizen') return !!s.tizenAppId;
    if (d === 'firetv') return !!s.firetvPackage;
    return !!s.webLink;
  },

  // Whether picking this channel goes straight to Xfinity (Xfinity first).
  wants(channel) { return this.settings().order === 'xfinity' && this.carries(channel); },

  // GarysTV first: a ticked channel that won't play here. Asks, then opens Xfinity. Answers true if it did.
  async offer(channel, why) {
    if (!this.carries(channel)) return false;
    const num = this.settings().channels[channel.id];
    const v = await Modal.menu(`${channel.number} ${channel.name}`, `<div class="s">${esc(why || 'This channel won\'t play in GarysTV right now.')}<br><br>Xfinity has it${num ? ` (Xfinity ${esc(num)})` : ''}. Xfinity opens on its own Home screen; find the channel there.</div>`,
      [{ label: '▶ Watch in Xfinity', value: 'go', cls: 'primary' }, { label: 'Stay in GarysTV', value: null }]);
    return v === 'go' ? this.tryChannel(channel, true) : false;
  },

  fill(link, channel) {
    const num = String(this.settings().channels[channel.id] || '');
    return link.replace(/\{channel\}/g, encodeURIComponent(num)).replace(/\{name\}/g, encodeURIComponent(channel.name || ''));
  },

  // Opens Xfinity for this channel. Answers true if it opened.
  async open(channel) {
    const s = this.settings();
    try {
      const d = this.device();
      if (d === 'firetv') return !!GTVAndroid.openApp(s.firetvPackage, s.firetvLink ? this.fill(s.firetvLink, channel) : '');
      if (d === 'tizen') {
        return await new Promise((resolve) => tizen.application.launch(s.tizenAppId, () => resolve(true), () => resolve(false)));
      }
      const url = this.fill(s.webLink, channel);
      if (window.GTVDesktop && window.GTVDesktop.openXfinity) return !!(await window.GTVDesktop.openXfinity(url));
      return !!window.open(url, '_blank', 'noopener');
    } catch (_) {
      return false;
    }
  },

  // Used by Player.play for live TV. Answers true when Xfinity took the channel.
  async tryChannel(channel, asked = false) {
    if (!(asked ? this.carries(channel) : this.wants(channel))) return false;
    if (await this.open(channel)) {
      const num = this.settings().channels[channel.id];
      toast(`Opened Xfinity for ${channel.name}${num ? ` (Xfinity ${num})` : ''}`, 4000);
      return true;
    }
    this.failed = true;
    toast(`Couldn't open Xfinity on this ${this.device() === 'web' ? 'PC' : 'TV'}, so ${channel.name} plays in GarysTV. Check Settings > Xfinity.`, 7000);
    return false;
  },

  // ---------- Gary's suggestions ----------
  // Which of this GarysTV's channels look like channels in the Xfinity lineup (xfinity-lineup.js),
  // by name. -> Map(channel id -> { num, label, sure }), at most one channel per Xfinity channel:
  // the provider's own feed over a free stream, HD over SD, a plain name over one with a note
  // in brackets (a backup feed, another city's station). sure: false = only the start of the
  // name matched; worth a look.
  suggest(channels, lineupKey) {
    const key = lineupKey || this.settings().lineup;
    if (this.cache && this.cache.channels === channels && this.cache.key === key) return this.cache.out; // same channel list: same answer
    const lineup = (typeof XFINITY_LINEUPS !== 'undefined' && XFINITY_LINEUPS[key]) || null;
    const out = new Map();
    this.cache = { channels, key, out };
    if (!lineup) return out;
    const freeSources = new Set((App.state.sources || []).filter((s) => s.type === 'free').map((s) => s.id));
    const city = lineup.city || '';
    const norm = (n) => String(n).replace(/^[^|]*\|\s*/, '').replace(/[^\x20-\x7E]/g, ' ').toUpperCase()
      .replace(/\([^)]*\)/g, ' ').replace(/\b(FHD|UHD|HD|SD|4K|8K|HEVC|EAST)\b/g, ' ').replace(/\s+/g, ' ').trim();
    // Streaming-service, event and team channels share names with real ones; leave them out.
    const skip = /PPV|PACKAGE|VIP|EVENT|\bTEAMS?\b|\bVS\.?\b|@|CINEMANIA|NETFLIX|TUBI|PLUTO|PRIME|PEACOCK|PARAMOUNT\+|HULU|DISNEY\+|HBO MAX|SPECTRUM|FLO |MILB|NFHS|DAZN|FITE|VICTORY|ESPN ?PLUS|ESPN\+|ESPN PLAY|B1G\+|BTN\+|FIFA|DIRTVISION|VIAPLAY|VIX|APPLE TV|B\/R|TENNIS CHANNEL PLUS|\bWEST\b|PACIFIC|ESPA[NÑ]OL|SPANISH|LATINO|DEPORTES/i;
    const cands = channels.filter((c) => !c.hidden && !/^#/.test(c.name) && !skip.test(`${c.group || ''} ${c.name}`))
      .map((c) => ({ c, n: norm(c.name), raw: ` ${String(c.name).toUpperCase().replace(/[^\x20-\x7E]/g, ' ')} `, free: freeSources.has(c.sourceId) }));
    for (const [num, label, ...names] of lineup.channels) {
      const tests = names.map((a) => ({ a, call: /^[WK][A-Z]{2,3}$/.test(a), word: new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\!&]/g, '\\$&')}\\b`) }));
      let best = null;
      for (const k of cands) {
        let score = 0;
        for (const { a, call, word } of tests) {
          if (call) { if (city && k.raw.includes(city) && word.test(k.raw)) score = Math.max(score, 100); continue; } // call sign: this city's only
          if (k.n === a) score = Math.max(score, 100);
          else if (a.length >= 5 && k.n.startsWith(a) && word.test(k.n)) score = Math.max(score, 60);
        }
        if (!score) continue;
        score += (k.free ? 0 : 2) + (/\bHD\b/.test(k.raw) ? 1 : 0) - (/\(/.test(k.c.name) && !k.raw.includes(city) ? 3 : 0);
        if (!best || score > best.score) best = { k, score };
      }
      if (best && !out.has(best.k.c.id)) out.set(best.k.c.id, { num: String(num), label, sure: best.score >= 95 });
    }
    return out;
  },

  // For Settings: whether the Xfinity app is on this device (null = can't tell here).
  installed() {
    const d = this.device();
    if (d === 'firetv' && GTVAndroid.hasApp) return !!GTVAndroid.hasApp(this.settings().firetvPackage);
    return null;
  },
};
