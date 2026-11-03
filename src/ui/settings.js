// Settings: tuners & IPTV providers, guide sources, matching channels to the
// guide, recording options and status.
/* global App, Updates, GTVAndroid, categoryOf, CATEGORY_RULES, GuideView */
const SettingsView = {
  title: 'Settings',
  section: 'sources',
  chFilter: '',
  hints: [['↑↓←→', 'Move'], ['OK', 'Select'], ['Tab', 'Next field'], ['Esc', 'Back']],
  sections: [['sources', 'Antenna & Providers'], ['guide', 'Guide data'], ['channels', 'Channels & matching'], ['startup', 'When it starts'], ['recording', 'Recording'], ['media', 'Movies & Shows'], ['updates', 'Updates'], ['status', 'Status']],

  render(root) {
    root.innerHTML = `<div class="settings">
      <div class="menu">${this.sections.map(([k, l]) => `<div class="tab nav ${this.section === k ? 'on' : ''}" data-key="sec-${k}" data-sec="${k}">${l}</div>`).join('')}</div>
      <div class="pane" id="spane"></div></div>`;
    $$('[data-sec]', root).forEach((el) => { el.onclick = () => { this.section = el.dataset.sec; App.render(`sec-${el.dataset.sec}`); }; });
    this[this.section]($('#spane', root));
  },

  // ---------- sources ----------
  sources(pane) {
    const st = App.state;
    const typeLabel = (t) => (st.types.sources.find((x) => x.type === t) || {}).label || t;
    pane.innerHTML = st.sources.map((s) => `
      <div class="box" data-src="${s.id}">
        <h3>${esc(s.name)} <span class="tag">${esc(typeLabel(s.type))}</span>${s.enabled ? '' : ' <span class="tag">OFF</span>'}</h3>
        <div class="s">${esc(s.info || '')}${s.tunerCount ? ` · records up to ${s.tunerCount} at once` : ''}${s.scannedAt ? ` · checked ${fmt.when(s.scannedAt)}` : ''}</div>
        <div class="s">${st.channels.filter((c) => c.sourceId === s.id).length} channels</div>
        <div class="actions">
          <div class="btn nav" data-act="rescan">↻ Refresh channel list</div>
          ${s.type === 'hdhomerun' ? '<div class="btn nav" data-act="antenna">📡 Scan antenna for channels</div>' : ''}
          ${s.type !== 'demo' ? '<div class="btn nav" data-act="edit">Edit</div>' : ''}
          <div class="btn nav" data-act="toggle">${s.enabled ? 'Turn off' : 'Turn on'}</div>
          <div class="btn nav danger" data-act="remove">Remove</div>
        </div>
      </div>`).join('') + `
      <div class="box"><h3>Add a tuner or provider</h3>
        <div class="s">Over-the-air: an <b>HDHomeRun</b> network tuner connected to your antenna. IPTV: the <b>M3U playlist link</b> from your provider.</div>
        <div class="actions">${st.types.sources.map((t) => `<div class="btn nav ${t.type === 'hdhomerun' ? 'primary' : ''}" data-add="${t.type}">+ ${esc(t.label)}</div>`).join('')}</div>
      </div>`;
    $$('[data-add]', pane).forEach((el) => { el.onclick = () => this.sourceDialog(el.dataset.add); });
    $$('[data-src]', pane).forEach((box) => {
      const s = st.sources.find((x) => x.id === box.dataset.src);
      $$('[data-act]', box).forEach((b) => {
        b.onclick = async () => {
          const act = b.dataset.act;
          try {
            if (act === 'rescan') { toast('Checking channels...'); const r = await api.post(`/api/sources/${s.id}/scan`); toast(r.info); }
            if (act === 'antenna') this.antennaScan(s);
            if (act === 'edit') this.sourceDialog(s.type, s);
            if (act === 'toggle') await api.put(`/api/sources/${s.id}`, { enabled: !s.enabled });
            if (act === 'remove' && await Modal.confirm(`Remove ${s.name}?`, 'Its channels leave the guide. Recordings already made are kept.', 'Remove')) await api.del(`/api/sources/${s.id}`);
          } catch (e) { toast(e.message, 6000); }
        };
      });
    });
  },

  sourceDialog(type, existing) {
    const def = App.state.types.sources.find((t) => t.type === type);
    return Modal.open((m, close) => {
      m.innerHTML = `<div class="title">${existing ? 'Edit' : 'Add'} ${esc(def.label)}</div>
        <div class="field"><label>Name</label><input id="f-name" value="${esc(existing ? existing.name : def.label)}"></div>
        ${def.fields.map((f) => `<div class="field"><label>${esc(f.label)}</label><input data-field="${f.key}"${f.secret ? ' type="password" autocomplete="off"' : ''} placeholder="${esc(f.placeholder || '')}" value="${esc(existing ? existing.config[f.key] || '' : '')}"></div>`).join('')}
        ${type === 'hdhomerun' ? '<div class="btn nav" id="findBtn">🔍 Find tuners on my network</div><div class="s" id="findOut"></div>' : ''}
        <div class="actions"><div class="btn nav primary" id="saveBtn">${existing ? 'Save' : 'Add and scan channels'}</div><div class="btn nav" id="cancelBtn">Cancel</div></div>`;
      const find = $('#findBtn', m);
      if (find) {
        find.onclick = async () => {
          $('#findOut', m).textContent = 'Looking...';
          const found = await api.get('/api/discover').catch(() => []);
          $('#findOut', m).textContent = found.length ? `Found: ${found.map((d) => d.host).join(', ')}` : 'None found. Check the tuner is powered on and on the same network, or type its IP address.';
          if (found.length) $('[data-field="host"]', m).value = found[0].host;
        };
      }
      $('#cancelBtn', m).onclick = () => close();
      $('#saveBtn', m).onclick = async () => {
        const config = Object.fromEntries($$('[data-field]', m).map((i) => [i.dataset.field, i.value.trim()]));
        const name = $('#f-name', m).value.trim();
        $('#saveBtn', m).textContent = 'Working...';
        try {
          if (existing) await api.put(`/api/sources/${existing.id}`, { name, config });
          else await api.post('/api/sources', { type, name, config });
          toast(existing ? 'Saved' : 'Added. Channels are in the guide.');
          close(true);
        } catch (e) {
          $('#saveBtn', m).textContent = existing ? 'Save' : 'Add and scan channels';
          toast(e.message, 7000);
        }
      };
    });
  },

  antennaScan(s) {
    return Modal.open((m, close) => {
      m.innerHTML = `<div class="title">Antenna channel scan</div>
        <div class="s">The tuner searches every broadcast frequency. This takes several minutes. Run it again whenever you move or adjust the antenna.</div>
        <div class="progress" style="max-width:none;height:.6rem"><i id="scanBar" style="width:0%"></i></div><div id="scanTxt" class="s">Starting...</div>
        <div class="actions"><div class="btn nav" id="closeBtn">Close</div></div>`;
      let stopped = false;
      $('#closeBtn', m).onclick = () => { stopped = true; close(); };
      (async () => {
        try {
          await api.post(`/api/sources/${s.id}/antenna-scan`);
          while (!stopped) {
            await new Promise((r) => setTimeout(r, 2000));
            const st = await api.get(`/api/sources/${s.id}/antenna-scan`);
            if (!document.body.contains(m)) return;
            $('#scanBar', m).style.width = `${st.Progress || 0}%`;
            $('#scanTxt', m).textContent = `${st.Progress || 0}% · ${st.Found || 0} channels found`;
            if (!st.ScanInProgress) {
              await api.post(`/api/sources/${s.id}/scan`);
              $('#scanTxt', m).textContent = `Done. ${st.Found || 0} channels found and added to the guide.`;
              return;
            }
          }
        } catch (e) { if (document.body.contains(m)) $('#scanTxt', m).textContent = e.message; }
      })();
    });
  },

  // ---------- guide ----------
  guide(pane) {
    const st = App.state;
    pane.innerHTML = `
      <div class="box"><h3>Guide sources</h3>
        <div class="s">Guide data fills in show names and times. HDHomeRun tuners include a free short-range guide; for a full 1-2 week guide, point to an XMLTV file or link (for example from Schedules Direct, about $35/year). IPTV playlists that include a guide link are added automatically.</div>
        <div class="actions"><div class="btn nav primary" id="refreshG">↻ Refresh guide now</div><div class="btn nav" id="addX">+ Add XMLTV guide</div></div></div>
      ${st.guides.map((g) => `<div class="box" data-g="${g.id}"><h3>${esc(g.name)} <span class="tag">${esc(g.type)}</span></h3>
        <div class="s">${esc(g.config.url || '')}</div>
        <div class="s">${esc(g.info || 'Not loaded yet')}${g.lastRefresh ? ` · updated ${fmt.when(g.lastRefresh)}` : ''}</div>
        <div class="actions">${g.type === 'xmltv' ? '<div class="btn nav" data-gact="edit">Edit</div>' : ''}<div class="btn nav danger" data-gact="remove">Remove</div></div></div>`).join('')}`;
    $('#refreshG', pane).onclick = async () => { toast('Refreshing guide...'); await api.post('/api/guides/refresh'); toast('Guide updated'); };
    $('#addX', pane).onclick = () => this.guideDialog();
    $$('[data-g]', pane).forEach((box) => {
      const g = st.guides.find((x) => x.id === box.dataset.g);
      $$('[data-gact]', box).forEach((b) => {
        b.onclick = async () => {
          if (b.dataset.gact === 'edit') this.guideDialog(g);
          if (b.dataset.gact === 'remove' && await Modal.confirm(`Remove ${g.name}?`, 'Channels matched to it will need a new match.', 'Remove')) await api.del(`/api/guides/${g.id}`);
        };
      });
    });
  },

  guideDialog(existing) {
    return Modal.open((m, close) => {
      m.innerHTML = `<div class="title">${existing ? 'Edit' : 'Add'} XMLTV guide</div>
        <div class="field"><label>Name</label><input id="g-name" value="${esc(existing ? existing.name : 'XMLTV guide')}"></div>
        <div class="field"><label>Guide URL or file path (.xml or .xml.gz)</label><input id="g-url" value="${esc(existing ? existing.config.url : '')}" placeholder="C:\\Guide\\xmltv.xml"></div>
        <div class="actions"><div class="btn nav primary" id="gs">Save and load</div><div class="btn nav" id="gc">Cancel</div></div>`;
      $('#gc', m).onclick = () => close();
      $('#gs', m).onclick = async () => {
        const body = { type: 'xmltv', name: $('#g-name', m).value.trim(), config: { url: $('#g-url', m).value.trim() } };
        if (existing) await api.put(`/api/guides/${existing.id}`, body); else await api.post('/api/guides', body);
        close(true);
        toast('Loading guide...');
        await api.post('/api/guides/refresh');
        toast('Guide updated');
      };
    });
  },

  // Hold OK, M or a long press on a channel in Channels & matching: what you can change about it.
  menu() {
    const tr = Nav.current && Nav.current.closest('tr[data-ch]');
    const c = tr && App.state.channels.find((x) => x.id === tr.dataset.ch);
    if (!c) return {};
    return {
      title: `${c.number} ${c.name}`,
      items: [
        ...App.numberItem(c),
        { label: 'Change its guide listing...', run: () => this.matchDialog(c) },
        { label: c.hidden ? 'Show it in the guide' : 'Hide it from the guide', run: () => api.put(`/api/channels/${encodeURIComponent(c.id)}`, { hidden: !c.hidden }) },
        { label: c.favorite ? '★ Stop keeping it at the top' : '☆ Keep it at the top of the guide', run: () => api.put(`/api/channels/${encodeURIComponent(c.id)}`, { favorite: !c.favorite }) },
      ],
    };
  },

  // ---------- channels ----------
  channels(pane) {
    const st = App.state;
    const gById = new Map(st.guideChannels.map((g) => [g.id, g]));
    const srcName = new Map(st.sources.map((s) => [s.id, s.name]));
    const f = this.chFilter.toLowerCase();
    const list = st.channels.filter((c) => !f || `${c.number} ${c.name} ${c.group} ${srcName.get(c.sourceId) || ''}`.toLowerCase().includes(f))
      .sort(byNumber);
    const matched = st.channels.filter((c) => c.guideId).length;
    const conf = (c) => (c.mapMode === 'manual' ? ['man', 'Set by you'] : c.mapMode === 'none' ? ['lo', 'No guide'] : !c.guideId ? ['lo', 'No match'] : c.matchScore >= 90 ? ['hi', 'Sure'] : c.matchScore >= 50 ? ['md', 'Likely'] : ['lo', 'Check']);
    pane.innerHTML = `
      <div class="box"><h3>Match channels to the guide</h3>
        <div class="s">${matched} of ${st.channels.length} channels have guide listings. GarysTV matches by channel number, call sign and name. Check any marked <span class="conf md">Likely</span> or <span class="conf lo">Check</span>, and hide channels you never watch. Click a channel number to give it your own, or use Renumber for many at once.</div>
        <div class="row"><div class="field" style="flex:1"><input id="chf" placeholder="Filter channels..." value="${esc(this.chFilter)}"></div><div class="btn nav" id="renumber">🔢 Renumber...</div><div class="btn nav" id="rematch">↻ Re-match automatically</div></div></div>
      <table class="chs"><thead><tr><th>Show</th><th>★</th><th>Ch</th><th>Name</th><th>From</th><th>Guide listing</th><th></th></tr></thead><tbody>
      ${list.slice(0, 400).map((c) => {
        const g = gById.get(c.guideId);
        const [cls, label] = conf(c);
        return `<tr data-ch="${esc(c.id)}"><td><input type="checkbox" data-k="show" ${c.hidden ? '' : 'checked'}></td>
          <td><span class="nav" data-k="fav" style="cursor:pointer;color:${c.favorite ? 'var(--yellow)' : 'var(--dim)'}">★</span></td>
          <td><span class="nav" data-k="num" style="cursor:pointer" title="Change the channel number"><b>${esc(c.number)}</b></span>${c.alias ? `<div class="s" style="font-size:.75rem">was ${esc(c.sourceNumber)}</div>` : ''}</td><td>${esc(c.name)}${c.group ? `<div class="s" style="font-size:.8rem">${esc(c.group)}</div>` : ''}</td><td class="s">${esc(srcName.get(c.sourceId) || '')}</td>
          <td>${g ? `${esc(g.names[0])} <span class="s">${esc(g.number || '')} · ${esc(g.providerName)}</span>` : '<span class="s">—</span>'}${c.matchReason && c.mapMode === 'auto' ? `<div class="s" style="font-size:.8rem">by ${esc(c.matchReason)}</div>` : ''}</td>
          <td style="white-space:nowrap"><span class="conf ${cls}">${label}</span> <span class="btn nav" data-k="change" style="padding:.25rem .7rem;font-size:.85rem">Change</span></td></tr>`;
      }).join('')}</tbody></table>
      ${list.length > 400 ? `<div class="s">Showing 400 of ${list.length}. Use the filter to find others.</div>` : ''}`;
    const fin = $('#chf', pane);
    let t;
    fin.oninput = () => { clearTimeout(t); t = setTimeout(() => { this.chFilter = fin.value; this.channels(pane); const i = $('#chf'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 300); };
    $('#renumber', pane).onclick = () => this.renumberDialog(list, this.chFilter.trim());
    $('#rematch', pane).onclick = async () => {
      for (const c of st.channels.filter((x) => x.mapMode !== 'auto')) await api.put(`/api/channels/${encodeURIComponent(c.id)}`, { mapMode: 'auto' });
      await api.post('/api/guides/refresh');
      toast('Channels re-matched');
    };
    $$('tr[data-ch]', pane).forEach((tr) => {
      const id = tr.dataset.ch;
      const c = st.channels.find((x) => x.id === id);
      const put = (b) => api.put(`/api/channels/${encodeURIComponent(id)}`, b);
      $('[data-k="show"]', tr).onchange = (e) => put({ hidden: !e.target.checked });
      $('[data-k="fav"]', tr).onclick = () => put({ favorite: !c.favorite });
      $('[data-k="change"]', tr).onclick = () => this.matchDialog(c);
      $('[data-k="num"]', tr).onclick = () => this.numberDialog(c);
    });
  },

  // Your own number for one channel; "Use the provider's" puts theirs back.
  numberDialog(c) {
    const theirs = c.sourceNumber ?? c.number;
    return Modal.open((m, close) => {
      m.innerHTML = `<div class="title">Channel number for ${esc(c.name)}</div>
        <div class="field"><label>Your number (the provider's is ${esc(theirs || 'none')})</label><input id="nnum" class="nav" inputmode="decimal" maxlength="9" value="${esc(c.alias || '')}" placeholder="${esc(theirs)}"></div>
        <div class="s" id="nwarn" style="min-height:1.2em"></div>
        <div class="actions"><div class="btn nav primary" id="nok">Save</div>${c.alias ? `<div class="btn nav" id="nback">Use the provider's (${esc(theirs)})</div>` : ''}<div class="btn nav" id="nno">Cancel</div></div>`;
      const input = $('#nnum', m);
      const warn = () => {
        const v = input.value.trim(), other = v && App.state.channels.find((x) => x.id !== c.id && !x.hidden && String(x.number) === v);
        $('#nwarn', m).textContent = other ? `${other.name} has ${v} too; they'll sit side by side.` : '';
      };
      const save = async (alias) => {
        try {
          await api.put(`/api/channels/${encodeURIComponent(c.id)}`, { alias });
          toast(alias ? `${c.name} is now channel ${alias}` : `${c.name} is back on ${theirs}`);
          close({ number: alias || theirs });
        } catch (e) { toast(e.message); }
      };
      input._onFocus = () => input.focus();
      input.oninput = warn;
      input.addEventListener('keydown', (e) => { // stopped here so the screen underneath doesn't get it too
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(input.value.trim()); }
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); input.blur(); Nav.focus($('#nok', m)); }
      });
      $('#nok', m).onclick = () => save(input.value.trim());
      if (c.alias) $('#nback', m).onclick = () => save('');
      $('#nno', m).onclick = () => close(null);
      warn();
    });
  },

  // Number many channels at once: the ones the filter shows, one provider's, or all of them,
  // in the order you pick, from a starting number. Hidden channels are left alone.
  renumberDialog(shown, filterText) {
    const st = App.state;
    const visible = (cs) => cs.filter((c) => !c.hidden);
    const sets = [];
    if (filterText) sets.push({ key: 'shown', label: `The ones matching "${filterText}"`, list: visible(shown) });
    for (const src of st.sources) {
      const cs = visible(st.channels.filter((c) => c.sourceId === src.id));
      if (cs.length) sets.push({ key: `src:${src.id}`, label: `Everything from ${src.name}`, list: cs });
    }
    sets.push({ key: 'all', label: 'Every channel', list: visible(st.channels) });
    const rows = new Map((App.guideRows || []).map((r) => [r.id, r])); // the guide's rows know what's on, for channels with no group
    const rank = (c) => { const i = CATEGORY_RULES.findIndex(([n]) => n === categoryOf(rows.get(c.id) || c)); return i < 0 ? 99 : i; };
    const theirs = (c) => parseFloat(c.sourceNumber ?? c.number) || 1e9;
    const orders = {
      now: ['As they are now', byNumber],
      name: ['A to Z by name', (a, b) => byName(a, b)],
      cat: ['By category (Sports, News, Kids...), then name', (a, b) => rank(a) - rank(b) || (a.group || '').localeCompare(b.group || '', undefined, { numeric: true }) || byName(a, b)],
      provider: ["The provider's order", (a, b) => theirs(a) - theirs(b)],
    };
    return Modal.open((m, close) => {
      m.innerHTML = `<div class="title">Renumber channels</div>
        <div class="field"><label>Which channels</label><select id="rset" class="nav">${sets.map((x) => `<option value="${esc(x.key)}">${esc(x.label)} (${x.list.length})</option>`).join('')}</select></div>
        <div class="field"><label>In this order</label><select id="rord" class="nav">${Object.entries(orders).map(([k, [label]]) => `<option value="${k}">${esc(label)}</option>`).join('')}</select></div>
        <div class="field"><label>Starting at</label><input id="rstart" class="nav" inputmode="numeric" maxlength="5" value="1"></div>
        <div class="s" id="rsum" style="min-height:2.4em"></div>
        <div class="actions"><div class="btn nav primary" id="rgo">Renumber</div><div class="btn nav" id="rback">Use the provider's numbers</div><div class="btn nav" id="rno">Cancel</div></div>`;
      const pick = () => {
        const set = sets.find((x) => x.key === $('#rset', m).value);
        return { set, list: [...set.list].sort(orders[$('#rord', m).value][1]), start: parseInt($('#rstart', m).value, 10) };
      };
      const sum = () => {
        const { list, start } = pick();
        if (!(start > 0)) { $('#rsum', m).textContent = 'Give the first channel number.'; return; }
        const ids = new Set(list.map((c) => c.id)), end = start + list.length - 1;
        const clash = visible(st.channels).filter((c) => !ids.has(c.id) && parseFloat(c.number) >= start && parseFloat(c.number) <= end).length;
        $('#rsum', m).innerHTML = `${list.length === 1 ? '1 channel becomes' : `${list.length} channels become`} ${start}${end > start ? ` to ${end}` : ''}: ${esc(list.slice(0, 3).map((c, i) => `${start + i} ${c.name}`).join(', '))}${list.length > 3 ? '...' : ''}`
          + (clash ? `<br><span style="color:var(--yellow)">${clash} other channels already use numbers in that range; they'll sit side by side.</span>` : '');
      };
      const send = async (body, done) => {
        try { const r = await api.post('/api/channels/renumber', body); toast(done(r.count), 5000); close(true); } catch (e) { toast(e.message); }
      };
      $('#rset', m).onchange = sum;
      $('#rord', m).onchange = sum;
      const start = $('#rstart', m);
      start.oninput = sum;
      start._onFocus = () => start.focus();
      start.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); start.blur(); Nav.focus($('#rgo', m)); } });
      $('#rgo', m).onclick = () => { const { list, start: n } = pick(); send({ ids: list.map((c) => c.id), start: n }, (k) => `Renumbered ${k} channel${k === 1 ? '' : 's'} from ${n}.`); };
      $('#rback', m).onclick = () => { const { set } = pick(); send({ ids: set.list.map((c) => c.id), clear: true }, (k) => `${k} channel${k === 1 ? ' is' : 's are'} back on the provider's numbers.`); };
      $('#rno', m).onclick = () => close(null);
      sum();
    });
  },

  matchDialog(c) {
    const all = App.state.guideChannels;
    return Modal.open((m, close) => {
      const theirs = c.sourceNumber ?? c.number;
      m.innerHTML = `<div class="title">${esc(c.number)} ${esc(c.name)}</div>
        <div class="row" style="align-items:flex-end;gap:.6rem"><div class="field" style="margin:0"><label>Channel number (the provider's is ${esc(theirs || 'none')})</label><input id="mnum" class="nav" inputmode="decimal" maxlength="9" style="width:9rem" value="${esc(c.number)}"></div>
          <div class="btn nav" id="mnumok">Save number</div>${c.alias ? `<div class="btn nav" id="mnumback">Use ${esc(theirs)}</div>` : ''}</div>
        <div class="s" style="margin:.8rem 0 .3rem">Guide listing</div>
        <div class="field"><input id="mq" placeholder="Search guide channels (number, call sign, name)..."></div>
        <div class="list" id="ml" style="max-height:45vh"></div>
        <div class="actions"><div class="btn nav" data-v="auto">Match automatically</div><div class="btn nav" data-v="none">No guide for this channel</div><div class="btn nav" data-v="">Cancel</div></div>`;
      const paint = (q) => {
        q = q.toLowerCase();
        const hits = all.filter((g) => !q || `${g.number} ${g.names.join(' ')}`.toLowerCase().includes(q)).slice(0, 80);
        $('#ml', m).innerHTML = hits.map((g) => `<div class="item nav" data-g="${esc(g.id)}"><div class="main"><div class="t">${esc(g.number || '')} ${esc(g.names[0])}</div><div class="s">${esc(g.names.slice(1).join(' · '))} · ${esc(g.providerName)}</div></div></div>`).join('') || '<div class="empty">No guide channels match.</div>';
        $$('[data-g]', m).forEach((el) => { el.onclick = async () => { await api.put(`/api/channels/${encodeURIComponent(c.id)}`, { guideId: el.dataset.g }); close(true); }; });
      };
      // The number here too: just this channel; the provider's is kept.
      const saveNum = async (v) => {
        const alias = v === theirs ? '' : v;
        try { await api.put(`/api/channels/${encodeURIComponent(c.id)}`, { alias }); toast(alias ? `${c.name} is now channel ${alias}` : `${c.name} is on ${theirs}`); close(true); } catch (e) { toast(e.message); }
      };
      const num = $('#mnum', m);
      num._onFocus = () => num.focus();
      num.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); saveNum(num.value.trim()); }
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); num.blur(); Nav.focus($('#ml .nav', m) || $('[data-v]', m)); }
      });
      $('#mnumok', m).onclick = () => saveNum(num.value.trim());
      if (c.alias) $('#mnumback', m).onclick = () => saveNum('');
      $('#mq', m).oninput = (e) => paint(e.target.value);
      paint(c.number || '');
      $('#mq', m).value = c.number || '';
      $$('[data-v]', m).forEach((b) => {
        b.onclick = async () => {
          const v = b.dataset.v;
          if (v === 'auto') await api.put(`/api/channels/${encodeURIComponent(c.id)}`, { mapMode: 'auto' });
          if (v === 'none') await api.put(`/api/channels/${encodeURIComponent(c.id)}`, { guideId: null, mapMode: 'none' });
          close(v || null);
        };
      });
    });
  },

  // ---------- what this TV opens to ----------
  // Kept on this TV only, so each TV (and each person's) can start its own way.
  startup(pane) {
    const s = startChoice(), lists = App.state.favLists || [];
    const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
    pane.innerHTML = `<div class="box"><h3>When GarysTV starts on this TV</h3>
      <div class="s">Saved on this TV only, so every TV can start its own way.</div>
      <div class="field"><label>Open</label><select id="stOpen" class="nav">
        ${opt('home', 'The Home screen', s.open === 'home')}${opt('guide', 'The Guide', s.open === 'guide')}${opt('live', 'The last channel watched, playing', s.open === 'live')}</select></div>
      <div class="field"><label>Channels shown in the Guide</label><select id="stList" class="nav">
        ${opt('last', 'Whatever was showing last time', s.list === 'last')}${opt('', 'All channels', s.list === '')}
        ${lists.length > 1 ? opt('*', '★ All favorites', s.list === '*') : ''}${lists.map((l) => opt(l.id, `★ ${l.name}`, s.list === l.id)).join('')}</select></div>
      <div class="s">${App.lastChannel ? `Last channel watched here: ${esc((App.state.channels.find((c) => c.id === App.lastChannel) || {}).name || 'unknown')}` : 'No channel watched on this TV yet; until then it opens the Guide.'}</div></div>`;
    const save = () => {
      try { localStorage.setItem('gtv.start', JSON.stringify({ open: $('#stOpen', pane).value, list: $('#stList', pane).value })); } catch (_) { /* private mode */ }
      toast('Saved for this TV');
    };
    $('#stOpen', pane).onchange = save;
    $('#stList', pane).onchange = save;
  },

  // ---------- recording ----------
  recording(pane) {
    const s = App.state.settings;
    const num = (k, label, hint) => `<div class="field"><label>${label}</label><input data-s="${k}" type="number" min="0" value="${esc(s[k])}">${hint ? `<span class="s" style="font-size:.85rem">${hint}</span>` : ''}</div>`;
    pane.innerHTML = `
      <div class="box"><h3>Where recordings are saved</h3>
        <div class="field"><label>Folder (an external USB drive works fine)</label><input data-s="recordingsDir" value="${esc(s.recordingsDir)}"></div></div>
      <div class="box"><h3>Timing</h3>
        <div class="row">${num('prePadMin', 'Start recordings early (minutes)')}${num('postPadMin', 'End recordings late (minutes)', 'Helps when live sports run over')}${num('guideHours', 'Guide hours to download')}</div></div>
      <div class="box"><h3>Watching</h3>
        <div class="row">${num('timeshiftMinutes', 'Live TV rewind buffer (minutes)', 'How far back you can rewind live TV. Uses about 45 MB of disk per minute while watching; shortened automatically if the disk is nearly full.')}
        <div class="field"><label>Commercials in recordings</label><select data-s="commercialSkip">${[['auto', 'Skip automatically'], ['button', 'Ask: press OK to skip'], ['off', 'Do not look for commercials']].map(([v, l]) => `<option value="${v}" ${s.commercialSkip === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span class="s" style="font-size:.85rem">Found after a recording finishes, using the short black, silent gaps around ad breaks. Works best on antenna recordings.</span></div></div></div>
      <div class="box"><h3>This PC</h3>
        <label class="check"><input type="checkbox" data-s="startWithWindows" ${s.startWithWindows ? 'checked' : ''}> Start GarysTV when Windows starts (needed so timers record after a restart)</label>
        <label class="check"><input type="checkbox" data-s="allowNetwork" ${s.allowNetwork ? 'checked' : ''}> Allow other devices on my home network (TV, tablet) to use GarysTV <span class="s">(takes effect after restart)</span></label>
        <div class="s" id="pcAddr"></div>
        <div class="field"><label>When I close the GarysTV window</label><select data-s="closeAction">${[['ask', 'Ask me'], ['tray', 'Keep running in the tray (timers record)'], ['exit', 'Exit GarysTV']].map(([v, l]) => `<option value="${v}" ${s.closeAction === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="box"><h3>Video players (optional)</h3>
        <div class="field"><label>ffmpeg.exe path (blank = find automatically)</label><input data-s="ffmpegPath" value="${esc(s.ffmpegPath)}"></div>
        <div class="field"><label>vlc.exe path (blank = find automatically)</label><input data-s="vlcPath" value="${esc(s.vlcPath)}"></div></div>
      <div class="actions"><div class="btn nav primary" id="saveS">Save settings</div></div>`;
    api.get('/api/ping').then((p) => {
      const el = $('#pcAddr', pane);
      if (el && p.addresses && p.addresses.length) el.innerHTML = `The TV app finds this PC by itself. If it can't, type this PC's address on the TV: <b>${p.addresses.map(esc).join('</b> or <b>')}</b>`;
    }).catch(() => {});
    $('#saveS', pane).onclick = async () => {
      const patch = {};
      for (const el of $$('[data-s]', pane)) patch[el.dataset.s] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value.trim();
      await api.put('/api/settings', patch);
      toast('Settings saved');
    };
  },

  // ---------- movies & shows ----------
  media(pane) {
    const from = App.state.settings.tmdbKeyFrom;
    pane.innerHTML = `
      <div class="box"><h3>Movie &amp; show info (TMDb)</h3>
        <div class="s">Movies and Shows can show a poster, rating and synopsis from The Movie Database. It needs a free TMDb key: make an account at themoviedb.org, then Settings &gt; API. Either the short "API Key" or the long "Read Access Token" works.</div>
        <div>${from === 'settings' ? '✅ A key is saved.' : from === 'secrets' ? "✅ Using the key from the server's secrets file." : '⚠️ No key yet, so Movies and Shows only show what your IPTV provider lists.'}</div>
        <div class="field"><label>${from ? 'Replace the key' : 'TMDb key'}</label><input id="tmdbKey" type="password" autocomplete="off" class="nav" placeholder="Paste the key here"></div>
        <div class="actions"><div class="btn nav primary" id="tmdbSave">Save key</div>${from === 'settings' ? '<div class="btn nav danger" id="tmdbDel">Remove key</div>' : ''}<div class="btn nav" id="tmdbClear">Clear saved info</div></div>
        <div class="s" style="font-size:.85rem">This product uses the TMDb API but is not endorsed or certified by TMDb. Free for personal, non-commercial use.</div></div>`;
    const input = $('#tmdbKey', pane);
    input._onFocus = () => input.focus();
    $('#tmdbSave', pane).onclick = async () => {
      const key = input.value.trim();
      if (!key) { input.focus(); return; }
      await api.put('/api/settings', { tmdbKey: key });
      await api.post('/api/tmdb/clear'); // answers looked up without a key (or with the old one) start over
      const test = await api.get('/api/tmdb?kind=movies&name=The%20Matrix&year=1999');
      toast(test.status === 'found' ? 'Key saved. TMDb answered.' : `Key saved, but: ${test.error || 'TMDb found nothing for a test title.'}`, 6000);
    };
    const del = $('#tmdbDel', pane);
    if (del) del.onclick = async () => { await api.put('/api/settings', { tmdbKey: '' }); toast('Key removed'); };
    $('#tmdbClear', pane).onclick = async () => { await api.post('/api/tmdb/clear'); toast('Saved movie & show info cleared. It is looked up again as you browse.'); };
  },

  // ---------- updates ----------
  async updates(pane) {
    const st = App.state.status;
    const server = `<div class="s">${window.GTV_SERVER ? 'The GarysTV this screen is connected to' : 'This GarysTV'} is version <b>${esc(st.version)}</b>${st.platform === 'linux' ? ' on the home server, which is updated by hand' : ''}.</div>`;
    if (Updates.android) return this.androidUpdates(pane, server);
    if (Updates.windowsApp) return this.windowsUpdates(pane, server);
    pane.innerHTML = `<div class="box"><h3>Updates</h3>${server}
      <div>This screen comes from that GarysTV, so it changes whenever that is updated: there's nothing to install here.</div></div>`;
  },

  androidUpdates(pane, server) {
    const paint = () => {
      if (!document.body.contains(pane) || this.section !== 'updates') { Updates.listeners.delete(paint); return; }
      const i = Updates.info, s = Updates.state;
      const now = s === 'checking' ? 'Checking...'
        : s === 'downloading' ? `Downloading the update${Updates.detail >= 0 ? ` (${Updates.detail}%)` : ''}...`
          : s === 'confirm' ? 'Downloaded. Choose Install on the screen Android shows.'
            : s === 'permission' ? 'Allow GarysTV to install apps (the screen Android opened), then choose Install again.'
              : Updates.error ? `⚠️ ${esc(Updates.error)}`
                : !i ? 'Not checked yet.' : i.newer ? `✨ Version <b>${esc(i.version)}</b> is out.` : '✅ This is the newest version.';
      pane.innerHTML = `<div class="box"><h3>Updates</h3>
        <div>This app: <b>${esc(GTVAndroid.appVersion())}</b></div>
        <div>${now}</div>
        <div class="actions">${i && i.newer && !s ? '<div class="btn nav primary" id="updInstall" data-key="upd-install">Install the update</div>' : ''}<div class="btn nav" id="updCheck" data-key="upd-check">Check now</div></div>
        <label class="check"><input type="checkbox" id="updAuto" ${Updates.autoOffer ? 'checked' : ''}> When GarysTV starts, check for updates and offer to install them</label>
        <div class="s">Updates come from GarysTV's page on GitHub. Android always asks you to confirm an install; the first time it also asks to let GarysTV install apps.</div>
        ${server}</div>`;
      const keep = Nav.key();
      const inst = $('#updInstall', pane);
      if (inst) inst.onclick = () => Updates.install();
      $('#updCheck', pane).onclick = () => Updates.check();
      $('#updAuto', pane).onchange = (e) => { Updates.autoOffer = e.target.checked; };
      if (keep && keep.startsWith('upd-')) Nav.restore(keep);
    };
    Updates.listeners.add(paint);
    paint();
    if (!Updates.info && !Updates.state) Updates.check();
  },

  async windowsUpdates(pane, server) {
    let u;
    try { u = await api.get('/api/app-update'); } catch (e) { pane.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const auto = App.state.settings.autoUpdate !== false;
    const now = !u.supported ? esc(u.reason || 'Updates work in the installed app.')
      : u.ready ? `✨ Version <b>${esc(u.available)}</b> is downloaded. ${auto ? (u.busy ? 'It installs as soon as nothing is recording or about to.' : 'It installs in a few minutes.') : 'Restart GarysTV to install it.'}`
        : u.available ? `Downloading version <b>${esc(u.available)}</b>${u.progress != null ? ` (${u.progress}%)` : ''}...`
          : u.error ? `⚠️ Couldn't check: ${esc(u.error)}`
            : u.checkedAt ? `✅ This is the newest version (checked ${fmt.when(u.checkedAt)}).` : 'Checking soon...';
    pane.innerHTML = `<div class="box"><h3>Updates</h3>
      <div>This app: <b>${esc(u.current || App.state.status.version)}</b></div>
      <div>${now}</div>
      <div class="actions">${u.ready ? '<div class="btn nav primary" id="updNow">Restart and update now</div>' : ''}${u.supported ? '<div class="btn nav" id="updCheck">Check now</div>' : ''}</div>
      <label class="check"><input type="checkbox" id="updAuto" ${auto ? 'checked' : ''}> Install updates automatically (only while nothing is recording or about to)</label>
      <div class="s">Updates come from GarysTV's page on GitHub and are checked every few hours. Timers, recordings and settings are kept.</div></div>`;
    const now2 = $('#updNow', pane);
    if (now2) now2.onclick = async () => { try { await api.post('/api/app-update/install'); toast('Updating. GarysTV starts again in a moment.'); } catch (e) { toast(e.message); } };
    const chk = $('#updCheck', pane);
    if (chk) chk.onclick = async () => { await api.post('/api/app-update/check'); toast('Checking for updates...'); setTimeout(() => { if (this.section === 'updates') App.render(); }, 3000); };
    $('#updAuto', pane).onchange = (e) => api.put('/api/settings', { autoUpdate: e.target.checked });
  },

  // ---------- status ----------
  status(pane) {
    const st = App.state.status;
    const here = window.GTV_SERVER ? `<div class="box"><h3>Connected to</h3><div id="whichPc">${esc(window.GTV_SERVER.replace(/^https?:\/\//, ''))}</div>
      <div class="s">If your channels or movies are missing, this TV may be on a different GarysTV (the PC instead of the home server).</div>
      <span class="btn nav" id="switchPc" data-key="switch">Connect to a different GarysTV</span></div>` : '';
    const tools = st.tools || {};
    const where = window.GTV_SERVER ? ' on the computer running GarysTV' : '';
    // An Install button (Windows: winget), what's happening, or how to get it on the home server.
    const tool = (name) => {
      const t = tools[name] || {};
      if (t.busy) return '<br><span class="s">Installing... (VLC asks for permission on the PC)</span>';
      const err = t.error ? `<br><span class="s" style="color:var(--yellow)">${esc(t.error)}</span>` : '';
      if (tools.canInstall) return `${err}<br><span class="btn nav" data-install="${name}" data-key="inst-${name}">Install ${name === 'vlc' ? 'VLC' : 'ffmpeg'}</span>`;
      return st.platform === 'linux' ? `<br><span class="s">On the home server: sudo apt install ${name}</span>` : err;
    };
    pane.innerHTML = `
      <div class="box"><h3>Helpers</h3>
        <div>${st.ffmpeg ? `✅ ffmpeg found: <span class="s">${esc(st.ffmpeg)}</span>` : `⚠️ ffmpeg not found${where}. The built-in player and some IPTV recordings need it. Antenna recording works without it.${tool('ffmpeg')}`}</div>
        <div>${st.vlc ? `✅ VLC found: <span class="s">${esc(st.vlc)}</span>` : st.platform === 'linux' ? 'VLC: not needed on the home server.' : `VLC not found${where} (a backup player).${tool('vlc')}`}</div>
        ${window.GTVAndroid ? `<div>${GTVAndroid.hasVlc && GTVAndroid.hasVlc() ? '✅ The VLC app is on this TV, for when the built-in player has trouble.' : 'The VLC app is not on this TV. It is a backup player: get it from the app store, or choose Play in VLC (hold OK while watching) to be taken there.'}</div>` : ''}
        <div>💾 ${st.diskFree != null ? `${fmt.size(st.diskFree)} free in the recordings folder` : 'Disk space unknown'}</div>
        <div>⏺ ${st.recordingNow} recording right now</div></div>
      ${here}<div class="box"><h3>Activity log</h3><pre class="log">${esc(st.log.join('\n')) || 'Nothing yet.'}</pre></div>`;
    if (here) {
      $('#switchPc', pane).onclick = () => window.GTV_SWITCH();
      api.get('/api/ping').then((p) => { const el = $('#whichPc'); if (el) el.innerHTML = `<b>${esc(p.name)}</b> at ${esc(window.GTV_SERVER.replace(/^https?:\/\//, ''))} · ${st.platform === 'linux' ? 'home server' : 'Windows PC'}`; }).catch(() => {});
    }
    $$('[data-install]', pane).forEach((el) => {
      el.onclick = async () => {
        try { await api.post(`/api/tools/${el.dataset.install}/install`); toast('Installing. This screen updates when it is done.', 5000); } catch (e) { toast(e.message); }
      };
    });
  },
};

// Lowest channel number first (5.1 before 12), then by name.
function byNumber(a, b) { return (parseFloat(a.number) || 1e9) - (parseFloat(b.number) || 1e9) || byName(a, b); }
// Names with numbers in order: PPV 2 before PPV 10.
function byName(a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); }

// What this TV opens to: { open: home | guide | live, list: last | "" (all) | * (all favorites) | a list's id }.
function startChoice() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('gtv.start') || '{}') || {}; } catch (_) { /* private mode */ }
  return { open: ['home', 'guide', 'live'].includes(s.open) ? s.open : 'home', list: typeof s.list === 'string' ? s.list : 'last' };
}
