// Movies and shows from IPTV providers (Xtream Codes panels also carry an
// on-demand library). Nothing is stored except where you stopped watching:
// the catalog is read from the provider when a screen asks and kept for a while.
//
// Ids handed to the screens carry what's needed to play the item later:
//   movie   m~<sourceId>~<streamId>~<container>
//   episode e~<sourceId>~<episodeId>~<container>
//   show    s~<sourceId>~<seriesId>
//   category <sourceId>~<categoryId>
const xtream = require('./sources/xtream');

const KEEP_MS = 6 * 3600000;
const ENGLISH = /(^|[^a-z])(en|eng|english|us|usa|uk|american?)([^a-z]|$)/i;
const enc = encodeURIComponent;

class Vod {
  constructor(core) {
    this.core = core;
    this.cache = new Map(); // key -> { at, value: Promise }
  }

  providers() { return this.core.sources.filter((s) => s.type === 'xtream' && s.enabled); }
  provider(id) {
    const src = this.providers().find((s) => s.id === id);
    if (!src) throw new Error('That IPTV provider is no longer set up.');
    return src;
  }

  // Remembers a provider answer for a while; a failure is forgotten so the next try asks again.
  cached(key, make) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < KEEP_MS) return hit.value;
    const value = make();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  // The provider's working server for this login.
  base(src) { return this.cached(`login:${src.id}:${src.config.servers}`, () => xtream.login(src.config).then((r) => r.base)); }
  async call(src, action, params = {}) {
    const base = await this.base(src);
    return xtream.api(base, src.config, action, params);
  }

  // kind: movies | shows -> [{ id, name }], English / US groups first.
  async categories(kind) {
    const action = kind === 'shows' ? 'get_series_categories' : 'get_vod_categories';
    const lists = await Promise.all(this.providers().map((src) => this.cached(`${kind}:cats:${src.id}`, () => this.call(src, action))
      .then((cats) => (Array.isArray(cats) ? cats : []).map((c) => ({ id: `${src.id}~${c.category_id}`, name: String(c.category_name || 'Other').trim() })))
      .catch((e) => { this.core.note(`${src.name}: ${kind}: ${e.message}`); return []; })));
    const all = lists.flat();
    return [...all.filter((c) => ENGLISH.test(c.name)), ...all.filter((c) => !ENGLISH.test(c.name))];
  }

  // One category's movies or shows, newest first.
  async items(kind, categoryId) {
    const [srcId, catId] = String(categoryId).split('~');
    const src = this.provider(srcId);
    const list = await this.cached(`${kind}:${categoryId}`, () => this.call(src, listAction(kind), { category_id: catId }));
    return toItems(kind, src, list).sort((a, b) => b.added - a.added);
  }

  // Titles anywhere in the library whose name has every word typed, best match first.
  // The whole list is read once (it can be tens of thousands) and kept like a category.
  async search(kind, q) {
    const want = wordsOf(q).join(' ');
    if (!want) return [];
    const lists = await Promise.all(this.providers().map((src) => this.cached(`${kind}:all:${src.id}`,
      () => this.call(src, listAction(kind)).then((list) => toItems(kind, src, list).map((v) => ({ v, words: wordsOf(v.name).join(' ') }))))
      .catch((e) => { this.core.note(`${src.name}: ${kind}: ${e.message}`); return []; })));
    const each = want.split(' ');
    const score = (w) => (w === want ? 0 : w.startsWith(want) ? 1 : 2);
    return lists.flat().filter((x) => each.every((w) => x.words.includes(w)))
      .sort((a, b) => score(a.words) - score(b.words) || b.v.added - a.v.added)
      .slice(0, 60).map((x) => x.v);
  }

  // A movie's details (plot, length...) for its info screen.
  async movie(id) {
    const [, srcId, streamId] = String(id).split('~');
    const src = this.provider(srcId);
    const r = await this.cached(`movie:${id}`, () => this.call(src, 'get_vod_info', { vod_id: streamId }));
    const info = (r && r.info) || {}, data = (r && r.movie_data) || {};
    return { id, name: clean(data.name || info.name), poster: info.movie_image || info.cover_big || '', year: year(info), rating: rating(info),
      plot: info.plot || info.description || '', genre: info.genre || '', cast: info.cast || info.actors || '', duration: +info.duration_secs || 0 };
  }

  // A show's seasons and episodes.
  async show(id) {
    const [, srcId, seriesId] = String(id).split('~');
    const src = this.provider(srcId);
    const r = await this.cached(`show:${id}`, () => this.call(src, 'get_series_info', { series_id: seriesId }));
    const info = (r && r.info) || {};
    const eps = (r && r.episodes) || {};
    const seasons = Object.keys(eps).sort((a, b) => +a - +b).map((n) => ({
      season: +n,
      episodes: (eps[n] || []).map((e) => ({
        id: `e~${src.id}~${e.id}~${e.container_extension || 'mp4'}`,
        season: +n, episode: +e.episode_num || 0, title: clean(e.title),
        plot: (e.info && e.info.plot) || '', duration: (e.info && +e.info.duration_secs) || 0, poster: (e.info && e.info.movie_image) || '',
      })).sort((a, b) => a.episode - b.episode),
    }));
    return { id, name: clean(info.name), poster: info.cover || '', year: year(info), rating: rating(info), plot: info.plot || '', genre: info.genre || '', seasons };
  }

  // -> { url, title } for the player.
  async input(id) {
    const [kind, srcId, itemId, ext] = String(id).split('~');
    if (!['m', 'e'].includes(kind) || !/^\d+$/.test(itemId) || !/^[a-z0-9]{1,5}$/i.test(ext)) throw new Error('Not found');
    const src = this.provider(srcId);
    const base = await this.base(src);
    const { username, password } = src.config;
    return { url: `${base}/${kind === 'm' ? 'movie' : 'series'}/${enc(username)}/${enc(password)}/${itemId}.${ext}`, title: '' };
  }

  // Where each movie or episode was stopped, for Resume and "Continue watching".
  get progress() { return this.core.store.read('vodprogress', {}); }
  saveProgress(id, { position, duration, title, subtitle, poster, showId }) {
    const all = { ...this.progress };
    const done = duration > 0 && position / duration > 0.92;
    if (done || position < 30) delete all[id];
    else all[id] = { position, duration, title: String(title || ''), subtitle: String(subtitle || ''), poster: String(poster || ''), showId: showId || null, at: Date.now() };
    // Keep the 40 most recent.
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 40);
    this.core.store.write('vodprogress', Object.fromEntries(keep));
    return { saved: !done };
  }
  continueList() { return Object.entries(this.progress).map(([id, p]) => ({ id, ...p })).sort((a, b) => b.at - a.at); }
}

const listAction = (kind) => (kind === 'shows' ? 'get_series' : 'get_vod_streams');
function toItems(kind, src, list) {
  return (Array.isArray(list) ? list : []).map((v) => (kind === 'shows'
    ? { id: `s~${src.id}~${v.series_id}`, name: clean(v.name), poster: v.cover || '', year: year(v), rating: rating(v), plot: v.plot || '', genre: v.genre || '', added: +v.last_modified || 0 }
    : { id: `m~${src.id}~${v.stream_id}~${v.container_extension || 'mp4'}`, name: clean(v.name), poster: v.stream_icon || '', year: year(v), rating: rating(v), added: +v.added || 0 }));
}
// Lower-case words without punctuation, so "Spider-Man" is found by "spider man".
function wordsOf(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean); }

// Providers often prefix names with a language tag ("EN - ") and suffix the year.
function clean(name) { return String(name || '').replace(/^\s*[A-Z]{2,3}\s*[-|:]\s+/, '').trim() || 'Untitled'; }
function year(v) {
  const y = String(v.releaseDate || v.release_date || v.releasedate || v.year || '').match(/\d{4}/) || String(v.name || '').match(/\((\d{4})\)\s*$/);
  return y ? y[y.length - 1] : '';
}
function rating(v) { const r = parseFloat(v.rating); return r > 0 ? Math.round(r * 10) / 10 : null; }

module.exports = { Vod, clean, wordsOf };
