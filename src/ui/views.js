// Home menu, My Recordings (DVR), Timers and Search screens.
/* global App, Player, GuideView, MoviesView, ShowsView */
const ICONS = {
  guide: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M3 14.5h18"/></svg>',
  live: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="13" rx="2"/><path d="M8 21h8M10 9.5v5l4.5-2.5z"/></svg>',
  dvr: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="8" cy="12" r="2.2" fill="#ff3355" stroke="none"/><path d="M13 11h5M13 13.5h3"/></svg>',
  movies: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4"/></svg>',
  shows: '<svg viewBox="0 0 24 24"><rect x="2.5" y="7" width="19" height="13" rx="2"/><path d="M8 3l4 4 4-4M6 4.5h0"/><path d="M10 11v5l4-2.5z"/></svg>',
  timers: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
};

// ---------------- Home ----------------
const HomeView = {
  title: '',
  hints: [['←→↑↓', 'Move'], ['OK', 'Select'], ['M', 'Menu'], ['G', 'Guide'], ['D', 'My Recordings'], ['T', 'Timers'], ['S', 'Search']],
  render(root) {
    const h = new Date().getHours();
    const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const sched = App.schedule.filter((j) => j.status === 'recording' || j.status === 'scheduled').slice(0, 5);
    const recent = App.recordings.filter((r) => r.status !== 'failed').slice(0, 6);
    root.innerHTML = `
      <div class="home">
        <div class="home-head"><img class="logo" src="logo.jpg" alt=""><h1>${greet}. <b>What would you like to watch?</b></h1>${window.GTV_SERVER ? `<div class="on-pc">On <b>${esc(App.state.status.platform === 'linux' ? 'the home server' : 'the Windows PC')}</b><br>${esc(window.GTV_SERVER.replace(/^https?:\/\//, '').replace(/:5480$/, ''))}</div>` : ''}</div>
        <div class="tiles">
          ${[['guide', 'Guide', 'See what\'s on'], ['live', 'Live TV', 'Last channel'], ['movies', 'Movies', 'On demand'], ['shows', 'Shows', 'Every episode'], ['dvr', 'My Recordings', `${App.recordings.length} shows`],
            ['timers', 'Timers', `${App.state.rules.length} set`], ['search', 'Search', 'Find a show'], ['settings', 'Settings', 'Antenna, guide, channels']]
            .map(([k, l, s]) => `<div class="tile nav" data-key="${k}" data-go="${k}">${ICONS[k]}<div>${l}</div><small>${esc(s)}</small></div>`).join('')}
        </div>
        <div class="strip"><h2>Favorites</h2><div class="cards">${(App.state.favLists || []).map((l) => `
          <div class="card nav" data-key="f-${esc(l.id)}" data-fav="${esc(l.id)}"><div class="t"><span class="fav">★</span>${esc(l.name)}</div>
          <div class="s">${l.channelIds.length} channel${l.channelIds.length === 1 ? '' : 's'}</div></div>`).join('')}
          <div class="card nav" data-key="f-new" data-favnew="1"><div class="t">＋ New favorites list</div><div class="s">For example, Gary's Favorites</div></div></div></div>
        <div class="strip"><h2>Recording now &amp; up next</h2><div class="cards">${sched.length ? sched.map((j) => `
          <div class="card nav" data-key="j-${esc(j.id)}" data-job="${esc(j.id)}"><div class="t">${j.status === 'recording' ? '<span class="dot pulse"></span>' : '<span class="dot"></span>'}${esc(j.title)}</div>
          <div class="s">${j.status === 'recording' ? 'Recording now' : fmt.when(j.start)} · ${esc(j.channelNumber)} ${esc(j.channelName)}</div></div>`).join('') : '<div class="empty">Nothing scheduled. Open the Guide and press R on a show to record it.</div>'}</div></div>
        <div class="strip"><h2>Recently recorded</h2><div class="cards">${recent.length ? recent.map((r) => `
          <div class="card nav" data-key="r-${r.id}" data-rec="${r.id}"><div class="t">${r.status === 'recording' ? '<span class="dot pulse"></span>' : ''}${esc(r.title)}</div>
          <div class="s">${esc(fmt.se(r) || r.subtitle || fmt.when(r.start))}</div></div>`).join('') : '<div class="empty">Your recordings will show up here.</div>'}</div></div>
      </div>`;
    $$('[data-go]', root).forEach((el) => {
      el.onclick = () => {
        const k = el.dataset.go;
        if (k === 'live') {
          const ch = App.lastChannel || (App.guideRows && App.guideRows[0] && App.guideRows[0].id) || (App.state.channels.find((c) => !c.hidden) || {}).id;
          if (ch) Player.play('live', ch); else toast('No channels yet - add your tuner in Settings.');
        } else {
          if (k === 'guide') GuideView.setList(null); // the Guide tile is every channel; a favorites card is one list
          App.go(k);
        }
      };
    });
    $$('[data-fav]', root).forEach((el) => { el.onclick = () => { GuideView.setList(el.dataset.fav); App.go('guide'); }; });
    $$('[data-favnew]', root).forEach((el) => {
      el.onclick = async () => {
        const name = await Modal.prompt('New favorites list', "Name (for example, Gary's Favorites)", '', 'Create');
        if (!name) return;
        try {
          await api.post('/api/favlists', { name });
          await App.loadAll();
          GuideView.setList(null);
          App.go('guide');
          toast(`Made ${name}. Now ${window.GTV_SERVER ? 'hold OK' : 'press M'} on each channel you want and choose Add.`, 7000);
        } catch (e) { toast(e.message); }
      };
    });
    $$('[data-rec]', root).forEach((el) => { el.onclick = () => DvrView.recordingMenu(App.recordings.find((r) => r.id === el.dataset.rec)); });
    $$('[data-job]', root).forEach((el) => { el.onclick = () => App.go('timers'); });
  },

  menu() {
    const el = Nav.current, d = (el && el.dataset) || {};
    const items = [];
    const l = d.fav && (App.state.favLists || []).find((x) => x.id === d.fav);
    const r = d.rec && App.recordings.find((x) => x.id === d.rec);
    if (l) {
      const after = async () => { await App.loadAll(); App.render(); };
      items.push({ label: `▦ Open ${l.name} in the Guide`, run: () => el.click(), cls: 'primary' });
      items.push({ label: `✎ Rename ${l.name}...`, run: async () => { const name = await Modal.prompt(`Rename ${l.name}`, 'New name', l.name); if (name) { await api.put(`/api/favlists/${l.id}`, { name }); await after(); } } });
      items.push({ label: `✕ Delete ${l.name}`, cls: 'danger', run: async () => { if (await Modal.confirm(`Delete ${l.name}?`, 'The channels stay in the guide; only this list goes.', 'Delete list')) { await api.del(`/api/favlists/${l.id}`); await after(); } } });
    } else if (r) items.push(...DvrView.menuFor(r));
    else if (el) items.push({ label: 'Open', run: () => el.click(), cls: 'primary' });
    items.push({ label: '▶ Live TV (last channel)', run: () => $('[data-go="live"]').click() });
    return { title: 'GarysTV', items };
  },
};

// ---------------- My Recordings ----------------
const DvrView = {
  title: 'My Recordings',
  folder: null,
  hints: [['↑↓', 'Move'], ['OK', 'Play / open'], ['M', 'Menu'], ['Del', 'Delete'], ['Esc', 'Back']],

  groups() {
    const map = new Map();
    for (const r of App.recordings) {
      const k = r.title.toLowerCase();
      if (!map.has(k)) map.set(k, { title: r.title, items: [] });
      map.get(k).items.push(r);
    }
    return [...map.values()];
  },

  render(root) {
    const st = App.state.status;
    let entries;
    if (this.folder) {
      entries = App.recordings.filter((r) => r.title.toLowerCase() === this.folder).map((r) => ({ rec: r }));
    } else {
      entries = this.groups().map((g) => (g.items.length > 1 ? { folder: g } : { rec: g.items[0] }));
    }
    root.innerHTML = `
      <div class="split">
        <div class="col">
          <h2>${this.folder ? `<span class="btn nav" data-key="up" id="upBtn">‹ All recordings</span> ${esc(entries[0] ? entries[0].rec.title : '')}` : 'All recordings'}
            <span class="r">${App.recordings.length} recordings${st.diskFree != null ? ` · ${fmt.size(st.diskFree)} free` : ''}</span></h2>
          <div class="list" id="dvrList">${entries.length ? entries.map((e) => (e.folder ? `
            <div class="item nav" data-key="f-${esc(e.folder.title)}" data-folder="${esc(e.folder.title.toLowerCase())}">
              <div class="main"><div class="t">📁 ${esc(e.folder.title)}</div><div class="s">Latest: ${fmt.when(e.folder.items[0].start)}</div></div>
              <span class="count">${e.folder.items.length}</span></div>` : recItem(e.rec))).join('') : '<div class="empty">No recordings yet.<br>In the Guide, highlight a show and press <b>R</b> (or click it and choose Record).</div>'}
          </div>
        </div>
        <div class="col"><h2>Details</h2><div class="detail" id="dvrDetail"><div class="empty">Highlight a recording to see details.</div></div></div>
      </div>`;
    const up = $('#upBtn', root);
    if (up) up.onclick = () => this.onBack();
    $$('[data-folder]', root).forEach((el) => {
      el.onclick = () => { this.folder = el.dataset.folder; App.render(); };
      el._onFocus = () => this.showFolder(this.groups().find((g) => g.title.toLowerCase() === el.dataset.folder));
    });
    $$('[data-rec]', root).forEach((el) => {
      const rec = () => App.recordings.find((r) => r.id === el.dataset.rec);
      el.onclick = () => this.recordingMenu(rec());
      el._onFocus = () => this.showRec(rec());
    });
  },

  showFolder(g) {
    if (!g) return;
    $('#dvrDetail').innerHTML = `<div class="title">${esc(g.title)}</div><div class="meta">${g.items.length} recordings · ${fmt.size(g.items.reduce((a, r) => a + (r.size || 0), 0))}</div>
      <div class="desc">${esc(g.items[0].desc || '')}</div><div class="s">Press OK to open this folder.</div>`;
  },

  showRec(r) {
    if (!r) return;
    $('#dvrDetail').innerHTML = `<div class="title">${esc(r.title)}</div>
      <div class="sub">${esc([fmt.se(r), r.subtitle].filter(Boolean).join('  ·  '))}</div>
      <div class="meta"><span>${esc(r.channelNumber)} ${esc(r.channelName)}</span><span>${fmt.when(r.start)}</span><span>${fmt.dur(r.end - r.start)}</span><span>${fmt.size(r.size)}</span>
        <span class="status-pill st-${r.status}">${r.status === 'recording' ? '● Recording' : r.status}</span>${r.simulated ? '<span class="tag">PRACTICE</span>' : ''}</div>
      ${r.error ? `<div class="s" style="color:var(--yellow)">${esc(r.error)}</div>` : ''}
      <div class="desc">${esc(r.desc || '')}</div>
      ${r.position > 30 ? `<div class="s">Stopped at ${fmt.clock(r.position)}</div>` : ''}`;
  },

  async recordingMenu(r) {
    if (!r) return;
    const choices = [];
    if (r.position > 30 && !r.watched) choices.push({ label: `▶  Resume from ${fmt.clock(r.position)}`, value: 'resume', cls: 'primary' });
    choices.push({ label: r.position > 30 ? '⟲  Start over' : '▶  Play', value: 'play', cls: r.position > 30 ? '' : 'primary' });
    if (r.status === 'recording') choices.push({ label: '■  Stop recording', value: 'stop' });
    choices.push({ label: r.watched ? 'Mark as not watched' : 'Mark as watched', value: 'watched' });
    choices.push({ label: '🗑  Delete', value: 'delete', cls: 'danger' }, { label: 'Cancel', value: null });
    const v = await Modal.menu(r.title, `<div class="s">${esc([fmt.se(r), r.subtitle, fmt.when(r.start)].filter(Boolean).join('  ·  '))}</div>`, choices);
    if (v === 'resume') Player.play('rec', r.id, { offset: r.position });
    if (v === 'play') Player.play('rec', r.id);
    if (v === 'stop') { await api.post('/api/jobs/skip', { id: r.jobId }); toast('Recording stopped'); }
    if (v === 'watched') await api.put(`/api/recordings/${r.id}`, { watched: !r.watched, position: r.position });
    if (v === 'delete') this.remove(r);
  },

  async remove(r) {
    if (!(await Modal.confirm('Delete recording?', `${r.title}${r.subtitle ? ` - ${r.subtitle}` : ''} will be permanently deleted.`, 'Delete'))) return;
    await api.del(`/api/recordings/${r.id}`);
    toast('Recording deleted');
  },

  // What the menu offers for one recording.
  menuFor(r) {
    const items = [];
    if (r.position > 30 && !r.watched) items.push({ label: `▶ Resume from ${fmt.clock(r.position)}`, run: () => Player.play('rec', r.id, { offset: r.position }), cls: 'primary' });
    items.push({ label: r.position > 30 ? '⟲ Start over' : '▶ Play', run: () => Player.play('rec', r.id), cls: r.position > 30 ? '' : 'primary' });
    if (r.status === 'recording') items.push({ label: '■ Stop recording', run: async () => { await api.post('/api/jobs/skip', { id: r.jobId }); toast('Recording stopped'); } });
    items.push({ label: r.watched ? 'Mark as not watched' : 'Mark as watched', run: () => api.put(`/api/recordings/${r.id}`, { watched: !r.watched, position: r.position }) });
    items.push({ label: '🗑 Delete...', run: () => this.remove(r), cls: 'danger' });
    return items;
  },

  menu() {
    const d = (Nav.current && Nav.current.dataset) || {};
    const r = d.rec && App.recordings.find((x) => x.id === d.rec);
    const items = r ? this.menuFor(r) : [];
    if (d.folder) items.push({ label: 'Open this folder', run: () => Nav.current.click(), cls: 'primary' });
    if (this.folder) items.push({ label: '‹ All recordings', run: () => this.onBack() });
    return { title: r ? r.title : this.title, body: r ? `<div class="s">${esc([fmt.se(r), r.subtitle, fmt.when(r.start)].filter(Boolean).join('  ·  '))}</div>` : '', items };
  },

  // Back inside a folder: out to all recordings, on the folder you were in.
  onBack() {
    if (!this.folder) return false;
    const g = this.groups().find((x) => x.title.toLowerCase() === this.folder);
    this.folder = null;
    App.render(g ? `f-${g.title}` : null);
    return true;
  },

  onKey(e) {
    if (e.key === 'Delete') {
      const id = Nav.current && Nav.current.dataset.rec;
      if (id) this.remove(App.recordings.find((r) => r.id === id));
      return true;
    }
    return false;
  },
};

function recItem(r) {
  return `<div class="item nav ${r.watched || r.status === 'recording' ? '' : 'unwatched'}" data-key="r-${r.id}" data-rec="${r.id}">
    <div class="main"><div class="t">${r.status === 'recording' ? '<span class="dot pulse"></span>' : ''}${esc(r.subtitle || r.title)}</div>
    <div class="s">${esc([fmt.se(r), `${r.channelNumber} ${r.channelName}`].filter(Boolean).join('  ·  '))}</div></div>
    <div class="m">${fmt.when(r.start)}<br>${r.status !== 'complete' ? `<span class="status-pill st-${r.status}">${r.status}</span>` : fmt.dur(r.end - r.start)}</div></div>`;
}

// ---------------- Timers ----------------
const TimersView = {
  title: 'Timers',
  tab: 'schedule',
  hints: [['↑↓', 'Move'], ['OK', 'Options'], ['←→', 'Switch list'], ['M', 'Menu'], ['Esc', 'Back']],

  describe(r) {
    const ch = r.channelId ? App.state.channels.find((c) => c.id === r.channelId) : null;
    const chName = ch ? `${ch.number} ${ch.name}` : 'Any channel';
    if (r.type === 'once') return `This show only · ${fmt.when(r.start)} · ${chName}`;
    if (r.type === 'manual') return `${r.date ? r.date : (r.days || []).map((d) => 'Sun Mon Tue Wed Thu Fri Sat'.split(' ')[d]).join(', ')} at ${r.time} for ${r.minutes} min · ${chName}`;
    return `Series · ${r.newOnly ? 'New episodes' : 'All episodes'} · ${chName}${r.keep ? ` · Keep ${r.keep}` : ''}`;
  },

  render(root) {
    const rules = App.state.rules;
    const jobs = App.schedule.filter((j) => j.recEnd > Date.now());
    const listHtml = this.tab === 'rules'
      ? (rules.length ? rules.map((r, i) => `
        <div class="item nav" data-key="rule-${r.id}" data-rule="${r.id}"><span class="count">${i + 1}</span>
          <div class="main"><div class="t">${r.type === 'series' ? '<span class="dot series"></span>' : '<span class="dot"></span>'}${esc(r.title)}${r.enabled === false ? ' <span class="tag">OFF</span>' : ''}</div><div class="s">${esc(this.describe(r))}</div></div></div>`).join('')
        : '<div class="empty">No timers yet. In the Guide, highlight a show and press <b>R</b>.</div>')
      : (jobs.length ? jobs.map((j) => `
        <div class="item nav" data-key="job-${esc(j.id)}" data-job="${esc(j.id)}">
          <div class="main"><div class="t">${esc(j.title)}</div><div class="s">${esc([fmt.se(j), j.subtitle, `${j.channelNumber} ${j.channelName}`].filter(Boolean).join('  ·  '))}</div></div>
          <div class="m">${fmt.when(j.start)}<br><span class="status-pill st-${j.status}">${j.status === 'scheduled' ? 'Will record' : j.status}</span></div></div>`).join('')
        : '<div class="empty">Nothing is scheduled to record.</div>');
    root.innerHTML = `
      <div class="tabs"><div class="tab nav ${this.tab === 'schedule' ? 'on' : ''}" data-key="tab-s" data-tab="schedule">Upcoming recordings</div>
        <div class="tab nav ${this.tab === 'rules' ? 'on' : ''}" data-key="tab-r" data-tab="rules">Timers &amp; priority</div>
        <div class="tab nav" data-key="manual" id="manualBtn">+ Manual timer</div></div>
      <div class="split"><div class="col"><div class="list">${listHtml}</div></div>
        <div class="col"><div class="detail" id="tDetail"><div class="empty">${this.tab === 'rules'
          ? 'Timers higher on this list win when there are not enough tuners. Open a timer to move it up or down.'
          : 'Shows marked <b>conflict</b> can\'t record because all tuners are busy. Raise that timer\'s priority, or skip another show.'}</div></div></div></div>`;
    $$('[data-tab]', root).forEach((el) => { el.onclick = () => { this.tab = el.dataset.tab; App.render(); }; });
    $('#manualBtn', root).onclick = () => App.manualDialog();
    $$('[data-rule]', root).forEach((el) => {
      const r = () => App.state.rules.find((x) => x.id === el.dataset.rule);
      el.onclick = () => this.ruleMenu(r());
      el._onFocus = () => { const x = r(); $('#tDetail').innerHTML = `<div class="title">${esc(x.title)}</div><div class="meta">${esc(this.describe(x))}</div><div class="s">${App.schedule.filter((j) => j.ruleId === x.id && j.status === 'scheduled').length} upcoming recordings</div>`; };
    });
    $$('[data-job]', root).forEach((el) => {
      const j = () => App.schedule.find((x) => x.id === el.dataset.job);
      el.onclick = () => this.jobMenu(j());
      el._onFocus = () => {
        const x = j();
        if (!x) return;
        $('#tDetail').innerHTML = `<div class="title">${esc(x.title)}</div><div class="sub">${esc([fmt.se(x), x.subtitle].filter(Boolean).join('  ·  '))}</div>
          <div class="meta"><span>${esc(x.channelNumber)} ${esc(x.channelName)}</span><span>${fmt.when(x.start)}</span><span>${fmt.dur(x.end - x.start)}</span>${x.isNew ? '<span class="tag new">NEW</span>' : ''}<span class="status-pill st-${x.status}">${x.status}</span></div>
          ${x.reason ? `<div class="s" style="color:var(--yellow)">${esc(x.reason)}</div>` : ''}<div class="desc">${esc(x.desc)}</div>`;
      };
    });
  },

  async ruleMenu(r) {
    if (!r) return;
    const choices = [];
    if (r.type === 'series') choices.push({ label: 'Change options', value: 'edit', cls: 'primary' });
    choices.push({ label: '▲  Higher priority', value: 'up' }, { label: '▼  Lower priority', value: 'down' },
      { label: r.enabled === false ? 'Turn timer on' : 'Turn timer off', value: 'toggle' }, { label: '🗑  Delete timer', value: 'delete', cls: 'danger' }, { label: 'Cancel', value: null });
    const v = await Modal.menu(r.title, `<div class="s">${esc(this.describe(r))}</div>`, choices);
    if (v === 'edit') {
      const ch = r.channelId ? App.state.channels.find((c) => c.id === r.channelId) : null;
      await App.seriesDialog(ch ? { id: ch.id, number: ch.number, name: ch.name } : null, { title: r.title }, r);
    }
    if (v === 'up' || v === 'down') await api.post(`/api/rules/${r.id}/move`, { delta: v === 'up' ? -1 : 1 });
    if (v === 'toggle') await api.put(`/api/rules/${r.id}`, { enabled: r.enabled === false });
    if (v === 'delete' && (await Modal.confirm('Delete timer?', `"${r.title}" will no longer record. Existing recordings are kept.`, 'Delete timer'))) await api.del(`/api/rules/${r.id}`);
  },

  async jobMenu(j) {
    if (!j) return;
    const choices = j.status === 'skipped' && j.reason === 'Cancelled by you'
      ? [{ label: 'Record this one after all', value: 'unskip', cls: 'primary' }]
      : [{ label: j.status === 'recording' ? '■  Stop recording' : 'Don\'t record this one', value: 'skip', cls: 'danger' }];
    choices.push({ label: 'Go to its timer', value: 'rule' }, { label: 'Cancel', value: null });
    const v = await Modal.menu(j.title, `<div class="s">${esc(fmt.when(j.start))} · ${esc(j.channelNumber)} ${esc(j.channelName)}${j.reason ? `<br>${esc(j.reason)}` : ''}</div>`, choices);
    if (v === 'skip' || v === 'unskip') await api.post('/api/jobs/skip', { id: j.id, skip: v === 'skip' });
    if (v === 'rule') { this.tab = 'rules'; App.render(`rule-${j.ruleId}`); }
  },

  menu() {
    const d = (Nav.current && Nav.current.dataset) || {};
    const items = [];
    const rule = d.rule && App.state.rules.find((x) => x.id === d.rule);
    const job = d.job && App.schedule.find((x) => x.id === d.job);
    if (rule) items.push({ label: `Options for "${rule.title}"...`, run: () => this.ruleMenu(rule), cls: 'primary' });
    if (job) items.push({ label: `Options for "${job.title}"...`, run: () => this.jobMenu(job), cls: 'primary' });
    items.push({ label: '+ Manual timer...', run: () => App.manualDialog() });
    items.push({ label: this.tab === 'rules' ? 'Show upcoming recordings' : 'Show timers & priority', run: () => { this.tab = this.tab === 'rules' ? 'schedule' : 'rules'; App.render(); } });
    return { title: this.title, items };
  },

  onKey(e) {
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && Nav.current && !Nav.current.classList.contains('tab') && !Nav.current.closest('#topnav')) {
      this.tab = this.tab === 'rules' ? 'schedule' : 'rules';
      App.render();
      return true;
    }
    return false;
  },
};

// ---------------- Search ----------------
// One box for everything: channels, what's on TV, recordings, movies and shows.
// Movies and shows come from the IPTV provider's library and can take a moment, so
// they're asked for separately and appear when they arrive.
const KINDS = [['all', 'Everything'], ['channels', 'Channels'], ['programs', 'On TV'], ['recordings', 'Recordings'], ['movies', 'Movies'], ['shows', 'Shows']];
const SearchView = {
  title: 'Search',
  q: '',
  kind: 'all',
  res: {},
  items: [],
  vodWaiting: false,
  seq: 0,
  hints: [['Type', 'Search'], ['↓', 'Results'], ['OK', 'Open'], ['M', 'Menu'], ['Esc', 'Back']],

  render(root) {
    root.innerHTML = `
      <div class="searchbox">${ICONS.search.replace('<svg', '<svg width="32" height="32" stroke="currentColor" fill="none" stroke-width="2"')}<input id="q" class="nav" data-key="q" placeholder="Channels, shows, movies, recordings..." value="${esc(this.q)}"></div>
      <div class="tabs" id="skinds"></div>
      <div class="col" style="flex:1;min-height:0"><div class="list" id="sres"></div></div>`;
    const input = $('#q', root);
    let timer;
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(() => this.search(input.value), 300); };
    input._onFocus = () => input.focus(); // reached with the arrows: OK brings up the TV's keyboard
    if (!this.q) setTimeout(() => { if (App.view === this && !Modal.top()) Nav.focus(input); }, 0);
    this.paint();
  },

  async search(q) {
    this.q = q;
    const seq = ++this.seq;
    if (q.trim().length < 2) { this.res = {}; this.vodWaiting = false; this.paint(); return; }
    this.vodWaiting = true;
    const vod = api.get(`/api/vod/search?q=${encodeURIComponent(q)}`).catch(() => ({ movies: [], shows: [] }));
    try {
      const r = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      if (seq !== this.seq) return;
      this.res = { ...r, movies: null, shows: null };
    } catch (e) { toast(e.message); }
    this.paint();
    const v = await vod;
    if (seq !== this.seq) return;
    if (!MoviesView.info) { try { MoviesView.info = ShowsView.info = await api.get('/api/vod'); } catch (_) { /* favorites show as not set */ } }
    this.vodWaiting = false;
    Object.assign(this.res, v);
    this.paint();
  },

  // Each result as { key, html, open(), more: [menu items] }.
  rows(kind) {
    const list = this.res[kind] || [];
    if (kind === 'channels') {
      return list.map((c) => ({
        key: `c-${c.id}`,
        html: `<div class="main"><div class="t">${c.logo ? `<img class="slogo" src="${esc(c.logo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}${esc(c.number)} ${esc(c.name)}</div><div class="s">${esc(c.group || 'Channel')}</div></div><div class="m">Watch</div>`,
        open: () => Player.play('live', c.id),
        more: [...App.channelFavItems(c), ...App.recordItems(c, null), { label: '▦ Find it in the Guide', run: () => { GuideView.filter = null; GuideView.setList(null, c.id); App.go('guide'); } }],
      }));
    }
    if (kind === 'programs') {
      return list.map((p) => {
        const row = { id: p.channelId, number: p.number, name: p.channelName };
        return {
          key: `p-${p.channelId}-${p.start}`,
          html: `<div class="main"><div class="t">${p.isNew ? '<span class="tag new">NEW</span>' : ''}${esc(p.title)}</div>
            <div class="s">${esc([fmt.se(p), p.subtitle, `${p.number} ${p.channelName}`].filter(Boolean).join('  ·  '))}</div></div><div class="m">${p.start <= Date.now() ? 'On now' : fmt.when(p.start)}</div>`,
          open: () => App.programDialog(row, p).then(() => this.search(this.q)),
          more: [
            ...(p.start <= Date.now() ? [{ label: '▶ Watch now', run: () => Player.play('live', p.channelId) }] : []),
            ...App.recordItems(row, p),
          ],
        };
      });
    }
    if (kind === 'recordings') {
      return list.map((rec) => ({
        key: `r-${rec.id}`,
        html: `<div class="main"><div class="t">${esc(rec.title)}</div><div class="s">${esc([fmt.se(rec), rec.subtitle, `${rec.channelNumber} ${rec.channelName}`].filter(Boolean).join('  ·  '))}</div></div><div class="m">${fmt.when(rec.start)}</div>`,
        open: () => DvrView.recordingMenu(App.recordings.find((x) => x.id === rec.id) || rec),
        more: DvrView.menuFor(App.recordings.find((x) => x.id === rec.id) || rec),
      }));
    }
    const lib = kind === 'movies' ? MoviesView : ShowsView;
    return list.map((v) => ({
      key: `${kind[0]}-${v.id}`,
      html: `${v.poster ? `<img class="sposter" src="${esc(v.poster)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<div class="main"><div class="t">${esc(v.name)}</div>
        <div class="s">${esc([kind === 'movies' ? 'Movie' : 'Show', v.year, v.rating ? `★ ${v.rating}` : ''].filter(Boolean).join(' · '))}</div></div><div class="m">${kind === 'movies' ? 'Watch' : 'Episodes'}</div>`,
      open: () => lib.open(v),
      more: [lib.favItem(v)],
    }));
  },

  paint() {
    const box = $('#sres'), tabs = $('#skinds');
    if (!box) return;
    const r = this.res;
    const asked = this.q.trim().length >= 2;
    const name = (k) => KINDS.find(([x]) => x === k)[1];
    tabs.innerHTML = asked ? KINDS.map(([k, label]) => {
      const n = k === 'all' ? '' : r[k] ? ` ${r[k].length}` : ' …';
      return `<div class="tab nav${this.kind === k ? ' on' : ''}" data-key="k-${k}" data-kind="${k}">${label}${n}</div>`;
    }).join('') : '';
    $$('[data-kind]', tabs).forEach((el) => { el.onclick = () => { this.kind = el.dataset.kind; this.paint(); }; });
    this.items = [];
    let html = '';
    const kinds = this.kind === 'all' ? KINDS.slice(1).map(([k]) => k) : [this.kind];
    for (const k of kinds) {
      const rows = this.rows(k);
      const shown = this.kind === 'all' ? rows.slice(0, 5) : rows;
      if (!shown.length) continue;
      if (this.kind === 'all') html += `<div class="shead">${name(k)}</div>`;
      for (const row of shown) {
        html += `<div class="item nav" data-key="${esc(row.key)}" data-n="${this.items.length}">${row.html}</div>`;
        this.items.push(row);
      }
      if (rows.length > shown.length) html += `<div class="item nav more" data-key="more-${k}" data-more="${k}"><div class="main"><div class="t">All ${rows.length} ${name(k).toLowerCase()} ›</div></div></div>`;
    }
    if (asked && this.vodWaiting && ['all', 'movies', 'shows'].includes(this.kind)) html += '<div class="empty">Looking through movies and shows...</div>';
    box.innerHTML = html || `<div class="empty">${asked ? 'Nothing matches.' : 'Search channels, the guide, your recordings, and the movies and shows from your IPTV provider.'}</div>`;
    $$('[data-n]', box).forEach((el) => { el.onclick = () => this.items[+el.dataset.n].open(); });
    $$('[data-more]', box).forEach((el) => { el.onclick = () => { this.kind = el.dataset.more; this.paint(); Nav.focus($('#sres .nav')); }; });
    if (Nav.current && !document.body.contains(Nav.current)) Nav.restore(Nav.current.dataset.key); // results redrawn under the highlight
  },

  menu() {
    const n = Nav.current && Nav.current.dataset.n;
    const row = n != null && this.items[+n];
    const items = row ? [{ label: 'Open', run: row.open, cls: 'primary' }, ...row.more] : [];
    if (this.q) {
      items.push({ label: '✕ Clear the search', run: () => { this.q = ''; this.res = {}; this.kind = 'all'; App.render('q'); } });
      for (const [k, label] of KINDS) if (k !== this.kind) items.push({ label: `Show only: ${label}`, run: () => { this.kind = k; this.paint(); } });
    }
    return { title: 'Search', items };
  },

  onKey(e) {
    if (document.activeElement && document.activeElement.id === 'q' && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      document.activeElement.blur();
      Nav.focus($('#skinds .nav') || $('#sres .nav'));
      return true;
    }
    return false;
  },
};
