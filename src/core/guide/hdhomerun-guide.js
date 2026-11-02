// Guide data from SiliconDust's own service, using the tuner's DeviceAuth.
// Free, but covers only the next several hours; we page forward as far as it goes.
module.exports = {
  type: 'hdhomerun',
  label: 'HDHomeRun built-in guide (free, short range)',
  fields: [],
  needsSource: 'hdhomerun',

  async fetch(config, { source, hours = 24 }) {
    const auth = source && source.config && source.config.deviceAuth;
    if (!auth) throw new Error('Scan the HDHomeRun tuner first so the guide can use its device ID.');
    const channels = new Map();
    const programs = {};
    let cursor = Math.floor(Date.now() / 1000);
    const until = cursor + hours * 3600;
    for (let page = 0; page < 12 && cursor < until; page++) {
      const url = `https://api.hdhomerun.com/api/guide.php?DeviceAuth=${encodeURIComponent(auth)}&Start=${cursor}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HDHomeRun guide returned ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data) || !data.length) break;
      let latest = cursor;
      for (const ch of data) {
        const id = `hdhr-${ch.GuideNumber}`;
        channels.set(id, { id, names: [ch.GuideName, ch.Affiliate, ch.GuideNumber].filter(Boolean), number: ch.GuideNumber, logo: ch.ImageURL || '' });
        const list = (programs[id] ||= []);
        for (const p of ch.Guide || []) {
          if (list.some((x) => x.start === p.StartTime * 1000)) continue;
          const se = /S(\d+)E(\d+)/.exec(p.EpisodeNumber || '');
          const aired = p.OriginalAirdate ? p.OriginalAirdate * 1000 : null;
          list.push({
            start: p.StartTime * 1000,
            end: p.EndTime * 1000,
            title: p.Title || '',
            subtitle: p.EpisodeTitle || '',
            desc: p.Synopsis || '',
            categories: p.Filter || [],
            season: se ? +se[1] : null,
            episode: se ? +se[2] : null,
            programId: p.ProgramID || '',
            seriesId: p.SeriesID || '',
            isNew: aired != null && Math.abs(p.StartTime * 1000 - aired) < 36 * 3600000,
            rating: '',
            icon: p.ImageURL || '',
          });
          latest = Math.max(latest, p.EndTime);
        }
      }
      if (latest <= cursor) break;
      cursor = latest;
    }
    for (const list of Object.values(programs)) list.sort((a, b) => a.start - b.start);
    return { channels: [...channels.values()], programs };
  },
};
