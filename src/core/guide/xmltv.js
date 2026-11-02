// XMLTV guide data: the common format used by Schedules Direct tools,
// zap2xml-style grabbers and most IPTV providers' EPG links.
const fs = require('fs');
const zlib = require('zlib');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => ['channel', 'programme', 'display-name', 'category', 'episode-num', 'icon', 'title', 'sub-title', 'desc', 'rating'].includes(name),
});

const txt = (v) => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();
const first = (arr) => (Array.isArray(arr) ? arr[0] : arr);

// "20261027200000 -0500" -> epoch ms. No offset means UTC.
function parseTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(String(s).trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi, sec = '00', off = '+0000'] = m;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
  const sign = off[0] === '-' ? -1 : 1;
  const offMin = sign * (parseInt(off.slice(1, 3), 10) * 60 + parseInt(off.slice(3), 10));
  return utc - offMin * 60000;
}

function parseEpisode(nums) {
  const out = {};
  for (const n of nums || []) {
    const system = n['@_system'];
    const v = txt(n);
    if (system === 'xmltv_ns') {
      const [s, e] = v.split('.').map((p) => p.split('/')[0].trim());
      if (s !== '' && !isNaN(s)) out.season = parseInt(s, 10) + 1;
      if (e !== '' && !isNaN(e)) out.episode = parseInt(e, 10) + 1;
    } else if (system === 'onscreen') {
      const m = /S(\d+)\s*E(\d+)/i.exec(v);
      if (m && out.season == null) { out.season = +m[1]; out.episode = +m[2]; }
    } else if (system === 'dd_progid') {
      out.programId = v;
      const m = /^(EP|SH|MV|SP)(\d+)/.exec(v);
      if (m) out.seriesId = m[2];
    }
  }
  return out;
}

function parseXmltv(xml) {
  const tv = parser.parse(xml).tv || {};
  const channels = (tv.channel || []).map((c) => {
    const names = (c['display-name'] || []).map(txt).filter(Boolean);
    return {
      id: c['@_id'],
      names,
      number: names.find((n) => /^\d+([.-]\d+)?$/.test(n)) || txt(c.lcn) || '',
      logo: (first(c.icon) || {})['@_src'] || '',
    };
  });
  const programs = {};
  for (const p of tv.programme || []) {
    const ch = p['@_channel'];
    const ep = parseEpisode(p['episode-num']);
    const prog = {
      start: parseTime(p['@_start']),
      end: parseTime(p['@_stop']),
      title: txt(first(p.title)),
      subtitle: txt(first(p['sub-title'])),
      desc: txt(first(p.desc)),
      categories: (p.category || []).map(txt),
      season: ep.season ?? null,
      episode: ep.episode ?? null,
      programId: ep.programId || '',
      seriesId: ep.seriesId || '',
      isNew: p.new !== undefined || p.premiere !== undefined,
      rating: txt(first(p.rating)?.value),
      icon: (first(p.icon) || {})['@_src'] || '',
    };
    if (!prog.title || isNaN(prog.start)) continue;
    if (isNaN(prog.end)) prog.end = prog.start + 30 * 60000;
    (programs[ch] ||= []).push(prog);
  }
  for (const list of Object.values(programs)) list.sort((a, b) => a.start - b.start);
  return { channels, programs };
}

async function loadXmltv(location) {
  let buf;
  if (/^https?:\/\//i.test(location)) {
    const res = await fetch(location, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Guide download failed (${res.status})`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    buf = await fs.promises.readFile(location);
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return parseXmltv(buf.toString('utf8'));
}

module.exports = {
  type: 'xmltv',
  label: 'XMLTV guide (URL or file)',
  fields: [{ key: 'url', label: 'Guide URL or file (.xml or .xml.gz)', placeholder: 'C:\\guide\\xmltv.xml' }],
  parseXmltv,
  parseTime,
  async fetch(config) {
    if (!config.url) throw new Error('Enter an XMLTV guide URL or file path.');
    return loadXmltv(config.url);
  },
};
