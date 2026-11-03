// Backup and restore: everything you set up, in one file, to move GarysTV to another
// computer (or keep a copy). Recordings, the downloaded guide and cached posters aren't in
// it: they come back by themselves (and recordings are files you copy separately).
//
// Channels are rebuilt from the providers on the new computer, so only your choices about
// each one travel (shown or hidden, pinned, your number, the guide listing you picked).
// Logins (IPTV usernames and passwords, the TMDb key) go in only when asked for; without them
// the new computer keeps the logins it already has for the same provider, or asks for them.

const MACHINE = ['recordingsDir', 'ffmpegPath', 'vlcPath', 'port', 'allowNetwork', 'closeAction', 'vlcAutoTried', 'tmdbKey'];
const CHANNEL_CHOICES = ['hidden', 'favorite', 'alias', 'mapMode', 'guideId', 'matchScore', 'matchReason'];
const LOGIN_KEYS = ['username', 'password'];

function makeBackup(core, { logins = false, version = '' } = {}) {
  const sources = core.sources.map((s) => {
    const config = { ...s.config };
    if (!logins) for (const k of LOGIN_KEYS) if (k in config) config[k] = '';
    return { ...s, config };
  });
  // A provider's own guide address carries its login in it.
  const secrets = core.sources.flatMap((s) => LOGIN_KEYS.map((k) => s.config && s.config[k]).filter((v) => v && String(v).length > 2));
  const guides = core.guides.map((g) => {
    const url = g.config && g.config.url;
    if (logins || !url || !secrets.some((v) => url.includes(encodeURIComponent(v)) || url.includes(v))) return g;
    return { ...g, config: { ...g.config, url: '' } };
  });
  const settings = Object.fromEntries(Object.entries(core.store.read('settings', {})).filter(([k]) => !MACHINE.includes(k)));
  const tmdbKey = logins ? String(core.settings.tmdbKey || process.env.TMDB_KEY || '') : '';
  return {
    garystv: 'backup', format: 1, version, madeAt: Date.now(), logins: !!logins,
    settings, tmdbKey, sources, guides,
    channels: core.channels.map((c) => ({ id: c.id, ...Object.fromEntries(CHANNEL_CHOICES.filter((k) => c[k] != null && c[k] !== '' && c[k] !== false).map((k) => [k, c[k]])) }))
      .filter((c) => Object.keys(c).length > 1),
    favlists: core.favLists,
    rules: core.rules,
    vodfavs: core.store.read('vodfavs', {}),
  };
}

// Replaces this computer's setup with the backup's. -> what came in, for a message.
function restoreBackup(core, b) {
  if (!b || b.garystv !== 'backup' || !Array.isArray(b.sources)) throw new Error("That isn't a GarysTV backup file.");
  if (b.format > 1) throw new Error('That backup is from a newer GarysTV. Update this one first.');
  const mine = core.sources;
  const needLogin = [];
  const sources = b.sources.map((s) => {
    const config = { ...s.config };
    const blank = LOGIN_KEYS.filter((k) => k in config && !config[k]);
    if (blank.length) { // keep the logins this computer already has for the same provider
      const same = mine.find((m) => m.id === s.id) || mine.find((m) => m.type === s.type && (m.config.servers || m.config.url) === (config.servers || config.url));
      for (const k of blank) if (same && same.config[k]) config[k] = same.config[k];
      if (LOGIN_KEYS.some((k) => k in config && !config[k])) needLogin.push(s.name);
    }
    return { ...s, config, scannedAt: 0 };
  });
  const guides = (b.guides || []).map((g) => {
    if (!g.config || g.config.url !== '') return g;
    const same = core.guides.find((m) => m.id === g.id && m.config.url);
    return same ? { ...g, config: { ...g.config, url: same.config.url } } : g;
  });
  const keep = Object.fromEntries(Object.entries(core.store.read('settings', {})).filter(([k]) => MACHINE.includes(k)));
  core.store.write('settings', { ...(b.settings || {}), ...keep, ...(b.tmdbKey ? { tmdbKey: b.tmdbKey } : {}) });
  core.store.write('sources', sources);
  core.store.write('guides', guides);
  core.store.write('favlists', Array.isArray(b.favlists) ? b.favlists : []);
  core.store.write('rules', Array.isArray(b.rules) ? b.rules : []);
  core.store.write('vodfavs', b.vodfavs && typeof b.vodfavs === 'object' ? b.vodfavs : {});
  // Your choices about each channel wait until its provider is scanned here (scanSource uses them).
  const choices = Object.fromEntries((b.channels || []).map(({ id, ...c }) => [id, c]));
  core.store.write('channelchoices', choices);
  const ids = new Set(sources.map((s) => s.id));
  core.store.write('channels', core.channels.filter((c) => ids.has(c.sourceId)).map((c) => ({ ...c, ...withNumber(c, choices[c.id]) })));
  return {
    sources: sources.length, guides: guides.length, favlists: (b.favlists || []).length, rules: (b.rules || []).length,
    channels: Object.keys(choices).length, needLogin,
  };
}

// A channel with a restored choice of number: shown as yours, the provider's kept.
function withNumber(c, choice) {
  if (!choice) return {};
  const sourceNumber = c.sourceNumber ?? c.number;
  return { ...choice, sourceNumber, number: choice.alias || sourceNumber };
}

module.exports = { makeBackup, restoreBackup };
