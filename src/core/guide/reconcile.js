// Matches the channels a tuner/provider actually delivers to the channels in
// the guide data. Over-the-air lineups rarely line up exactly with guide
// listings (subchannels, call-sign suffixes, missing numbers), so every match
// gets a score and the user can override any of them in Settings > Channels.

const normNumber = (s) => {
  const m = /^\s*(\d+)(?:\s*[.\-_ ]\s*(\d+))?\s*$/.exec(String(s || ''));
  return m ? (m[2] ? `${+m[1]}.${+m[2]}` : `${+m[1]}`) : '';
};

const normCallsign = (s) => {
  const m = /^([KW][A-Z]{2,3})(?:[-\s]?(?:DT\d?|HD\d?|TV|LD|LP|CD|CA)\d*)?\b/.exec(String(s || '').toUpperCase().trim());
  return m ? m[1] : '';
};

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function score(channel, g) {
  let total = 0;
  const reasons = [];
  if (channel.tvgId && channel.tvgId === g.rawId) return { total: 100, reasons: ['guide ID'] };
  const num = normNumber(channel.sourceNumber ?? channel.number); // the provider's number, not one you gave it
  const gNums = [g.number, ...g.names].map(normNumber).filter(Boolean);
  if (num && gNums.includes(num)) { total += 50; reasons.push('channel number'); }
  const call = normCallsign(channel.callsign || channel.name);
  if (call && g.names.some((n) => normCallsign(n) === call)) { total += 45; reasons.push('call sign'); }
  const name = normName(channel.name);
  const gNames = g.names.map(normName).filter(Boolean);
  if (name && gNames.includes(name)) { total += 40; reasons.push('name'); }
  else if (name.length >= 4 && gNames.some((n) => n.length >= 4 && (n.includes(name) || name.includes(n)))) { total += 15; reasons.push('similar name'); }
  return { total: Math.min(total, 100), reasons };
}

// Returns Map(channelId -> { guideId, score, reason }) for channels in 'auto' mode.
// An IPTV plan has thousands of channels and its guide as many listings, so trying every pair
// (tens of millions) froze the engine for many minutes. Only listings sharing a guide ID,
// number, call sign or name with a channel can reach the threshold, so only those are scored.
function reconcile(channels, guideChannels, threshold = 40) {
  const index = new Map();
  const add = (key, i) => { if (!index.has(key)) index.set(key, []); index.get(key).push(i); };
  guideChannels.forEach((g, i) => {
    add(`id:${g.rawId}`, i);
    for (const s of [g.number, ...g.names]) { const n = normNumber(s); if (n) add(`num:${n}`, i); }
    for (const s of g.names) {
      const c = normCallsign(s); if (c) add(`call:${c}`, i);
      const n = normName(s); if (n) add(`name:${n}`, i);
    }
  });
  const result = new Map();
  for (const ch of channels) {
    const keys = [];
    if (ch.tvgId) keys.push(`id:${ch.tvgId}`);
    const num = normNumber(ch.sourceNumber ?? ch.number); if (num) keys.push(`num:${num}`);
    const call = normCallsign(ch.callsign || ch.name); if (call) keys.push(`call:${call}`);
    const name = normName(ch.name); if (name) keys.push(`name:${name}`);
    const near = new Set();
    for (const k of keys) for (const i of index.get(k) || []) near.add(i);
    let best = null;
    for (const i of [...near].sort((a, b) => a - b)) { // guide order, as before: the first of equals wins
      const g = guideChannels[i];
      const s = score(ch, g);
      if (s.total > 0 && (!best || s.total > best.score)) best = { guideId: g.id, score: s.total, reason: s.reasons.join(' + ') };
    }
    result.set(ch.id, best && best.score >= threshold ? best : { guideId: null, score: best ? best.score : 0, reason: best ? `best guess too weak (${best.reason})` : 'no match' });
  }
  return result;
}

module.exports = { reconcile, score, normNumber, normCallsign, normName };
