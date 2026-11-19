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
//
// Provider names carry quality tags ("4K | Title", "Title ᴴᴰ", "HDR10+"); they
// are stripped, and the TMDb result most like the title is picked, with a
// confidence score, so a couple of extra letters still match.
const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';
const KEEP_FOUND = 60 * 86400000, KEEP_NONE = 14 * 86400000, MAX = 5000;

// Quality, codec, audio and subtitle tags providers put on titles. None of them
// is ever part of a real title, so they are dropped wherever they appear.
const TAGS = [
  '4k', 'uhd', 'fhd', 'qhd', 'hd', 'sd', 'hq', 'lq', 'hdr', 'hdr10', 'hdr10\\+', 'sdr', 'dv', 'dovi', 'dolby ?vision', 'imax ?enhanced',
  '2160p', '1440p', '1080p', '1080i', '720p', '576p', '480p', '360p', '60fps', '50fps',
  'hevc', 'avc', 'h\\.?26[45]', 'x26[45]', '10 ?bits?', '8 ?bits?', 'remux', 'blu-?ray', 'bdrip', 'brrip', 'web-?dl', 'web-?rip', 'webrip', 'hdtv', 'dvdrip', 'hdrip', 'hdcam',
  'atmos', 'dts(?:-hd)?', 'truehd', 'ddp?5\\.?1', 'aac', 'ac3', 'eac3', '5\\.1', '7\\.1',
  'multi[- ]?sub(?:s)?', 'multi[- ]?audio', 'vostfr', 'dubbed', 'subbed', 'eng ?subs', 'dual[- ]?audio',
].sort((a, b) => b.length - a.length); // longest first, so "HDR10+" goes whole
// Short ones that are also real words ("Sub Zero", "Cam"), only in capitals.
const CAPS = ['TS', 'CAM', 'SUB', 'SUBS', 'DUB', 'MULTI', 'VOST'];
const edge = (list, flags) => new RegExp(`(^|[^\\p{L}\\p{N}])(?:${list.join('|')})(?=$|[^\\p{L}\\p{N}])`, flags);
const TAG_RE = edge(TAGS, 'giu'), CAPS_RE = edge(CAPS, 'gu');
// Superscript/small-caps marks some providers use: "Title ᴴᴰ", "Title ⁴ᴷ", "Title ᵁᴴᴰ".
const MARKS_RE = /[ᴬ-ᵪ⁰-₟²³¹]+/g;
// A whole part that is only a country/language code: "EN", "USA", "4K-EN".
const CODE_RE = /^(?:[A-Z]{2,3}|[a-z]{2})$/;

// "EN - The Matrix (1999) [4K]" -> { title: 'The Matrix', year: '1999' }
// "4K | The Matrix", "|UHD| The Matrix HDR", "The Matrix ᴴᴰ" -> 'The Matrix'
function parseTitle(raw) {
  let t = String(raw || '').replace(MARKS_RE, ' ');
  const y = t.match(/[([]\s*((?:19|20)\d{2})\s*[)\]]/) || t.match(/(?:^|\s|-)((?:19|20)\d{2})\s*$/);
  t = t.replace(/[([][^)\]]*[)\]]/g, ' ') // (1999) [4K] (Multi-Sub)
    .replace(/[★☆✦✪●•◆♦]/g, ' ')
    .replace(TAG_RE, '$1 ').replace(TAG_RE, '$1 ').replace(CAPS_RE, '$1 '); // twice: "4K HD" shares a space
  // "USA | Breaking Bad", "4K | Movie", "Title | extra": the first part that is a real title.
  const parts = t.split(/[|┃│]/).map((p) => p.replace(/^[\s\-:–—.,]+|[\s\-:–—.,]+$/g, '').trim());
  t = parts.find((p) => p && !CODE_RE.test(p)) || '';
  t = t.replace(/^\s*[A-Z]{2,3}\s*[-:]\s+/, '') // language tag "EN - "
    .replace(/(?:^|\s|-)(?:19|20)\d{2}\s*$/, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/^[\s\-:–—,]+|[\s\-:–—,]+$/g, '')
    .replace(/\s+/g, ' ').trim();
  // Nothing left (the name was all tags, like "Cam"): keep the name as it was.
  if (!t) t = String(raw || '').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return { title: t, year: y ? y[1] : '' };
}

// Words of a title, for comparing: lower case, no accents or punctuation, "&" = "and", no "the/a/an".
function words(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ').filter((w) => w && !['the', 'a', 'an'].includes(w));
}

// How sure we are that a TMDb title is the one asked for, 0..1. Same words = 1;
// a couple of extra letters or one extra word still scores high.
function similarity(a, b) {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return 0;
  if (x.join(' ') === y.join(' ')) return 1;
  const xs = x.join(''), ys = y.join('');
  if (xs === ys) return 0.97; // "Spiderman" vs "Spider-Man"
  const near = (w, list) => list.some((v) => v === w || (w.length > 3 && v.length > 3 && edits(w, v) <= 1));
  const shared = x.filter((w) => near(w, y)).length;
  const words01 = (2 * shared) / (x.length + y.length);
  const letters01 = 1 - edits(xs, ys) / Math.max(xs.length, ys.length);
  // "Toy Story" is not "Toy Story 4"
  const nums = (l) => l.filter((w) => /^\d+$/.test(w)).join(' ');
  return Math.max(words01, letters01) - (nums(x) !== nums(y) ? 0.3 : 0);
}

function edits(a, b) { // Levenshtein distance
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const SURE = 0.7; // below this a result is a different title
const MATCHER = 2; // bump when matching improves, so old "nothing found" answers are asked again

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
    const fresh = hit && (hit.status === 'found' || hit.v === MATCHER);
    if (fresh && Date.now() - hit.at < (hit.status === 'found' ? KEEP_FOUND : KEEP_NONE)) return hit;
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
    const yearKey = tv ? 'first_air_date_year' : 'year';
    // Try the title as given, then shorter forms: "Title: Subtitle" / "Title - Extra",
    // and without a short leftover tag at the end ("Title NF").
    const tries = [title];
    const head = title.split(/\s*(?::|\s-\s|–|—)\s*/)[0];
    if (head && head !== title && words(head).length) tries.push(head);
    const last = title.match(/^(.+?)\s+([A-Z0-9]{2,4})$/);
    if (last && words(last[1]).length) tries.push(last[1]);
    let best = null;
    for (const q of [...new Set(tries)]) {
      let r = await this.ask(path, { query: q, ...(year ? { [yearKey]: year } : {}) });
      if (year && !(r.results || []).length) r = await this.ask(path, { query: q }); // the provider's year is sometimes off
      const pick = this.best(r.results || [], title, q, year, tv);
      if (pick && (!best || pick.score > best.score)) best = pick;
      if (best && best.score >= 0.9) break;
    }
    if (!best) return { status: 'none', query: title };
    const m = best.m;
    const date = tv ? m.first_air_date : m.release_date;
    return {
      status: 'found',
      tmdbId: m.id,
      title: (tv ? m.name : m.title) || title,
      year: date ? date.slice(0, 4) : '',
      rating: m.vote_count > 0 && m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
      overview: m.overview || '',
      poster: m.poster_path ? IMG + m.poster_path : '',
      confidence: Math.round(best.score * 100) / 100,
    };
  }

  // The result most like the title asked for (year breaks ties), if it's close enough.
  best(results, title, query, year, tv) {
    let top = null;
    results.slice(0, 10).forEach((m, i) => {
      const names = [tv ? m.name : m.title, tv ? m.original_name : m.original_title].filter(Boolean);
      let score = Math.max(0, ...names.map((n) => Math.max(similarity(title, n), similarity(query, n) - 0.05)));
      const y = String((tv ? m.first_air_date : m.release_date) || '').slice(0, 4);
      if (year && y === year) score += 0.05;
      else if (year && y && Math.abs(y - year) > 1) score -= 0.05;
      score -= i * 0.005; // TMDb's own order as the last tie-break
      if (!top || score > top.score) top = { m, score };
    });
    if (top && top.score >= SURE) return top;
    // A provider name in another language can look nothing like TMDb's: still
    // trust TMDb's first answer when its year is exactly the one given.
    const first = results[0];
    const fy = first && String((tv ? first.first_air_date : first.release_date) || '').slice(0, 4);
    return year && fy === year ? { m: first, score: top ? Math.max(0, top.score) : 0 } : null;
  }

  // Scrolling past posters looks up many titles quickly, so the file is written a moment after the last one.
  remember(id, info) {
    const all = this.cache;
    all[id] = { ...info, v: MATCHER, at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX) for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - MAX)) delete all[k];
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.core.store.write('tmdbcache', this.cache), 2000);
  }
}

module.exports = { Tmdb, parseTitle, similarity };
