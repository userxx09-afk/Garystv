// IPTV providers that publish an M3U playlist (most do, including Xtream-style
// panels via their "get.php?...&type=m3u_plus" link).
const fs = require('fs');

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

function parseM3u(text) {
  const lines = text.split(/\r?\n/);
  const header = lines[0] && lines[0].startsWith('#EXTM3U') ? parseAttrs(lines[0]) : {};
  const channels = [];
  let pending = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.lastIndexOf(',');
      const attrs = parseAttrs(line.slice(0, comma));
      pending = { attrs, title: line.slice(comma + 1).trim() };
    } else if (!line.startsWith('#') && pending) {
      const a = pending.attrs;
      channels.push({
        key: a['tvg-id'] || a['tvg-name'] || pending.title || line,
        number: a['tvg-chno'] || a['channel-number'] || '',
        name: pending.title || a['tvg-name'] || 'Channel',
        tvgId: a['tvg-id'] || '',
        logo: a['tvg-logo'] || '',
        group: a['group-title'] || '',
        streamUrl: line,
      });
      pending = null;
    }
  }
  return { epgUrl: header['url-tvg'] || header['x-tvg-url'] || '', channels };
}

async function loadText(location) {
  if (/^https?:\/\//i.test(location)) {
    const res = await fetch(location, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Playlist download failed (${res.status})`);
    return res.text();
  }
  return fs.promises.readFile(location, 'utf8');
}

module.exports = {
  type: 'm3u',
  label: 'IPTV provider (M3U playlist)',
  fields: [
    { key: 'url', label: 'Playlist URL or file', placeholder: 'http://provider/get.php?...&type=m3u_plus' },
    { key: 'groups', label: 'Only these groups (comma separated, optional)', placeholder: 'USA, Sports' },
    { key: 'maxStreams', label: 'Streams allowed at once', placeholder: '2' },
  ],
  parseM3u,
  loadText,

  async scan(config) {
    if (!config.url) throw new Error('Enter the playlist URL from your IPTV provider.');
    const { epgUrl, channels } = parseM3u(await loadText(config.url));
    const groups = (config.groups || '').split(',').map((g) => g.trim().toLowerCase()).filter(Boolean);
    const kept = groups.length ? channels.filter((c) => groups.includes(c.group.toLowerCase())) : channels;
    return {
      config,
      epgUrl,
      tunerCount: parseInt(config.maxStreams, 10) || 1,
      info: `${kept.length} channels${groups.length ? ` (of ${channels.length})` : ''}`,
      channels: kept,
    };
  },
};
