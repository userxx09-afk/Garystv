// IPTV providers that give a server address, username and password (an "Xtream
// Codes" panel, the kind most subscription services use). Providers often list
// several server addresses that all work; the first one that answers is used,
// and a rescan moves to another if it goes down.

// The account's channel list can run to tens of thousands of channels from many
// countries. Unless the user picks groups, keep the US ones.
const US_GROUP = /(^|[^a-z])(us|usa|united states|american?)([^a-z]|$)/i;

function servers(config) {
  return String(config.servers || '').split(/[\s,;]+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
    .map((s) => (/^https?:\/\//i.test(s) ? s : `http://${s}`));
}

async function api(base, config, action, params = {}) {
  const q = new URLSearchParams({ username: config.username, password: config.password });
  if (action) q.set('action', action);
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  const res = await fetch(`${base}/player_api.php?${q}`, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${new URL(base).host} answered ${res.status}`);
  return res.json();
}

// -> { base, account } for the first server that accepts the login.
async function login(config) {
  const list = servers(config);
  if (!list.length || !config.username || !config.password) throw new Error('Enter the server address, username and password from your IPTV provider.');
  const problems = [];
  for (const base of list) {
    try {
      const account = await api(base, config);
      const user = account && account.user_info;
      if (!user || String(user.auth) !== '1') { problems.push(`${new URL(base).host}: login refused`); continue; }
      if (user.status && user.status !== 'Active') { problems.push(`${new URL(base).host}: account ${user.status.toLowerCase()}`); continue; }
      return { base, account };
    } catch (e) {
      problems.push(`${new URL(base).host}: ${e.name === 'TimeoutError' ? 'no answer' : e.message}`);
    }
  }
  throw new Error(`No server accepted the login (${problems.join('; ')}).`);
}

module.exports = {
  type: 'xtream',
  label: 'IPTV provider (server, username & password)',
  fields: [
    { key: 'servers', label: 'Server address (list several, separated by spaces, if the provider gave more than one)', placeholder: 'http://line.example.com http://backup.example.com' },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password', secret: true },
    { key: 'groups', label: 'Only these groups (comma separated; blank = US groups)', placeholder: 'USA, Sports' },
    { key: 'firstNumber', label: 'Number channels from', placeholder: '1000' },
    { key: 'maxStreams', label: 'Streams allowed at once (blank = what the account allows)', placeholder: '' },
  ],
  servers,
  login,
  api,

  async scan(config) {
    const { base, account } = await login(config);
    const [categories, streams] = await Promise.all([api(base, config, 'get_live_categories'), api(base, config, 'get_live_streams')]);
    const groupName = new Map((Array.isArray(categories) ? categories : []).map((c) => [String(c.category_id), c.category_name || '']));
    const all = (Array.isArray(streams) ? streams : []).map((s) => ({ ...s, group: groupName.get(String(s.category_id)) || '' }));

    const wanted = String(config.groups || '').split(',').map((g) => g.trim().toLowerCase()).filter(Boolean);
    let kept = wanted.length
      ? all.filter((s) => wanted.some((w) => s.group.toLowerCase().includes(w)))
      : all.filter((s) => US_GROUP.test(s.group));
    const usDefault = !wanted.length && kept.length > 0;
    if (!wanted.length && !kept.length) kept = all;

    // Plain MPEG-TS when the account allows it (records and buffers most reliably), else HLS.
    const formats = (account.user_info.allowed_output_formats || []).map(String);
    const ext = !formats.length || formats.includes('ts') ? 'ts' : 'm3u8';
    const enc = encodeURIComponent;
    const first = parseInt(config.firstNumber, 10) || 1000;
    const channels = kept
      .sort((a, b) => (+a.num || 0) - (+b.num || 0))
      .map((s, i) => ({
        key: String(s.stream_id),
        number: String(first + i),
        name: String(s.name || 'Channel').trim(),
        tvgId: s.epg_channel_id || '',
        logo: s.stream_icon || '',
        group: s.group,
        streamUrl: `${base}/live/${enc(config.username)}/${enc(config.password)}/${s.stream_id}.${ext}`,
      }));

    const allowed = parseInt(account.user_info.max_connections, 10) || 1;
    const expires = +account.user_info.exp_date ? new Date(account.user_info.exp_date * 1000).toLocaleDateString() : '';
    const groupsUsed = new Set(kept.map((s) => s.group)).size;
    return {
      config,
      epgUrl: `${base}/xmltv.php?${new URLSearchParams({ username: config.username, password: config.password })}`,
      tunerCount: parseInt(config.maxStreams, 10) || allowed,
      info: [
        `${channels.length} channels in ${groupsUsed} groups${channels.length < all.length ? ` (of ${all.length}${usDefault ? '; US groups only, change with "Only these groups"' : ''})` : ''}`,
        `via ${new URL(base).host}`,
        `${allowed} stream${allowed > 1 ? 's' : ''} at once`,
        expires && `account ends ${expires}`,
      ].filter(Boolean).join(', '),
      channels,
    };
  },
};
