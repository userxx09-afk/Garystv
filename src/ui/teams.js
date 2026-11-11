// My Teams (core/sports.js): the Home row of upcoming games for the teams picked in Settings,
// what to do with a game (watch it, record it), and the team picker in Settings.
/* global App, Player, SettingsView */
const Teams = {
  data: null, // last /api/sports/games answer
  loading: null,

  async load(force = false) {
    if (!force && this.data && Date.now() - this.data.at < 60000) return this.data;
    if (!this.loading) {
      this.loading = api.get('/api/sports/games').then((d) => { this.data = { ...d, at: Date.now() }; return this.data; }).finally(() => { this.loading = null; });
    }
    return this.loading;
  },

  game(id) { return this.data && this.data.games.find((g) => g.id === id); },

  title(g) { return `${g.away.short || g.away.name} ${g.neutral ? 'vs' : 'at'} ${g.home.short || g.home.name}`; },

  // "Sun 12:00 PM", "Live · Q3 4:12", "Final · 24-17"
  when(g) {
    const score = g.home.score != null && g.away.score != null ? `${g.away.abbr || g.away.short} ${g.away.score}, ${g.home.abbr || g.home.short} ${g.home.score}` : '';
    if (g.state === 'in') return `Live · ${g.detail}${score ? ` · ${score}` : ''}`;
    if (g.state === 'post') return `${g.detail || 'Final'}${score ? ` · ${score}` : ''}`;
    if (g.tbd) return `${new Date(g.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, time to be announced`;
    return fmt.when(g.start);
  },

  where(g) {
    const ch = g.channels[0];
    const tv = g.broadcasts.map((b) => b.name).join(', ');
    if (ch && ch.score >= 70) return `${ch.number} ${ch.name}${tv ? ` · ${tv}` : ''}`;
    return tv || 'TV network not announced yet';
  },

  // The Home row. Fills itself in once the schedules arrive.
  strip() {
    const teams = App.state.settings.sportsTeams || [];
    if (!teams.length) {
      return `<div class="strip"><h2>My Teams</h2><div class="cards"><div class="card nav" data-key="t-pick" data-teampick="1"><div class="t">＋ Pick your teams</div><div class="s">See when they play and which channel has the game</div></div></div></div>`;
    }
    return `<div class="strip"><h2>My Teams</h2><div class="cards" id="teamCards"><div class="empty">Getting the schedules...</div></div></div>`;
  },

  wire(root) {
    $$('[data-teampick]', root).forEach((el) => { el.onclick = () => this.openSettings(); });
    const box = $('#teamCards', root);
    if (!box) return;
    this.load().then((d) => {
      if (!document.body.contains(box)) return;
      const cards = d.games.filter((g) => g.state !== 'post' || g.start > Date.now() - 3 * 3600e3).slice(0, 8);
      box.innerHTML = cards.length ? cards.map((g) => `
        <div class="card nav team-card" data-key="g-${esc(g.id)}" data-game="${esc(g.id)}">
          <div class="t">${g.state === 'in' ? '<span class="dot pulse"></span>' : ''}${g.away.logo ? `<img src="${esc(g.away.logo)}" alt="" onerror="this.remove()">` : ''}${esc(this.title(g))}${g.home.logo ? `<img src="${esc(g.home.logo)}" alt="" onerror="this.remove()">` : ''}</div>
          <div class="s">${esc(this.when(g))}</div><div class="s">${esc(this.where(g))}</div></div>`).join('')
        : `<div class="empty">No games in the next two weeks${d.errors.length ? ` (${esc(d.errors[0])})` : ''}.</div>`;
      box.insertAdjacentHTML('beforeend', '<div class="card nav" data-key="t-pick" data-teampick="1"><div class="t">✎ My teams</div><div class="s">Add or remove teams</div></div>');
      $$('[data-teampick]', box).forEach((el) => { el.onclick = () => this.openSettings(); });
      $$('[data-game]', box).forEach((el) => { el.onclick = () => this.gameMenu(this.game(el.dataset.game)); });
    }).catch((e) => { if (document.body.contains(box)) box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  },

  openSettings() { SettingsView.section = 'teams'; App.go('settings'); },

  // Watch (on now or about to start) or record, on each channel that may have it.
  async gameMenu(g) {
    if (!g) return;
    const soon = g.state === 'in' || g.start - Date.now() < 15 * 60000;
    const tv = g.broadcasts.filter((b) => !b.streaming).map((b) => b.name);
    const web = g.broadcasts.filter((b) => b.streaming).map((b) => b.name);
    const body = `<div class="s">${esc(g.leagueLabel)} · ${esc(this.when(g))}</div>
      <div class="s">${tv.length ? `On TV: <b>${esc(tv.join(', '))}</b>` : 'TV network not announced yet.'}${web.length ? `<br>Streaming: ${esc(web.join(', '))} (not a channel here)` : ''}</div>
      ${g.channels.length ? '<div class="s">Channels here that may have it, most likely first:</div>' : `<div class="s">None of your channels look like they have this game${tv.length ? ` (no channel named ${esc(tv.join(' or '))}, and nothing in the guide)` : ''}. Antenna stations named by call sign are only found through the guide, which usually covers the next day or so.</div>`}`;
    const choices = g.channels.map((c, i) => ({
      value: i, cls: i === 0 ? 'primary' : '',
      html: `<div>${soon ? '▶ Watch' : '● Record'} on <b>${esc(c.number)} ${esc(c.name)}</b><div class="s">${esc(c.why)}${c.program ? `: ${esc(c.program.title)}` : ''}</div></div>`,
    }));
    if (soon && g.channels.length) choices.push({ value: 'rec', label: '● Record it instead...' });
    choices.push({ value: null, label: 'Close' });
    const v = await Modal.menu(this.title(g), body, choices);
    if (v === null || v === undefined) return;
    if (v === 'rec') { const i = await Modal.menu('Record on which channel?', '', [...g.channels.map((c, j) => ({ value: j, label: `${c.number} ${c.name}` })), { value: null, label: 'Cancel' }]); if (i != null) await this.record(g, g.channels[i]); return; }
    const c = g.channels[v];
    if (soon) Player.play('live', c.channelId, { here: true });
    else await this.record(g, c);
  },

  // Games run long: an hour extra after the listing (or after the usual length, without one).
  async record(g, c) {
    try {
      const p = c.program;
      const rule = p
        ? { type: 'once', channelId: c.channelId, start: p.start, end: p.end, title: p.title, subtitle: p.subtitle || this.title(g), desc: p.desc || '', categories: p.categories && p.categories.length ? p.categories : ['Sports'], programId: p.programId || '', prePad: 2, postPad: 60 }
        : { type: 'once', channelId: c.channelId, start: g.start - 10 * 60000, end: g.endGuess + 45 * 60000, title: `${g.leagueLabel}: ${this.title(g)}`, prePad: 0, postPad: 0, categories: ['Sports'] };
      await api.post('/api/rules', rule);
      toast(`● Will record ${this.title(g)} on ${c.number} ${c.name}, with an hour extra in case it runs long`, 6000);
      await App.loadAll();
    } catch (e) { toast(e.message); }
  },

  // ---------- Settings > My Teams ----------
  league: 'nfl',
  filter: '',

  async settings(pane) {
    const mine = App.state.settings.sportsTeams || [];
    const leagues = await api.get('/api/sports/leagues').catch(() => []);
    if (!document.body.contains(pane)) return;
    pane.innerHTML = `
      <div class="box"><h3>My Teams</h3>
        <div class="s">Home shows your teams' next games and which of your channels has each one: from the guide listings, and from the TV network the game is on (schedules from ESPN).</div>
        <div id="mine">${mine.length ? mine.map((t, i) => `<div class="row">${t.logo ? `<img class="team-logo" src="${esc(t.logo)}" alt="" onerror="this.remove()">` : ''}<b>${esc(t.name)}</b> <span class="s">${esc((leagues.find((l) => l.id === t.league) || {}).label || t.league)}</span>
          <span class="btn nav" data-key="rm-${i}" data-rm="${i}">Remove</span></div>`).join('') : '<div class="s">No teams yet. Pick a league below, then a team.</div>'}</div></div>
      <div class="box"><h3>Add a team</h3><div id="leagueRow"></div>
        <div class="field"><label>Find</label><input id="teamFind" class="nav" data-key="team-find" placeholder="City or name" value="${esc(this.filter)}"></div>
        <div id="teamList" class="team-list"><div class="s">Loading teams...</div></div></div>`;
    const idx = Math.max(0, leagues.findIndex((l) => l.id === this.league));
    if (leagues.length) $('#leagueRow', pane).appendChild(optionRow('League', leagues.map((l) => ({ label: l.label, value: l.id })), idx, (v) => { this.league = v; this.teamList(pane); }));
    const save = async (list) => {
      try { await api.put('/api/settings', { sportsTeams: list }); App.state.settings.sportsTeams = list; this.data = null; this.settings(pane); } catch (e) { toast(e.message); }
    };
    this.save = save;
    $$('[data-rm]', pane).forEach((el) => { el.onclick = () => save(mine.filter((_, i) => i !== +el.dataset.rm)); });
    const find = $('#teamFind', pane);
    let t;
    find.oninput = () => { clearTimeout(t); t = setTimeout(() => { this.filter = find.value; this.teamList(pane); }, 250); };
    this.teamList(pane);
  },

  async teamList(pane) {
    const box = $('#teamList', pane);
    const league = this.league;
    let teams;
    try { teams = await api.get(`/api/sports/teams?league=${league}`); } catch (e) { box.innerHTML = `<div class="s">${esc(e.message)}</div>`; return; }
    if (!document.body.contains(box) || league !== this.league) return;
    const mine = App.state.settings.sportsTeams || [];
    const want = this.filter.trim().toLowerCase();
    const list = teams.filter((x) => !want || `${x.name} ${x.abbr}`.toLowerCase().includes(want)).slice(0, 60);
    box.innerHTML = list.length ? list.map((x, i) => {
      const have = mine.some((m) => m.league === x.league && m.id === x.id);
      return `<span class="btn nav ${have ? 'on' : ''}" data-key="tm-${esc(x.league)}-${esc(x.id)}" data-teamadd="${i}">${x.logo ? `<img class="team-logo" src="${esc(x.logo)}" alt="" onerror="this.remove()">` : ''}${have ? '✓ ' : ''}${esc(x.name)}</span>`;
    }).join('') : '<div class="s">No team matches.</div>';
    $$('[data-teamadd]', box).forEach((el) => {
      el.onclick = () => {
        const x = list[+el.dataset.teamadd];
        if (mine.some((m) => m.league === x.league && m.id === x.id)) { this.save(mine.filter((m) => !(m.league === x.league && m.id === x.id))); return; }
        if (mine.length >= 12) { toast('That\'s 12 teams already. Remove one first.'); return; }
        this.save([...mine, x]);
      };
    });
  },
};
