// IPTV (HLS) streams usually offer several qualities in one "master" playlist.
// ffmpeg would take the first (often the lowest), so pick the best one up to 1080p.
async function bestVariant(url, maxHeight = 1080) {
  if (!/\.m3u8(\?|$)/i.test(url)) return url;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await res.text();
    if (!/#EXT-X-STREAM-INF/.test(text)) return url;
    const lines = text.split(/\r?\n/);
    const variants = [];
    lines.forEach((l, i) => {
      if (!l.startsWith('#EXT-X-STREAM-INF')) return;
      const uri = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
      if (!uri) return;
      const bw = +((l.match(/[:,]BANDWIDTH=(\d+)/) || [])[1] || 0);
      const height = +((l.match(/RESOLUTION=\d+x(\d+)/) || [])[1] || 0);
      variants.push({ uri: new URL(uri.trim(), res.url).href, bw, height });
    });
    const fits = variants.filter((v) => !v.height || v.height <= maxHeight);
    const best = (fits.length ? fits : variants).sort((a, b) => b.height - a.height || b.bw - a.bw)[0];
    return best ? best.uri : url;
  } catch (_) {
    return url;
  } finally {
    clearTimeout(t);
  }
}

// ffmpeg input options for HLS: free services (Xumo, etc.) serve video pieces from
// addresses that don't end in .ts, which newer ffmpeg (7+) refuses unless told otherwise.
// Older ffmpeg (6.x, as on Ubuntu 24.04) doesn't check, and stops at the unknown option.
function pickyOption() {
  const ffmpeg = require('./tools').findFfmpeg();
  if (!ffmpeg) return [];
  try {
    const help = require('child_process').execFileSync(ffmpeg, ['-hide_banner', '-h', 'demuxer=hls'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return help.includes('extension_picky') ? ['-extension_picky', '0'] : [];
  } catch (_) {
    return ['-extension_picky', '0'];
  }
}
const HLS_INPUT = [...pickyOption(), '-user_agent', 'Mozilla/5.0'];

// For any internet stream: when a download drops mid-stream, reconnect (for up to
// a few seconds) instead of ending, so a network blip doesn't stop the picture.
const RECONNECT = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '4'];

module.exports = { bestVariant, HLS_INPUT, RECONNECT };
