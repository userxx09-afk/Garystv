// Built-in free channels: news, weather, movies, kids and Midwest locals that their owners
// (or licensed free services like Tubi, Xumo and Stirr) stream openly. The lineup lives in
// free-channels.json, built by `npm run free-channels`. Each scan quickly re-checks the
// streams and leaves out any that are down, so dead channels don't clutter the guide.
const LINEUP = require('./free-channels.json');

async function alive(url, ms = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await r.text();
    return r.ok && text.includes('#EXTM3U');
  } catch (_) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  type: 'free',
  label: 'Free TV channels (news, weather, movies & more)',
  fields: [],
  async scan(config) {
    const up = new Set();
    let next = 0;
    await Promise.all(Array.from({ length: 24 }, async () => {
      while (next < LINEUP.channels.length) {
        const c = LINEUP.channels[next++];
        if (await alive(c.url)) up.add(c);
      }
    }));
    // No internet right now: keep the whole lineup rather than emptying the guide.
    const offline = up.size < LINEUP.channels.length * 0.2;
    const list = offline ? LINEUP.channels : LINEUP.channels.filter((c) => up.has(c));
    const down = LINEUP.channels.length - list.length;
    return {
      config,
      tunerCount: 6, // internet streams: limited only by the connection
      info: offline ? `${list.length} channels (couldn't check them - no internet?)` : `${list.length} channels${down ? `, ${down} off the air right now` : ''}`,
      channels: list.map((c) => ({ key: c.tvgId || c.name, number: c.number, name: c.name, city: c.city, logo: c.logo, group: c.category, tvgId: c.tvgId, hd: true, streamUrl: c.url })),
    };
  },
};
