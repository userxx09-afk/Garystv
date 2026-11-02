// Poster, matched title, year, rating and synopsis for Movies and Shows, from
// TMDb (The Movie Database). Needs a free TMDb key: Settings > Movies & Shows on
// the PC, or TMDB_KEY in the server's secrets file. Either kind of TMDb key
// works: the short v3 "API key" (sent as ?api_key=) or the long v4 "Read Access
// Token" (sent as a Bearer header); a wrong-kind key fails every request.
//
// Answers are kept (data/tmdbcache.json) by kind + title + year. "TMDb has
// nothing" is kept too, but a failure (bad key, TMDb down) isn't, so it doesn't
// stick. TMDb's terms: free for personal, non-commercial use, with the
// attribution shown in Settings.
const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';
const KEEP_FOUND = 60 * 86400000, KEEP_NONE = 14 * 86400000, MAX = 5000;

// "EN - The Matrix (1999) [4K]" -> { title: 'The Matrix', year: '1999' }
function parseTitle(raw) {
  let t = String(raw || '');
  const y = t.match(/[([]\s*((?:19|20)\d{2})\s*[)\]]/) || t.match(/(?:^|\s|-)((?:19|20)\d{2})\s*$/);
  t = t.replace(/^\s*[A-Z]{2,3}\s*[-|:]\s+/, '') // language tag
    .replace(/[([][^)\]]*[)\]]/g, ' ') // (1999) [4K] (Multi-Sub)
    .replace(/\b(4k|uhd|fhd|hd|sd|1080p|720p|hevc|x26[45]|multi[- ]?sub|vostfr|dubbed|subbed)\b/gi, ' ')
    .replace(/(?:^|\s|-)(?:19|20)\d{2}\s*$/, ' ')
    .replace(/\s*\|.*$/, '') // "Title | extra"
    .replace(/[._]+/g, ' ').replace(/\s+-\s*$/, '').replace(/\s+/g, ' ').trim();
  return { title: t, year: y ? y[1] : '' };
}

class Tmdb {
  constructor(core, { api = API } = {}) { this.core = core; this.api = api; this.pending = new Map(); }

  // The key typed in Settings wins over the secrets file.
  key() { return String(this.core.settings.tmdbKey || process.env.TMDB_KEY || '').trim(); }
  keySource() { return this.core.settings.tmdbKey ? 'settings' : process.env.TMDB_KEY ? 'secrets' : null; }

  get cache() { return this.core.store.read('tmdbcache', {}); }
  clearCache() { clearTimeout(this.saveTimer); this.core.store.write('tmdbcache', {}); return { cleared: true }; }

  async ask(path, params) {
    const key = this.key();
    const q = new URLSearchParams({ ...params, include_adult: 'false', language: 'en-US' });
    const headers = { Accept: 'application/json' };
    if (key.length > 40) headers.Authorization = `Bearer ${key}`; // v4 Read Access Token
    else q.set('api_key', key); // v3 API key
    const res = await fetch(`${this.api}${path}?${q}`, { headers, signal: AbortSignal.timeout(10000) });
    if (res.status === 401) throw new Error('TMDb refused the key. Check it in Settings > Movies & Shows.');
    if (!res.ok) throw new Error(`TMDb answered ${res.status}`);
    return res.json();
  }

  // kind: movies | shows. -> { status: found | none | nokey | error, ...info }
  async lookup(kind, rawName, rawYear) {
    if (!this.key()) return { status: 'nokey' };
    const parsed = parseTitle(rawName);
    const year = String(rawYear || parsed.year || '').slice(0, 4);
    if (!parsed.title) return { status: 'none' };
    const id = `${kind === 'shows' ? 'tv' : 'movie'}|${parsed.title.toLowerCase()}|${year}`;
    const hit = this.cache[id];
    if (hit && Date.now() - hit.at < (hit.status === 'found' ? KEEP_FOUND : KEEP_NONE)) return hit;
    // Several screens can ask for the same title at once; one request answers them all.
    if (!this.pending.has(id)) {
      this.pending.set(id, this.search(kind, parsed.title, year).finally(() => this.pending.delete(id)));
    }
    try {
      const info = await this.pending.get(id);
      this.remember(id, info);
      return info;
    } catch (e) {
      return { status: 'error', error: e.name === 'TimeoutError' ? 'TMDb did not answer.' : e.message }; // not kept
    }
  }

  async search(kind, title, year) {
    const tv = kind === 'shows';
    const path = tv ? '/search/tv' : '/search/movie';
    let r = await this.ask(path, { query: title, ...(year ? { [tv ? 'first_air_date_year' : 'year']: year } : {}) });
    if (year && !(r.results || []).length) r = await this.ask(path, { query: title }); // the provider's year is sometimes off
    const m = (r.results || [])[0];
    if (!m) return { status: 'none', query: title };
    const date = tv ? m.first_air_date : m.release_date;
    return {
      status: 'found',
      tmdbId: m.id,
      title: (tv ? m.name : m.title) || title,
      year: date ? date.slice(0, 4) : '',
      rating: m.vote_count > 0 && m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
      overview: m.overview || '',
      poster: m.poster_path ? IMG + m.poster_path : '',
    };
  }

  // Scrolling past posters looks up many titles quickly, so the file is written a moment after the last one.
  remember(id, info) {
    const all = this.cache;
    all[id] = { ...info, at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX) for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - MAX)) delete all[k];
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.core.store.write('tmdbcache', this.cache), 2000);
  }
}

module.exports = { Tmdb, parseTitle };
