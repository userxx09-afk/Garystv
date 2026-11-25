// Home menu, My Recordings (DVR), Timers, Arlo and Search screens.
/* global App, Player, GuideView, MoviesView, ShowsView, SettingsView, Teams, startChoice */
const ICONS = {
  guide: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M3 14.5h18"/></svg>',
  live: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="13" rx="2"/><path d="M8 21h8M10 9.5v5l4.5-2.5z"/></svg>',
  dvr: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="8" cy="12" r="2.2" fill="#ff3355" stroke="none"/><path d="M13 11h5M13 13.5h3"/></svg>',
  movies: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4"/></svg>',
  shows: '<svg viewBox="0 0 24 24"><rect x="2.5" y="7" width="19" height="13" rx="2"/><path d="M8 3l4 4 4-4M6 4.5h0"/><path d="M10 11v5l4-2.5z"/></svg>',
  timers: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/></svg>',
  arlo: '<svg viewBox="0 0 24 24"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="12.5" r="3.5"/></svg>',
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
            ['arlo', 'Cameras', 'Motion clips & pop-ups'], ['search', 'Search', 'Find a show'], ['settings', 'Settings', 'Antenna, guide, channels']]
            .map(([k, l, s]) => `<div class="tile nav" data-key="${k}" data-go="${k}">${ICONS[k]}<div>${l}</div><small>${esc(s)}</small></div>`).join('')}
        </div>
        <div class="strip"><h2>Favorites</h2><div class="cards">${((l) => (l.length > 1 ? [allFavorites(l), ...l] : l))(App.state.favLists || []).map((l) => `
          <div class="card nav" data-key="f-${esc(l.id)}" data-fav="${esc(l.id)}"><div class="t"><span class="fav">★</span>${esc(l.name)}</div>
          <div class="s">${l.channelIds.length} channel${l.channelIds.length === 1 ? '' : 's'}</div></div>`).join('')}
          <div class="card nav" data-key="f-new" data-favnew="1"><div class="t">＋ New favorites list</div><div class="s">For example, Gary's Favorites</div></div></div></div>
        ${Teams.strip()}
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
          // The Guide tile shows what Settings > When it starts says (all channels unless a list is picked there);
          // a favorites card is one list.
          if (k === 'guide') { const l = startChoice().list; GuideView.setList(l === 'last' ? null : l || null); }
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
    Teams.wire(root);
    $$('.cards', root).forEach(sideScroll); // drag, or ‹ ›, to see the rest of a long row
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
    // Timers live here now (Home has the Arlo tile in their place); T still jumps straight to them.
    root.innerHTML = `
      <div class="tabs"><div class="tab nav on" data-key="tab-rec">Recordings</div>
        <div class="tab nav" data-key="tab-timers" id="timersTab">Timers · ${App.state.rules.length} set</div>
        <div class="tab nav" data-key="tab-add" id="addTab">＋ Add a video or DVD</div></div>
      <div class="split">
        <div class="col">
          <h2>${this.folder ? `<span class="btn nav" data-key="up" id="upBtn">‹ All recordings</span> ${esc(entries[0] ? entries[0].rec.title : '')}` : 'All recordings'}
            <span class="r">${App.recordings.length} recordings${st.diskFree != null ? ` · ${fmt.size(st.diskFree)} free` : ''}</span></h2>
          <div class="list" id="dvrList">${entries.length ? entries.map((e) => (e.folder ? `
            <div class="item nav" data-key="f-${esc(e.folder.title)}" data-folder="${esc(e.folder.title.toLowerCase())}">
              <div class="main"><div class="t">📁 ${esc(e.folder.title)}</div><div class="s">Latest: ${fmt.when(e.folder.items[0].start)}</div></div>
              <span class="count">${e.folder.items.length}</span></div>` : recItem(e.rec))).join('') : '<div class="empty">No recordings yet.<br>In the Guide, highlight a show and press <b>R</b> (or click it and choose Record).<br>Or add your own with <b>＋ Add a video or DVD</b>, above.</div>'}
          </div>
        </div>
        <div class="col"><h2>Details</h2><div class="detail" id="dvrDetail"><div class="empty">Highlight a recording to see details.</div></div></div>
      </div>`;
    $('#timersTab', root).onclick = () => App.go('timers');
    $('#addTab', root).onclick = () => this.addVideo();
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
        <span class="status-pill st-${r.status}">${r.status === 'recording' ? '● Recording' : r.status === 'importing' ? (r.paused ? '❚❚ Paused' : `${addingWord(r)} · ${r.progress || 0}%`) : r.status}</span>${r.simulated ? '<span class="tag">PRACTICE</span>' : ''}${r.at ? `<span class="tag">AT ${esc(r.at.toUpperCase())}</span>` : ''}</div>
      ${r.error ? `<div class="s" style="color:var(--yellow)">${esc(r.error)}</div>` : ''}
      ${r.status === 'importing' && r.paused ? '<div class="s" style="color:var(--yellow)">Paused. Press OK to resume or cancel it.</div>' : r.status === 'importing' && r.waiting ? `<div class="s" style="color:var(--yellow)">${esc(r.waiting)}</div>` : ''}
      <div class="desc">${esc(r.desc || '')}</div>
      ${r.position > 30 ? `<div class="s">Stopped at ${fmt.clock(r.position)}</div>` : ''}
      ${r.saved ? '<div class="s">★ Saved: never deleted to make room or by a series\' keep limit.</div>' : ''}`;
  },

  // Save (★): never deleted by a series rule's "keep N" or when the disk fills.
  async setSaved(r, on) {
    await api.put(`/api/recordings/${r.id}`, { saved: on });
    toast(on ? 'Saved: this recording won\'t be deleted automatically' : 'Unsaved');
  },

  async recordingMenu(r) {
    if (!r) return;
    if (r.status === 'importing') {
      const dl = r.imported === 'download';
      const v = await Modal.menu(r.title, `<div class="s">${r.paused ? `Paused. Resume starts it again from the beginning${dl ? ' when a stream is free' : ''}.` : `${dl ? 'Downloading' : 'Being added'}: ${r.waiting ? esc(r.waiting) : r.progress ? `${r.progress}% done` : 'starting...'}. It can be watched when it's done.`}</div>`,
        [r.paused ? { label: '▶  Resume', value: 'resume', cls: 'primary' } : { label: '❚❚  Pause', value: 'pause' },
          { label: dl ? '✕  Cancel the download' : '✕  Stop adding it', value: 'delete', cls: 'danger' }, { label: 'Close', value: null }]);
      if (v === 'pause' || v === 'resume') this.setPaused(r, v === 'pause');
      if (v === 'delete') this.remove(r);
      return;
    }
    const choices = [];
    if (r.position > 30 && !r.watched) choices.push({ label: `▶  Resume from ${fmt.clock(r.position)}`, value: 'resume', cls: 'primary' });
    choices.push({ label: r.position > 30 ? '⟲  Start over' : '▶  Play', value: 'play', cls: r.position > 30 ? '' : 'primary' });
    if (r.status === 'recording' && !r.at) choices.push({ label: '■  Stop recording', value: 'stop' }); // one at the other place is stopped there
    choices.push({ label: r.watched ? 'Mark as not watched' : 'Mark as watched', value: 'watched' });
    if (!r.at) choices.push({ label: r.saved ? '☆  Unsave' : '★  Save (never deleted automatically)', value: 'save' });
    choices.push({ label: '🗑  Delete', value: 'delete', cls: 'danger' }, { label: 'Cancel', value: null });
    const v = await Modal.menu(r.title, `<div class="s">${esc([fmt.se(r), r.subtitle, fmt.when(r.start)].filter(Boolean).join('  ·  '))}</div>`, choices);
    if (v === 'resume') Player.play('rec', r.id, { offset: r.position });
    if (v === 'play') Player.play('rec', r.id);
    if (v === 'stop') { await api.post('/api/jobs/skip', { id: r.jobId }); toast('Recording stopped'); }
    if (v === 'watched') await api.put(`/api/recordings/${r.id}`, { watched: !r.watched, position: r.position });
    if (v === 'save') await this.setSaved(r, !r.saved);
    if (v === 'delete') this.remove(r);
  },

  // Pause / Resume a download (or a video being added): core/importer.js hold / unhold.
  async setPaused(r, on) {
    try { await api.put(`/api/recordings/${r.id}`, { paused: on }); } catch (e) { return toast(e.message); }
    toast(on ? 'Paused. Its stream is free for watching.' : 'Resumed. It starts again from the beginning.');
  },

  async remove(r) {
    if (r.status === 'importing') {
      const dl = r.imported === 'download';
      if (!(await Modal.confirm(dl ? 'Cancel the download?' : 'Stop adding it?', dl ? `${r.title}${r.subtitle ? ` - ${r.subtitle}` : ''} won't be downloaded, and what was saved so far is deleted. You can still watch it from your provider.` : `${r.title} won't be added. The original video isn't touched.`, dl ? 'Cancel download' : 'Stop adding'))) return;
      await api.del(`/api/recordings/${r.id}`);
      return toast(dl ? 'Download cancelled' : 'Stopped');
    }
    if (!(await Modal.confirm('Delete recording?', `${r.title}${r.subtitle ? ` - ${r.subtitle}` : ''} will be permanently deleted.`, 'Delete'))) return;
    await api.del(`/api/recordings/${r.id}`);
    toast('Recording deleted');
  },

  // What the menu offers for one recording.
  menuFor(r) {
    const items = [];
    if (r.status === 'importing') {
      return [r.paused ? { label: '▶ Resume', run: () => this.setPaused(r, false), cls: 'primary' } : { label: '❚❚ Pause', run: () => this.setPaused(r, true) },
        { label: r.imported === 'download' ? '✕ Cancel the download...' : '✕ Stop adding it...', run: () => this.remove(r), cls: 'danger' }];
    }
    if (r.position > 30 && !r.watched) items.push({ label: `▶ Resume from ${fmt.clock(r.position)}`, run: () => Player.play('rec', r.id, { offset: r.position }), cls: 'primary' });
    items.push({ label: r.position > 30 ? '⟲ Start over' : '▶ Play', run: () => Player.play('rec', r.id), cls: r.position > 30 ? '' : 'primary' });
    if (r.status === 'recording') items.push({ label: '■ Stop recording', run: async () => { await api.post('/api/jobs/skip', { id: r.jobId }); toast('Recording stopped'); } });
    items.push({ label: r.watched ? 'Mark as not watched' : 'Mark as watched', run: () => api.put(`/api/recordings/${r.id}`, { watched: !r.watched, position: r.position }) });
    if (!r.at) items.push({ label: r.saved ? '☆ Unsave' : '★ Save (never deleted automatically)', run: () => this.setSaved(r, !r.saved) });
    items.push({ label: '🗑 Delete...', run: () => this.remove(r), cls: 'danger' });
    return items;
  },

  menu() {
    const d = (Nav.current && Nav.current.dataset) || {};
    const r = d.rec && App.recordings.find((x) => x.id === d.rec);
    const items = r ? this.menuFor(r) : [];
    if (d.folder) items.push({ label: 'Open this folder', run: () => Nav.current.click(), cls: 'primary' });
    if (this.folder) items.push({ label: '‹ All recordings', run: () => this.onBack() });
    items.push({ label: 'Timers', run: () => App.go('timers') }, { label: '＋ Add a video or DVD', run: () => this.addVideo() });
    return { title: r ? r.title : this.title, body: r ? `<div class="s">${esc([fmt.se(r), r.subtitle, fmt.when(r.start)].filter(Boolean).join('  ·  '))}</div>` : '', items };
  },

  // ＋ Add a video or DVD (core/importer.js): a DVD in the GarysTV computer's drive, a file or folder
  // on it, or (in a browser, not the TV) a file from this device. Each is converted to a standard MP4
  // in the recordings folder and listed here; it shows "adding" until it can be watched.
  async addVideo() {
    let o;
    try { o = await api.get('/api/import'); } catch (e) { return toast(e.message); }
    if (!o.ffmpeg) return Modal.menu('Add a video or DVD', '<div class="s">This needs ffmpeg on the GarysTV computer. Install it in Settings &gt; Status.</div>', [{ label: 'Close', value: null }]);
    const where = o.platform === 'linux' ? 'the home server' : window.GTV_SERVER ? 'the GarysTV computer' : 'this computer';
    const choices = o.dvds.map((d) => ({ label: `💿  Copy the DVD: ${d.label}`, value: { dvd: d } }));
    choices.push({ label: `📂  A video file or folder on ${where}...`, value: 'path' });
    if (!window.GTV_SERVER) choices.push({ label: '⬆  Send a video from this device...', value: 'upload' });
    choices.push({ label: 'Cancel', value: null });
    const busy = o.working ? `<div class="s">One is being added now${o.waiting ? `, ${o.waiting} more waiting` : ''}; new ones wait their turn.</div>` : '';
    const v = await Modal.menu('Add a video or DVD', `<div class="s">It's converted to a standard video file (MP4) in the recordings folder and listed in My Recordings, ready to watch on any TV.${o.dvds.length ? '' : ' No DVD found in the drive.'}</div>
      <div class="s" style="color:var(--muted)">Home-made and other unprotected DVDs work; copy-protected movie discs don't.</div>${busy}`, choices);
    if (!v) return;
    try {
      if (v.dvd) {
        const title = await Modal.prompt('Name this DVD', 'Name in My Recordings', v.dvd.label.slice(0, 40), 'Copy DVD');
        if (!title) return;
        await api.post('/api/import', { path: v.dvd.path, title });
        toast(`Copying ${title}. It's listed in My Recordings while it's added.`);
      } else if (v === 'path') {
        const p = await this.askPath(o.platform, where);
        if (!p) return;
        const added = await api.post('/api/import', { path: p });
        toast(added.length === 1 ? `Adding ${added[0].title}` : `Adding ${added.length} videos`);
      } else if (v === 'upload') this.upload();
    } catch (e) { toast(e.message); }
  },

  // A path on the GarysTV computer (longer than Modal.prompt allows).
  askPath(platform, where) {
    const eg = platform === 'win32' ? 'C:\\Users\\me\\Videos\\Wedding.avi, a folder of videos, or E:\\ for a DVD' : '/home/me/videos/wedding.avi, or a folder of videos';
    return Modal.open((m, close) => {
      m.innerHTML = `<div class="title">Where is the video?</div>
        <div class="field"><label>A file or folder on ${esc(where)}, like ${esc(eg)}</label><input id="p-path" class="nav" style="width:100%"></div>
        <div class="actions"><div class="btn nav primary" id="p-ok">Add</div><div class="btn nav" id="p-cancel">Cancel</div></div>`;
      const input = $('#p-path', m);
      const done = () => { const val = input.value.trim(); if (val) close(val); else input.focus(); };
      $('#p-ok', m).onclick = done;
      $('#p-cancel', m).onclick = () => close(null);
      input._onFocus = () => input.focus();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); input.blur(); Nav.focus($('#p-ok', m)); }
      });
    });
  },

  // A file from this device, sent to GarysTV with a progress bar.
  upload() {
    const pick = document.createElement('input');
    pick.type = 'file';
    pick.accept = 'video/*,.mkv,.avi,.vob,.ts,.m2ts,.mts,.dv,.wmv,.flv';
    pick.onchange = () => {
      const file = pick.files && pick.files[0];
      if (!file) return;
      Modal.open((m, close) => {
        m.innerHTML = `<div class="title">Sending ${esc(file.name)}</div><div class="s" id="u-pct">0%</div>
          <div class="pbar" style="position:static;height:8px;margin:.6rem 0"><i id="u-bar" style="width:0%"></i></div>
          <div class="actions"><div class="btn nav" id="u-cancel">Cancel</div></div>`;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', server(`/api/import/upload?name=${encodeURIComponent(file.name)}`));
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const pct = Math.floor((e.loaded / e.total) * 100);
          $('#u-pct', m).textContent = `${pct}% of ${fmt.size(e.total)}`;
          $('#u-bar', m).style.width = `${pct}%`;
        };
        xhr.onload = () => {
          close();
          if (xhr.status === 200) return toast(`Sent. ${file.name} is being added to My Recordings.`);
          let msg = 'Sending failed';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) { /* not JSON */ }
          toast(msg);
        };
        xhr.onerror = () => { close(); toast('Sending failed: GarysTV did not answer.'); };
        $('#u-cancel', m).onclick = () => { xhr.abort(); close(); toast('Cancelled'); };
        xhr.send(file);
      });
    };
    pick.click();
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
    <div class="main"><div class="t">${r.status === 'recording' ? '<span class="dot pulse"></span>' : ''}${r.saved ? '<span class="fav">★</span>' : ''}${esc(r.subtitle || r.title)}</div>
    <div class="s">${esc([fmt.se(r), `${r.channelNumber} ${r.channelName}`].filter(Boolean).join('  ·  '))}</div></div>
    <div class="m">${fmt.when(r.start)}<br>${r.status === 'importing' ? `<span class="status-pill st-importing">${r.paused ? 'paused' : r.waiting ? 'waiting' : `${addingWord(r).toLowerCase()} ${r.progress || 0}%`}</span>` : r.status !== 'complete' ? `<span class="status-pill st-${r.status}">${r.status}</span>` : fmt.dur(r.end - r.start)}</div></div>`;
}

// ---------------- Timers ----------------
const TimersView = {
  title: 'Timers',
  tab: 'schedule',
  hints: [['↑↓', 'Move'], ['OK', 'Options'], ['←→', 'Switch list'], ['M', 'Menu'], ['Esc', 'Back']],

  describe(r) {
    const ch = r.channelId ? App.state.channels.find((c) => c.id === r.channelId) : null;
    const chName = ch ? `${ch.number} ${ch.name}` : 'Any channel';
    const pad = [r.prePad ? `${r.prePad} min early` : '', r.postPad ? `${r.postPad} min late` : ''].filter(Boolean).join(', ');
    if (r.type === 'once') return `This show only · ${fmt.when(r.start)} · ${chName}${pad ? ` · ${pad}` : ''}`;
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
      <div class="tabs"><div class="tab nav" data-key="tab-dvr" id="dvrTab">‹ My Recordings</div>
        <div class="tab nav ${this.tab === 'schedule' ? 'on' : ''}" data-key="tab-s" data-tab="schedule">Upcoming recordings</div>
        <div class="tab nav ${this.tab === 'rules' ? 'on' : ''}" data-key="tab-r" data-tab="rules">Timers &amp; priority</div>
        <div class="tab nav" data-key="manual" id="manualBtn">+ Manual timer</div></div>
      <div class="split"><div class="col"><div class="list">${listHtml}</div></div>
        <div class="col"><div class="detail" id="tDetail"><div class="empty">${this.tab === 'rules'
          ? 'Timers higher on this list win when there are not enough tuners. Open a timer to move it up or down.'
          : 'Shows marked <b>conflict</b> can\'t record because all tuners are busy. Raise that timer\'s priority, or skip another show.'}</div></div></div></div>`;
    $$('[data-tab]', root).forEach((el) => { el.onclick = () => { this.tab = el.dataset.tab; App.render(); }; });
    $('#manualBtn', root).onclick = () => App.manualDialog();
    // Came from My Recordings: step back (so Back from there still goes Home), else open it.
    $('#dvrTab', root).onclick = () => (App.history[App.history.length - 1] === 'dvr' ? App.back() : App.go('dvr'));
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
    if (r.type === 'once') choices.push({ label: 'Start early / end late...', value: 'pad', cls: 'primary' });
    choices.push({ label: '▲  Higher priority', value: 'up' }, { label: '▼  Lower priority', value: 'down' },
      { label: r.enabled === false ? 'Turn timer on' : 'Turn timer off', value: 'toggle' }, { label: '🗑  Delete timer', value: 'delete', cls: 'danger' }, { label: 'Cancel', value: null });
    const v = await Modal.menu(r.title, `<div class="s">${esc(this.describe(r))}</div>`, choices);
    if (v === 'edit') {
      const ch = r.channelId ? App.state.channels.find((c) => c.id === r.channelId) : null;
      await App.seriesDialog(ch ? { id: ch.id, number: ch.number, name: ch.name } : null, { title: r.title }, r);
    }
    if (v === 'pad') {
      const pads = await App.padDialog(r.title, r, 'Save');
      if (pads) { await api.put(`/api/rules/${r.id}`, pads); toast('Timer saved'); }
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
    if (j.status === 'scheduled' || j.status === 'recording') choices.push({ label: '⏩  End later...', value: 'later' });
    choices.push({ label: 'Go to its timer', value: 'rule' }, { label: 'Cancel', value: null });
    const v = await Modal.menu(j.title, `<div class="s">${esc(fmt.when(j.start))} · ${esc(j.channelNumber)} ${esc(j.channelName)}${j.reason ? `<br>${esc(j.reason)}` : ''}</div>`, choices);
    if (v === 'skip' || v === 'unskip') await api.post('/api/jobs/skip', { id: j.id, skip: v === 'skip' });
    if (v === 'rule') { this.tab = 'rules'; App.render(`rule-${j.ruleId}`); }
    if (v === 'later') await App.endLater(j);
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

// ---------------- Arlo ----------------
// Home > Arlo: the clips Camera Keeper has saved, newest first, from every camera or one
// (core/arlo.js). OK plays a clip big, as pictures like the motion pop-up; Back closes it.
// Hold OK (or a long press) on a clip: save it (★, never deleted by cleanup), delete it, or
// select several; while selecting, OK ticks clips and the bar above deletes or saves them.
// Watch live (the buttons above the clips, or Hold OK) shows a camera live, straight from the
// camera (not a clip): Camera Keeper wakes it, and stops it 3 minutes later or once nobody watches.
const ArloView = {
  title: 'Cameras',
  camera: null, // a camera id, or null for all of them
  account: null, // "arlo:email" / "blink:email", or null for every account
  cams: null, clips: null, error: null, loadedAt: 0, loading: false, playing: null,
  watching: null, // { id, name, n } while a camera is shown live
  selecting: false, picked: new Set(),
  get hints() {
    return this.selecting ? [['↑↓', 'Move'], ['OK', 'Tick'], ['M', 'Delete · Save'], ['Esc', 'Done']]
      : [['↑↓', 'Move'], ['OK', 'Play'], ['Hold OK', 'Delete · Save · Select'], ['←→', 'Camera'], ['Esc', 'Back']];
  },

  async load() {
    if (this.loading) return;
    this.loading = true;
    try {
      const [cams, clips] = await Promise.all([api.get('/api/arlo/cameras'), api.get(`/api/arlo/clips?limit=80${this.camera ? `&camera=${encodeURIComponent(this.camera)}` : this.account ? `&account=${encodeURIComponent(this.account)}` : ''}`)]);
      this.cams = cams; this.clips = clips; this.error = null;
    } catch (e) { this.error = e.message; }
    this.loading = false;
    this.loadedAt = Date.now();
    if (App.view === this && !this.playing) App.render();
  },

  pick(id) {
    this.camera = id || null;
    this.clips = null;
    App.render(`cam-${this.camera || 'all'}`);
    this.load();
  },

  pickAccount(id) {
    this.account = id || null;
    this.camera = null;
    this.clips = null;
    App.render(`acct-${this.account || 'all'}`);
    this.load();
  },

  // The cameras the tabs show: every one, or the chosen account's.
  shownCams() {
    const cams = (this.cams && this.cams.cameras) || [];
    return this.account ? cams.filter((c) => c.account === this.account) : cams;
  },

  render(root) {
    const s = App.state.settings.arlo || {};
    if (!s.enabled) {
      root.innerHTML = `<div class="empty">Cameras aren't turned on in GarysTV yet.<br>Turn them on and give it Camera Keeper's address in Settings › Cameras.</div>
        <div class="actions"><div class="btn nav primary" data-key="arlo-settings" id="arloSet">Open Settings › Cameras</div></div>`;
      $('#arloSet', root).onclick = () => { SettingsView.section = 'arlo'; App.go('settings'); };
      return;
    }
    if (this.watching) return this.renderLive(root);
    if (this.playing) return this.renderPlaying(root);
    if (!this.loading && (!this.clips || Date.now() - this.loadedAt > 20000)) setTimeout(() => this.load(), 0);
    const all = (this.cams && this.cams.cameras) || [];
    const accounts = (this.cams && this.cams.accounts) || [];
    if (this.account && this.cams && !accounts.some((a) => a.id === this.account)) this.account = null;
    const cams = this.shownCams();
    const liveCams = this.liveCams(this.camera ? cams.filter((c) => c.id === this.camera) : cams);
    const clips = this.clips || [];
    const camName = (id) => (all.find((c) => c.id === id) || {}).name;
    const accName = (a) => (a.brand === 'ipcam' ? a.username : `${a.brand === 'blink' ? 'Blink' : 'Arlo'} · ${a.username}`);
    const curAcc = accounts.find((a) => a.id === this.account);
    const waiting = accounts.filter((a) => a.waitingForCode);
    root.innerHTML = `
      ${accounts.length > 1 ? `<div class="tabs" style="flex-wrap:wrap"><div class="tab nav ${this.account ? '' : 'on'}" data-key="acct-all" data-acct="">All accounts</div>
        ${accounts.map((a) => `<div class="tab nav ${this.account === a.id ? 'on' : ''}" data-key="acct-${esc(a.id)}" data-acct="${esc(a.id)}">${esc(accName(a))}${a.connected ? '' : ' <span class="tag">OFF</span>'}</div>`).join('')}</div>` : ''}
      ${waiting.length ? `<div class="s" style="margin-bottom:.8rem;color:var(--yellow)">Waiting for a verification code: ${waiting.map((a) => esc(accName(a))).join(', ')}. Enter it on Camera Keeper's Arlo page.</div>` : ''}
      <div class="tabs" style="flex-wrap:wrap"><div class="tab nav ${this.camera ? '' : 'on'}" data-key="cam-all" data-cam="">${curAcc ? 'All its cameras' : 'All cameras'}</div>
        ${cams.map((c) => `<div class="tab nav ${this.camera === c.id ? 'on' : ''}" data-key="cam-${esc(c.id)}" data-cam="${esc(c.id)}">${esc(c.name)}${c.unavailable ? ' <span class="tag">OFFLINE</span>' : ''}</div>`).join('')}</div>
      ${!this.selecting && liveCams.length ? `<div class="actions" style="flex-wrap:wrap;margin-bottom:.8rem">${liveCams.map((c) => `<div class="btn nav" data-key="live-${esc(c.id)}" data-live="${esc(c.id)}">● Watch ${esc(c.name)} live</div>`).join('')}</div>` : ''}
      ${this.cams && !this.cams.connected ? '<div class="s" style="margin-bottom:.8rem;color:var(--yellow)">Camera Keeper isn\'t signed in to Arlo right now, so new clips won\'t come in. Sign in on its own page.</div>' : ''}
      ${this.selecting ? `<div class="actions selbar"><b>${this.picked.size} selected</b>
        <div class="btn nav danger" data-key="sel-delete" id="selDelete">🗑 Delete${this.picked.size ? ` ${this.picked.size}` : ''}</div>
        <div class="btn nav" data-key="sel-save" id="selSave">★ Save</div>
        <div class="btn nav" data-key="sel-all" id="selAll">${clips.length && this.picked.size === clips.length ? 'Clear all' : 'Select all'}</div>
        <div class="btn nav" data-key="sel-done" id="selDone">Done</div></div>` : ''}
      <div class="split">
        <div class="col"><h2>${esc(this.camera ? camName(this.camera) || 'Camera' : curAcc ? accName(curAcc) : 'All cameras')}<span class="r">${this.clips ? `${clips.length} clips` : ''}</span></h2>
          <div class="list" id="arloList">${this.error && !this.clips ? `<div class="empty">⚠️ ${esc(this.error)}</div>`
            : !this.clips ? '<div class="empty">Asking Camera Keeper...</div>'
            : clips.length ? clips.map((c) => `
            <div class="item nav${this.picked.has(c.key) ? ' picked' : ''}" data-key="clip-${esc(c.key)}" data-clip="${esc(c.key)}">
              ${this.selecting ? `<div class="pick">${this.picked.has(c.key) ? '☑' : '☐'}</div>` : ''}
              ${c.thumb ? `<img class="athumb" src="${esc(server(c.thumb))}" alt="" onerror="this.style.visibility='hidden'">` : '<div class="athumb"></div>'}
              <div class="main"><div class="t">${c.starred ? '<span class="fav">★</span>' : ''}${esc(c.camera)}</div><div class="s">${esc([c.trigger, c.duration ? `${Math.round(c.duration)}s` : ''].filter(Boolean).join(' · '))}</div></div>
              <div class="m">${fmt.when(c.time)}</div></div>`).join('')
            : '<div class="empty">No clips saved yet.</div>'}
          </div></div>
        <div class="col"><h2>Clip</h2><div class="detail" id="arloDetail"><div class="empty">Highlight a clip to see it. Press OK to play it.</div></div></div>
      </div>`;
    $$('[data-cam]', root).forEach((el) => { el.onclick = () => this.pick(el.dataset.cam); });
    $$('[data-acct]', root).forEach((el) => { el.onclick = () => this.pickAccount(el.dataset.acct); });
    $$('[data-live]', root).forEach((el) => { el.onclick = () => this.watch(all.find((c) => c.id === el.dataset.live)); });
    $$('[data-clip]', root).forEach((el) => {
      const c = () => clips.find((x) => x.key === el.dataset.clip);
      el.onclick = () => (this.selecting ? this.toggle(el.dataset.clip) : this.play(c()));
      el._onFocus = () => {
        const x = c();
        if (!x) return;
        $('#arloDetail').innerHTML = `${x.thumb ? `<img class="athumb big" src="${esc(server(x.thumb))}" alt="">` : ''}
          <div class="title">${esc(x.camera)}</div><div class="meta"><span>${fmt.when(x.time)}</span>${x.duration ? `<span>${Math.round(x.duration)} seconds</span>` : ''}${x.trigger ? `<span class="tag">${esc(x.trigger.toUpperCase())}</span>` : ''}</div>
          <div class="s">${x.starred ? '★ Saved: cleanup never deletes it. ' : ''}${this.selecting ? 'OK ticks it. Hold OK to delete or save the ticked clips.' : 'Press OK to play. Hold OK to save, delete or select several.'}</div>`;
      };
    });
    if (this.selecting) {
      $('#selDelete', root).onclick = () => this.removePicked();
      $('#selSave', root).onclick = () => this.starPicked(true);
      $('#selAll', root).onclick = () => {
        this.picked = clips.length && this.picked.size === clips.length ? new Set() : new Set(clips.map((x) => x.key));
        App.render('sel-all');
      };
      $('#selDone', root).onclick = () => this.endSelect();
    }
  },

  // ---- select several ----
  startSelect(key) {
    this.selecting = true;
    this.picked = new Set(key ? [key] : []);
    App.render(key ? `clip-${key}` : undefined);
  },

  endSelect(focus) {
    this.selecting = false;
    this.picked = new Set();
    App.render(focus);
  },

  toggle(key) {
    if (this.picked.has(key)) this.picked.delete(key); else this.picked.add(key);
    App.render(`clip-${key}`);
  },

  async removePicked() {
    const keys = [...this.picked];
    if (!keys.length) return toast('Tick the clips to delete first (OK on a clip).');
    const saved = (this.clips || []).filter((x) => this.picked.has(x.key) && x.starred).length;
    if (!(await Modal.confirm(`Delete ${keys.length} clip${keys.length === 1 ? '' : 's'}?`,
      `They'll be deleted from Camera Keeper, for every TV and phone.${saved ? ` ${saved} of them ${saved === 1 ? 'is' : 'are'} saved (★).` : ''}`, 'Delete'))) return;
    try { await api.post('/api/arlo/clips/bulk', { keys, action: 'delete' }); } catch (e) { return toast(e.message, 6000); }
    this.clips = (this.clips || []).filter((x) => !this.picked.has(x.key));
    toast(`Deleted ${keys.length} clip${keys.length === 1 ? '' : 's'}`);
    this.endSelect(this.clips.length ? `clip-${this.clips[0].key}` : 'cam-all');
  },

  async starPicked(on) {
    const keys = [...this.picked];
    if (!keys.length) return toast('Tick the clips to save first (OK on a clip).');
    try { await api.post('/api/arlo/clips/bulk', { keys, action: on ? 'star' : 'unstar' }); } catch (e) { return toast(e.message, 6000); }
    for (const x of this.clips || []) if (this.picked.has(x.key)) x.starred = on;
    toast(`${on ? 'Saved' : 'Unsaved'} ${keys.length} clip${keys.length === 1 ? '' : 's'}${on ? ': cleanup won\'t delete them' : ''}`);
    this.endSelect(`clip-${keys[0]}`);
  },

  // Save (★) or unsave one clip.
  async star(c, on) {
    if (!c) return;
    try { await api.post('/api/arlo/clip/star', { key: c.key, on }); } catch (e) { return toast(e.message, 6000); }
    c.starred = on;
    toast(on ? 'Saved: cleanup won\'t delete this clip' : 'Unsaved: cleanup may delete it when space runs low');
    App.render(this.playing ? 'arlo-save' : `clip-${c.key}`);
  },

  play(c) {
    if (!c) return;
    this.playing = c;
    App.render();
  },

  renderPlaying(root) {
    const c = this.playing;
    root.innerHTML = `<div class="arlo-play waiting" id="arloPlay"><img id="arloImg" alt=""><div class="cap"><b>${esc(c.camera)}</b> <span>${fmt.when(c.time)}</span></div></div>
      <div class="actions" style="justify-content:center"><div class="btn nav" data-key="arlo-close" id="arloClose">‹ Back to clips</div><div class="btn nav" data-key="arlo-again" id="arloAgain">⟲ Play again</div><div class="btn nav" data-key="arlo-save" id="arloSave">${c.starred ? '★ Saved' : '☆ Save clip'}</div><div class="btn nav danger" data-key="arlo-delete" id="arloDelete">🗑 Delete clip</div></div>`;
    const box = $('#arloPlay', root), img = $('#arloImg', root);
    img.onerror = () => { box.classList.remove('waiting'); box.classList.add('failed'); };
    img.src = server(c.view);
    // Like the pop-up: the picture has arrived once the image has a size.
    const poll = setInterval(() => { if (!document.body.contains(img)) return clearInterval(poll); if (img.naturalWidth) { box.classList.remove('waiting'); clearInterval(poll); } }, 200);
    $('#arloClose', root).onclick = () => this.onBack();
    $('#arloAgain', root).onclick = () => App.render();
    $('#arloDelete', root).onclick = () => this.remove(c);
    $('#arloSave', root).onclick = () => this.star(c, !c.starred);
  },

  // ---- live ----
  // Cameras that can be watched live: not Blink (Camera Keeper can't), and not offline.
  liveCams(cams) {
    return (cams || []).filter((c) => (c.live !== undefined ? c.live : c.brand !== 'blink' && !c.unavailable) && !String(c.id).startsWith('blink-'));
  },

  async watch(cam, again) {
    if (!cam) return;
    if (!again) toast(`Waking up ${cam.name}...`, 2500);
    try { await api.post('/api/arlo/live', { camera: cam.id }); } catch (e) { return toast(e.message, 7000); }
    this.watching = { id: cam.id, name: cam.name, thumb: cam.thumb || null, n: ((this.watching && this.watching.n) || 0) + 1 };
    this.playing = null;
    App.render(again ? 'live-again' : 'live-close');
  },

  renderLive(root) {
    const w = this.watching;
    root.innerHTML = `<div class="arlo-play waiting live${w.thumb ? ' snap' : ''}" id="arloPlay"${w.thumb ? ` style="background-image:url('${esc(server(w.thumb))}')"` : ''}><img id="arloImg" alt=""><div class="cap"><span class="live-badge">LIVE</span><b>${esc(w.name)}</b> <span id="liveLeft">Waking up the camera...</span></div></div>
      <div class="actions" style="justify-content:center"><div class="btn nav" data-key="live-close" id="liveClose">‹ Back to clips</div><div class="btn nav" data-key="live-again" id="liveAgain">⟲ Keep watching</div></div>`;
    const box = $('#arloPlay', root), img = $('#arloImg', root), left = $('#liveLeft', root);
    let seen = false;
    const began = Date.now();
    img.onerror = () => { if (!seen) { box.classList.remove('waiting'); box.classList.add('failed'); } };
    img.src = server(`/arlo/live?camera=${encodeURIComponent(w.id)}&n=${w.n}`);
    $('#liveClose', root).onclick = () => this.onBack();
    $('#liveAgain', root).onclick = () => this.watch(w, true);
    // How it's going (Camera Keeper's session): waking up, time left, ended or failed.
    let busy = false;
    const tick = async () => {
      if (!document.body.contains(img)) { // left the screen, or drawn again
        clearInterval(timer);
        img.onerror = null; img.src = ''; // ends the stream, so Camera Keeper stops the camera
        if (App.view !== this) this.watching = null;
        return;
      }
      if (img.naturalWidth && !seen) { seen = true; box.classList.remove('waiting', 'snap'); box.style.backgroundImage = ''; }
      if (busy) return;
      busy = true;
      try {
        const st = await api.get(`/api/arlo/live?camera=${encodeURIComponent(w.id)}`);
        if (!document.body.contains(left)) return;
        if (st.state === 'error') { box.classList.remove('waiting'); box.classList.add('failed'); left.textContent = st.error || "The camera didn't start."; }
        else if (st.state === 'live') left.textContent = `${Math.floor(st.secondsLeft / 60)}:${String(st.secondsLeft % 60).padStart(2, '0')} left`;
        else if (st.state === 'starting') left.textContent = 'Waking up the camera...';
        else if (seen) left.textContent = 'Live view ended. Press Keep watching to see more.';
        else if (Date.now() - began > 5000) { box.classList.remove('waiting'); box.classList.add('failed'); left.textContent = "The camera didn't start. Press Keep watching to try again."; }
      } catch (_) { /* try again next time */ } finally { busy = false; }
    };
    const timer = setInterval(tick, 1500);
  },

  // Delete a saved clip (asks first), then back to the list on the clip that took its place.
  async remove(c) {
    if (!c) return;
    if (!(await Modal.confirm('Delete clip?', `${c.camera}, ${fmt.when(c.time)} will be deleted from Camera Keeper, for every TV and phone.`, 'Delete'))) return;
    try { await api.del(`/api/arlo/clip?key=${encodeURIComponent(c.key)}`); } catch (e) { return toast(e.message, 6000); }
    const list = this.clips || [];
    const i = list.findIndex((x) => x.key === c.key);
    this.clips = list.filter((x) => x.key !== c.key);
    const next = this.clips[Math.min(Math.max(i, 0), this.clips.length - 1)];
    if (this.playing) { this.stop(); this.playing = null; }
    toast('Clip deleted');
    App.render(next ? `clip-${next.key}` : 'cam-all');
  },

  stop() {
    const img = $('#arloImg');
    if (img) { img.onerror = null; img.removeAttribute('src'); } // ends the picture stream (and ffmpeg on the engine)
  },

  onBack() {
    if (this.watching) {
      const id = this.watching.id;
      this.stop();
      this.watching = null;
      App.render(`live-${id}`);
      return true;
    }
    if (this.selecting && !this.playing) { this.endSelect(Nav.current && Nav.current.dataset.clip ? `clip-${Nav.current.dataset.clip}` : undefined); return true; }
    if (!this.playing) return false;
    const key = this.playing.key;
    this.stop();
    this.playing = null;
    App.render(`clip-${key}`);
    return true;
  },

  menu() {
    const d = (Nav.current && Nav.current.dataset) || {};
    const c = d.clip && (this.clips || []).find((x) => x.key === d.clip);
    const items = [];
    if (this.selecting && !this.playing) {
      const n = this.picked.size, all = (this.clips || []).length;
      if (c) items.push({ label: this.picked.has(c.key) ? `☐ Untick ${c.camera}, ${fmt.when(c.time)}` : `☑ Tick ${c.camera}, ${fmt.when(c.time)}`, run: () => this.toggle(c.key), cls: 'primary' });
      if (n) {
        items.push({ label: `🗑 Delete ${n} selected...`, run: () => this.removePicked(), cls: 'danger' });
        items.push({ label: `★ Save ${n} selected`, run: () => this.starPicked(true) });
        items.push({ label: `☆ Unsave ${n} selected`, run: () => this.starPicked(false) });
      }
      items.push(n === all && all ? { label: 'Clear all ticks', run: () => { this.picked = new Set(); App.render(); } }
        : { label: `Select all ${all}`, run: () => { this.picked = new Set((this.clips || []).map((x) => x.key)); App.render(); } });
      items.push({ label: 'Done selecting', run: () => this.endSelect() });
      return { title: `${n} selected`, items };
    }
    if (this.watching) {
      const w = this.watching;
      return { title: `${w.name} live`, items: [{ label: '⟲ Keep watching', run: () => this.watch(w, true), cls: 'primary' }, { label: '‹ Back to clips', run: () => this.onBack() }] };
    }
    const liveId = d.live || (c && c.cameraId) || this.camera;
    const liveCam = this.liveCams((this.cams && this.cams.cameras) || []).find((x) => x.id === liveId);
    if (liveCam) items.push({ label: `● Watch ${liveCam.name} live`, run: () => this.watch(liveCam), cls: 'primary' });
    if (c) {
      items.push({ label: `🗑 Delete this clip...`, run: () => this.remove(c), cls: 'danger' });
      items.push({ label: '☑ Select several...', run: () => this.startSelect(c.key) });
      items.push({ label: c.starred ? '☆ Unsave (cleanup may delete it)' : '★ Save clip (never deleted)', run: () => this.star(c, !c.starred) });
      items.push({ label: `▶ Play ${c.camera}, ${fmt.when(c.time)}`, run: () => this.play(c) });
    }
    if (this.playing) items.push({ label: '‹ Back to clips', run: () => this.onBack() });
    if (this.playing) {
      items.push({ label: this.playing.starred ? '☆ Unsave' : '★ Save clip (never deleted)', run: () => this.star(this.playing, !this.playing.starred) });
      items.push({ label: `🗑 Delete ${this.playing.camera}, ${fmt.when(this.playing.time)}...`, run: () => this.remove(this.playing), cls: 'danger' });
    }
    items.push({ label: '⟳ Check for new clips', run: () => this.load() });
    items.push({ label: 'Camera settings', run: () => { this.stop(); this.playing = null; this.watching = null; SettingsView.section = 'arlo'; App.go('settings'); } });
    return { title: this.title, items };
  },

  // ←→ on a clip: the next or previous camera. Del: delete the clip.
  onKey(e) {
    if (e.key === 'Delete' && this.selecting && !this.playing) { this.removePicked(); return true; }
    if (e.key === 'Delete') {
      const key = this.playing ? this.playing.key : Nav.current && Nav.current.dataset.clip;
      const c = key && (this.clips || []).find((x) => x.key === key);
      if (c || this.playing) { this.remove(c || this.playing); return true; }
      return false;
    }
    if (this.watching) return false;
    if (this.playing || !(e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return false;
    if (!Nav.current || Nav.current.classList.contains('tab') || Nav.current.closest('#topnav')) return false;
    const ids = [null, ...this.shownCams().map((c) => c.id)];
    const i = ids.indexOf(this.camera);
    this.pick(ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length]);
    return true;
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
        more: [...App.channelFavItems(c), ...App.numberItem(c, async (n) => { c.number = n; await App.loadAll(); App.render(); }), ...App.guideItem(c, async () => { await App.loadAll(); App.render(); }), ...App.recordItems(c, null), { label: '▦ Find it in the Guide', run: () => { GuideView.filter = null; GuideView.setList(null, c.id); App.go('guide'); } }],
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

// A video being added to My Recordings: a download from the provider, or a DVD / file.
function addingWord(r) { return r.imported === 'download' ? 'Downloading' : 'Adding'; }
