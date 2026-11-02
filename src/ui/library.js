// Movies and Shows: the on-demand library of the IPTV provider (core/vod.js).
// Categories down the left, posters on the right; a show opens its seasons and
// episodes. Where you stopped is remembered, so "Continue watching" picks up there.
// The panel on the right shows TMDb's poster, rating and synopsis for the
// highlighted title (core/tmdb.js), or says why it can't.
/* global App, Player, SearchView */
const PAGE = 60; // posters drawn at a time; "More" adds the next lot (TVs slow down with thousands)

function libraryView(kind) {
  const movies = kind === 'movies';
  const view = {
    title: movies ? 'Movies' : 'Shows',
    hints: [['←→↑↓', 'Move'], ['OK', movies ? 'Watch' : 'Open'], ['M', 'Menu'], ['Esc', 'Back']],
    cats: null, catId: null, items: {}, shown: PAGE, info: null, show: null, fromElsewhere: false, season: null, loadTimer: null, infoTimer: null, looked: new Map(),

    // TMDb's answer for a title -> { status: found | none | nokey | error, ... }. Kept for this visit.
    tmdb(name, year) {
      const k = `${name}|${year || ''}`;
      if (!this.looked.has(k)) {
        const p = api.get(`/api/tmdb?kind=${kind}&name=${encodeURIComponent(name)}&year=${encodeURIComponent(year || '')}`).catch((e) => ({ status: 'error', error: e.message }));
        this.looked.set(k, p);
        p.then((r) => { if (r.status === 'error' || r.status === 'nokey') this.looked.delete(k); }); // try again next time
      }
      return this.looked.get(k);
    },

    // The info panel follows the highlighted poster (after a moment, so scrolling stays quick).
    showInfo(v) {
      const box = $('#vodInfo');
      if (!box || !v) return;
      clearTimeout(this.infoTimer);
      const head = `<div class="it">${esc(v.name)}</div><div class="im">${esc([v.year, v.rating ? `★ ${v.rating}` : ''].filter(Boolean).join(' · '))}</div>`;
      box.innerHTML = `${head}<div class="is">Looking up info...</div>`;
      this.infoTimer = setTimeout(async () => {
        const t = await this.tmdb(v.lookup || v.name, v.year);
        if ($('#vodInfo') !== box || box.dataset.for !== v.id) return; // moved on
        if (t.status !== 'found') {
          const why = { nokey: 'Add a TMDb key (Settings &gt; Movies &amp; Shows, on the PC or server screen) for posters, ratings and synopses.', none: 'TMDb has nothing for this title.' }[t.status] || `Couldn't get info: ${esc(t.error || 'TMDb did not answer')}`;
          box.innerHTML = `${head}${v.plot ? `<div class="ip">${esc(v.plot)}</div>` : ''}<div class="is">${why}</div>`;
          return;
        }
        box.innerHTML = `${t.poster ? `<img src="${esc(t.poster)}" alt="" onerror="this.remove()">` : ''}<div class="it">${esc(t.title)}</div>
          <div class="im">${esc([t.year, t.rating ? `★ ${t.rating} on TMDb` : ''].filter(Boolean).join(' · '))}</div>
          <div class="ip">${esc(t.overview || v.plot || 'No synopsis.')}</div>`;
        // A poster the provider didn't have
        const card = $(`[data-item="${CSS.escape(v.id)}"] .pimg.none, [data-cont="${CSS.escape(v.id)}"] .pimg.none`);
        if (card && t.poster) { card.classList.remove('none'); card.insertAdjacentHTML('afterbegin', `<img src="${esc(t.poster)}" alt="">`); }
      }, 300);
      box.dataset.for = v.id;
    },

    // What's saved for this screen: a movie (m~) or an episode (e~).
    continueItems() { return (this.info ? this.info.continue : []).filter((c) => c.id.startsWith(movies ? 'm~' : 'e~')); },

    async render(root) {
      if (!this.cats) root.innerHTML = '<div class="empty">Loading...</div>';
      try {
        // Where things were stopped changes as you watch, so that's read every time.
        [this.info, this.cats] = await Promise.all([api.get('/api/vod'), this.cats || api.get(`/api/vod/${kind}/categories`)]);
      } catch (e) { root.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      if (!this.catId || (this.catId === 'continue' && !this.continueItems().length)) this.catId = this.continueItems().length ? 'continue' : (this.cats[0] || {}).id;
      if (this.show) return this.renderShow(root);
      if (!this.info.providers) {
        root.innerHTML = `<div class="empty">${this.title} come from an IPTV provider. Add yours in Settings &gt; Sources (IPTV provider: server, username &amp; password).</div>`;
        return;
      }
      if (!this.cats.length) { root.innerHTML = `<div class="empty">Your IPTV provider didn't list any ${kind}. It may not include them, or it didn't answer; try again later.</div>`; return; }
      const cont = this.continueItems();
      const cats = [...(cont.length ? [{ id: 'continue', name: '▶ Continue watching' }] : []), ...this.cats];
      root.innerHTML = `
        <div class="library">
          <div class="list cats">${cats.map((c) => `<div class="item nav${c.id === this.catId ? ' picked' : ''}" data-key="c-${esc(c.id)}" data-cat="${esc(c.id)}"><div class="main"><div class="t">${esc(c.name)}</div></div></div>`).join('')}</div>
          <div class="posters" id="posters"></div>
          <div class="vod-panel" id="vodInfo"><div class="is">Highlight a title to see what it's about.</div></div>
        </div>`;
      $$('[data-cat]', root).forEach((el) => {
        el.onclick = () => this.pick(el.dataset.cat, true);
        // Highlighting a category shows it after a moment, so scrolling down the list stays quick.
        el._onFocus = () => { clearTimeout(this.loadTimer); this.loadTimer = setTimeout(() => this.pick(el.dataset.cat), 450); };
      });
      if (this.catId === 'continue' || this.items[this.catId]) this.paintPosters(); else this.pick(this.catId);
    },

    async pick(catId, focusFirst) {
      if (catId !== this.catId) { this.catId = catId; this.shown = PAGE; }
      $$('[data-cat]').forEach((el) => el.classList.toggle('picked', el.dataset.cat === catId));
      if (catId !== 'continue' && !this.items[catId]) {
        $('#posters').innerHTML = '<div class="empty">Loading...</div>';
        try { this.items[catId] = await api.get(`/api/vod/${kind}/category/${encodeURIComponent(catId)}`); } catch (e) { $('#posters').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
        if (this.catId !== catId || App.view !== this) return; // moved on meanwhile
      }
      this.paintPosters();
      if (focusFirst) Nav.focus($('#posters .nav'));
    },

    paintPosters() {
      const box = $('#posters');
      if (!box) return;
      if (this.catId === 'continue') {
        box.innerHTML = this.continueItems().map((c) => `<div class="poster nav" data-key="p-${esc(c.id)}" data-cont="${esc(c.id)}">${img(c.poster, c.title)}
          <div class="pt">${esc(c.title)}</div><div class="ps">${esc(c.subtitle || '')}${c.subtitle ? ' · ' : ''}${fmt.clock(c.position)}</div>
          ${c.duration ? `<div class="pbar"><i style="width:${Math.min(100, (c.position / c.duration) * 100)}%"></i></div>` : ''}</div>`).join('');
        $$('[data-cont]', box).forEach((el) => {
          const c = () => this.continueItems().find((x) => x.id === el.dataset.cont);
          el.onclick = () => this.resumeMenu(c());
          el._onFocus = () => { const x = c(); if (x) this.showInfo({ id: x.id, name: x.title, year: movies ? x.subtitle : '' }); };
        });
        return;
      }
      const all = this.items[this.catId];
      if (!all) return;
      if (!all.length) { box.innerHTML = '<div class="empty">Nothing in this category.</div>'; return; }
      box.innerHTML = all.slice(0, this.shown).map((v) => `<div class="poster nav" data-key="p-${esc(v.id)}" data-item="${esc(v.id)}">${img(v.poster, v.name)}
          <div class="pt">${esc(v.name)}</div><div class="ps">${[v.year, v.rating ? `★ ${v.rating}` : ''].filter(Boolean).join(' · ')}</div></div>`).join('')
        + (all.length > this.shown ? `<div class="poster more nav" data-key="more" id="more"><div class="pt">More (${all.length - this.shown} left)</div></div>` : '');
      $$('[data-item]', box).forEach((el) => {
        const v = () => all.find((x) => x.id === el.dataset.item);
        el.onclick = () => this.open(v());
        el._onFocus = () => this.showInfo(v());
      });
      const more = $('#more', box);
      if (more) {
        more.onclick = () => {
          const next = all[this.shown];
          this.shown += PAGE;
          this.paintPosters();
          Nav.focus($(`[data-item="${CSS.escape(next.id)}"]`, box));
        };
      }
    },

    async open(v) {
      if (!v) return;
      if (!movies) { // a show: its seasons and episodes
        let t;
        try { [this.show, t] = await Promise.all([api.get(`/api/vod/show/${encodeURIComponent(v.id)}`), this.tmdb(v.name || '', v.year)]); } catch (e) { toast(e.message); return; }
        this.show.poster ||= v.poster || (t.status === 'found' && t.poster) || '';
        if (t.status === 'found') { this.show.plot ||= t.overview; this.show.rating ||= t.rating; this.show.year ||= t.year; }
        const first = this.show.seasons[0];
        this.season = first && first.season;
        const focus = first && first.episodes[0] ? `e-${first.episodes[0].id}` : null;
        this.fromElsewhere = App.view !== this; // opened from Search: Back goes back there
        if (this.fromElsewhere) App.go(kind, { focus }); else App.render(focus);
        return;
      }
      let m = v;
      try { m = { ...v, ...(await api.get(`/api/vod/movie/${encodeURIComponent(v.id)}`)) }; } catch (_) { /* play anyway */ }
      const t = await this.tmdb(v.name, v.year);
      if (t.status === 'found') { m.plot ||= t.overview; m.rating ||= t.rating; m.poster ||= t.poster; m.year ||= t.year; }
      const saved = this.continueItems().find((c) => c.id === v.id);
      const choices = saved
        ? [{ label: `▶  Resume from ${fmt.clock(saved.position)}`, value: 'resume', cls: 'primary' }, { label: '⟲  Start over', value: 'play' }]
        : [{ label: '▶  Watch', value: 'play', cls: 'primary' }];
      choices.push({ label: 'Close', value: null });
      const body = `<div class="vod-info">${m.poster ? `<img src="${esc(m.poster)}" alt="">` : ''}<div>
        <div class="meta" style="color:var(--muted)">${esc([m.year, m.genre, m.duration ? fmt.dur(m.duration * 1000) : '', m.rating ? `★ ${m.rating}` : ''].filter(Boolean).join(' · '))}</div>
        <div class="s" style="color:#c4d1e6;line-height:1.5">${esc(m.plot || '')}</div>
        ${m.cast ? `<div class="s" style="color:var(--muted)">With ${esc(m.cast)}</div>` : ''}</div></div>`;
      const c = await Modal.menu(m.name, body, choices);
      const item = { title: m.name, subtitle: m.year || '', duration: m.duration || 0, poster: m.poster || '' };
      if (c === 'resume') Player.play('vod', v.id, { offset: saved.position, item });
      if (c === 'play') Player.play('vod', v.id, { item });
    },

    async resumeMenu(c) {
      if (!c) return;
      const item = { title: c.title, subtitle: c.subtitle, duration: c.duration, poster: c.poster, showId: c.showId };
      const v = await Modal.menu(c.title, `<div class="s">${esc(c.subtitle || '')}</div>`, [
        { label: `▶  Resume from ${fmt.clock(c.position)}`, value: 'resume', cls: 'primary' }, { label: '⟲  Start over', value: 'play' },
        ...(c.showId ? [{ label: 'All episodes', value: 'show' }] : []), { label: 'Close', value: null }]);
      if (v === 'resume') Player.play('vod', c.id, { offset: c.position, item });
      if (v === 'play') Player.play('vod', c.id, { item });
      if (v === 'show') this.open({ id: c.showId, name: c.title, poster: c.poster });
    },

    // ---------- one show ----------
    renderShow(root) {
      const s = this.show;
      const season = s.seasons.find((x) => x.season === this.season) || s.seasons[0];
      const saved = new Map(this.continueItems().map((c) => [c.id, c]));
      root.innerHTML = `
        <div class="show">
          <div class="show-head">${s.poster ? `<img src="${esc(s.poster)}" alt="">` : ''}<div>
            <h2><span class="btn nav" data-key="up" id="upBtn">‹ ${esc(this.title)}</span> ${esc(s.name)}</h2>
            <div class="meta">${esc([s.year, s.genre, s.rating ? `★ ${s.rating}` : '', `${s.seasons.length} season${s.seasons.length === 1 ? '' : 's'}`].filter(Boolean).join(' · '))}</div>
            <div class="desc">${esc(s.plot || '')}</div>
            <div class="seasons">${s.seasons.map((x) => `<span class="btn nav${x === season ? ' picked' : ''}" data-key="s-${x.season}" data-season="${x.season}">Season ${x.season}</span>`).join('')}</div>
          </div></div>
          <div class="list" id="eps">${season ? season.episodes.map((e) => {
            const at = saved.get(e.id);
            return `<div class="item nav" data-key="e-${esc(e.id)}" data-ep="${esc(e.id)}"><div class="main"><div class="t">${e.episode ? `${e.episode}. ` : ''}${esc(e.title)}</div>
              <div class="s">${esc(e.plot || '')}</div></div><div class="m">${at ? `Stopped at ${fmt.clock(at.position)}<br>` : ''}${e.duration ? fmt.dur(e.duration * 1000) : ''}</div></div>`;
          }).join('') : '<div class="empty">No episodes listed.</div>'}</div>
        </div>`;
      $('#upBtn', root).onclick = () => this.closeShow();
      $$('[data-season]', root).forEach((el) => { el.onclick = () => { this.season = +el.dataset.season; App.render(`s-${el.dataset.season}`); }; });
      $$('[data-ep]', root).forEach((el) => {
        el.onclick = () => {
          const e = season.episodes.find((x) => x.id === el.dataset.ep), at = saved.get(e.id);
          const item = { title: s.name, subtitle: `S${e.season} E${e.episode}${e.title && !/^episode \d+$/i.test(e.title) ? ` · ${e.title}` : ''}`, duration: e.duration, poster: s.poster, showId: s.id };
          if (at) this.resumeMenu({ ...at, id: e.id, ...item });
          else Player.play('vod', e.id, { item });
        };
      });
    },

    closeShow() {
      const id = this.show.id;
      this.show = null;
      if (this.fromElsewhere) { this.fromElsewhere = false; App.back(); } else App.render(`p-${id}`);
    },

    onBack() {
      if (!this.show) return false;
      this.closeShow();
      return true;
    },

    // Hold OK / M / a long press on a poster or an episode.
    menu() {
      const d = (Nav.current && Nav.current.dataset) || {};
      const items = [];
      const all = this.items[this.catId] || [];
      const v = d.item && all.find((x) => x.id === d.item);
      const c = d.cont && this.continueItems().find((x) => x.id === d.cont);
      if (v) items.push({ label: movies ? '▶ Watch...' : '▦ Episodes', run: () => this.open(v), cls: 'primary' });
      if (c) {
        items.push({ label: `▶ Resume from ${fmt.clock(c.position)}`, run: () => Player.play('vod', c.id, { offset: c.position, item: c }), cls: 'primary' });
        if (c.showId) items.push({ label: 'All episodes', run: () => this.open({ id: c.showId, name: c.title, poster: c.poster }) });
        items.push({ label: '✕ Take off Continue watching', run: async () => { await api.put(`/api/vod/progress/${encodeURIComponent(c.id)}`, { position: 0 }); App.render(); } });
      }
      if (d.ep) items.push({ label: '▶ Play this episode', run: () => Nav.current.click(), cls: 'primary' });
      if (this.show) items.push({ label: `‹ All ${this.title.toLowerCase()}`, run: () => this.closeShow() });
      items.push({ label: `⌕ Search ${this.title.toLowerCase()}`, run: () => { SearchView.kind = kind; App.go('search'); } });
      items.push({ label: '⟳ Reload the list', run: () => { this.cats = null; this.items = {}; App.render(); } });
      const name = v ? v.name : c ? c.title : this.show ? this.show.name : this.title;
      return { title: name, items };
    },
  };
  return view;
}

function img(src, alt) {
  return src ? `<div class="pimg"><img loading="lazy" src="${esc(src)}" alt="" onerror="this.parentNode.classList.add('none');this.remove()"><span>${esc(alt)}</span></div>`
    : `<div class="pimg none"><span>${esc(alt)}</span></div>`;
}

const MoviesView = libraryView('movies');
const ShowsView = libraryView('shows');
