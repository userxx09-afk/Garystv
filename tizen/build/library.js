// Movies and Shows: the on-demand library of the IPTV provider (core/vod.js).
// Categories down the left, posters on the right; a show opens its seasons and
// episodes. Where you stopped is remembered, so "Continue watching" picks up there.
/* global App, Player */
const PAGE = 60; // posters drawn at a time; "More" adds the next lot (TVs slow down with thousands)

function libraryView(kind) {
  const movies = kind === 'movies';
  const view = {
    title: movies ? 'Movies' : 'Shows',
    hints: [['←→↑↓', 'Move'], ['OK', movies ? 'Watch' : 'Open'], ['Esc', 'Back']],
    cats: null, catId: null, items: {}, shown: PAGE, info: null, show: null, season: null, loadTimer: null,

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
        $$('[data-cont]', box).forEach((el) => { el.onclick = () => this.resumeMenu(this.continueItems().find((c) => c.id === el.dataset.cont)); });
        return;
      }
      const all = this.items[this.catId];
      if (!all) return;
      if (!all.length) { box.innerHTML = '<div class="empty">Nothing in this category.</div>'; return; }
      box.innerHTML = all.slice(0, this.shown).map((v) => `<div class="poster nav" data-key="p-${esc(v.id)}" data-item="${esc(v.id)}">${img(v.poster, v.name)}
          <div class="pt">${esc(v.name)}</div><div class="ps">${[v.year, v.rating ? `★ ${v.rating}` : ''].filter(Boolean).join(' · ')}</div></div>`).join('')
        + (all.length > this.shown ? `<div class="poster more nav" data-key="more" id="more"><div class="pt">More (${all.length - this.shown} left)</div></div>` : '');
      $$('[data-item]', box).forEach((el) => { el.onclick = () => this.open(all.find((v) => v.id === el.dataset.item)); });
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
        try { this.show = await api.get(`/api/vod/show/${encodeURIComponent(v.id)}`); } catch (e) { toast(e.message); return; }
        this.show.poster ||= v.poster;
        const first = this.show.seasons[0];
        this.season = first && first.season;
        App.render(first && first.episodes[0] ? `e-${first.episodes[0].id}` : null);
        return;
      }
      let m = v;
      try { m = { ...v, ...(await api.get(`/api/vod/movie/${encodeURIComponent(v.id)}`)) }; } catch (_) { /* play anyway */ }
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
      if (v === 'show') this.open({ id: c.showId, poster: c.poster });
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
      App.render(`p-${id}`);
    },

    onKey(e) {
      if ((e.key === 'Escape' || e.key === 'Backspace') && this.show) { this.closeShow(); return true; }
      return false;
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
