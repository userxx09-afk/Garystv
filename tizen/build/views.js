// Home menu, My Recordings (DVR), Timers and Search screens.
/* global App, Player, GuideView */
const ICONS = {
  guide: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M3 14.5h18"/></svg>',
  live: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="13" rx="2"/><path d="M8 21h8M10 9.5v5l4.5-2.5z"/></svg>',
  dvr: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="8" cy="12" r="2.2" fill="#ff3355" stroke="none"/><path d="M13 11h5M13 13.5h3"/></svg>',
  timers: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
};

// ---------------- Home ----------------
const HomeView = {
  title: '',
  hints: [['←→↑↓', 'Move'], ['OK', 'Select'], ['G', 'Guide'], ['D', 'My Recordings'], ['T', 'Timers'], ['S', 'Search']],
  render(root) {
    const h = new Date().getHours();
    const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const sched = App.schedule.filter((j) => j.status === 'recording' || j.status === 'scheduled').slice(0, 5);
    const recent = App.recordings.filter((r) => r.status !== 'failed').slice(0, 6);
    root.innerHTML = `
      <div class="home">
        <div class="home-head"><img class="logo" src="logo.jpg" alt=""><h1>${greet}. <b>What would you like to watch?</b></h1></div>
        <div class="tiles">
          ${[['guide', 'Guide', 'See what\'s on'], ['live', 'Live TV', 'Last channel'], ['dvr', 'My Recordings', `${App.recordings.length} shows`],
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
};

// ---------------- My Recordings ----------------
const DvrView = {
  title: 'My Recordings',
  folder: null,
  hints: [['↑↓', 'Move'], ['OK', 'Play / open'], ['Del', 'Delete'], ['Esc', 'Back']],

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
    if (up) up.onclick = () => { this.folder = null; App.render(); };
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

  onKey(e) {
    if (e.key === 'Delete') {
      const id = Nav.current && Nav.current.dataset.rec;
      if (id) this.remove(App.recordings.find((r) => r.id === id));
      return true;
    }
    if ((e.key === 'Escape' || e.key === 'Backspace') && this.folder) { this.folder = null; App.render(); return true; }
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
  hints: [['↑↓', 'Move'], ['OK', 'Options'], ['←→', 'Switch list'], ['Esc', 'Back']],

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

  onKey(e) {
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && Nav.current && !Nav.current.classList.contains('tab')) {
      this.tab = this.tab === 'rules' ? 'schedule' : 'rules';
      App.render();
      return true;
    }
    return false;
  },
};

// ---------------- Search ----------------
const SearchView = {
  title: 'Search',
  q: '',
  results: [],
  hints: [['Type', 'Show name'], ['↓', 'Results'], ['OK', 'Options'], ['Esc', 'Back']],
  render(root) {
    root.innerHTML = `
      <div class="searchbox">${ICONS.search.replace('<svg', '<svg width="32" height="32" stroke="currentColor" fill="none" stroke-width="2"')}<input id="q" class="nav" data-key="q" placeholder="Type a show name..." value="${esc(this.q)}"></div>
      <div class="col" style="flex:1;min-height:0"><div class="list" id="sres"></div></div>`;
    const input = $('#q', root);
    let timer;
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(() => this.search(input.value), 250); };
    setTimeout(() => { input.focus(); Nav.focus(input); }, 0);
    this.paint();
  },
  async search(q) {
    this.q = q;
    this.results = q.trim().length >= 2 ? await api.get(`/api/search?q=${encodeURIComponent(q)}`) : [];
    this.paint();
  },
  paint() {
    const box = $('#sres');
    if (!box) return;
    box.innerHTML = this.results.length ? this.results.map((p, i) => `
      <div class="item nav" data-key="s-${i}" data-i="${i}"><div class="main"><div class="t">${p.isNew ? '<span class="tag new">NEW</span>' : ''}${esc(p.title)}</div>
        <div class="s">${esc([fmt.se(p), p.subtitle, `${p.number} ${p.channelName}`].filter(Boolean).join('  ·  '))}</div></div><div class="m">${fmt.when(p.start)}</div></div>`).join('')
      : `<div class="empty">${this.q.trim().length >= 2 ? 'No upcoming shows match.' : 'Search the guide for upcoming shows.'}</div>`;
    $$('[data-i]', box).forEach((el) => {
      el.onclick = () => {
        const p = this.results[+el.dataset.i];
        App.programDialog({ id: p.channelId, number: p.number, name: p.channelName }, p).then(() => this.search(this.q));
      };
    });
  },
  onKey(e) {
    if (document.activeElement && document.activeElement.id === 'q') {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { document.activeElement.blur(); Nav.focus($('#sres .nav')); return true; }
      return false;
    }
    if (e.key === 'ArrowUp' && Nav.current === $('#sres .nav')) { $('#q').focus(); Nav.focus($('#q')); return true; }
    return false;
  },
};
