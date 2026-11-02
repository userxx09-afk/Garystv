// Settings: tuners & IPTV providers, guide sources, matching channels to the
// guide, recording options and status.
/* global App */
const SettingsView = {
  title: 'Settings',
  section: 'sources',
  chFilter: '',
  hints: [['↑↓←→', 'Move'], ['OK', 'Select'], ['Tab', 'Next field'], ['Esc', 'Back']],
  sections: [['sources', 'Antenna & Providers'], ['guide', 'Guide data'], ['channels', 'Channels & matching'], ['recording', 'Recording'], ['status', 'Status']],

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
        ${def.fields.map((f) => `<div class="field"><label>${esc(f.label)}</label><input data-field="${f.key}" placeholder="${esc(f.placeholder || '')}" value="${esc(existing ? existing.config[f.key] || '' : '')}"></div>`).join('')}
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

  // ---------- channels ----------
  channels(pane) {
    const st = App.state;
    const gById = new Map(st.guideChannels.map((g) => [g.id, g]));
    const srcName = new Map(st.sources.map((s) => [s.id, s.name]));
    const f = this.chFilter.toLowerCase();
    const list = st.channels.filter((c) => !f || `${c.number} ${c.name} ${c.group}`.toLowerCase().includes(f));
    const matched = st.channels.filter((c) => c.guideId).length;
    const conf = (c) => (c.mapMode === 'manual' ? ['man', 'Set by you'] : c.mapMode === 'none' ? ['lo', 'No guide'] : !c.guideId ? ['lo', 'No match'] : c.matchScore >= 90 ? ['hi', 'Sure'] : c.matchScore >= 50 ? ['md', 'Likely'] : ['lo', 'Check']);
    pane.innerHTML = `
      <div class="box"><h3>Match channels to the guide</h3>
        <div class="s">${matched} of ${st.channels.length} channels have guide listings. GarysTV matches by channel number, call sign and name. Check any marked <span class="conf md">Likely</span> or <span class="conf lo">Check</span>, and hide channels you never watch.</div>
        <div class="row"><div class="field" style="flex:1"><input id="chf" placeholder="Filter channels..." value="${esc(this.chFilter)}"></div><div class="btn nav" id="rematch">↻ Re-match automatically</div></div></div>
      <table class="chs"><thead><tr><th>Show</th><th>★</th><th>Ch</th><th>Name</th><th>From</th><th>Guide listing</th><th></th></tr></thead><tbody>
      ${list.slice(0, 400).map((c) => {
        const g = gById.get(c.guideId);
        const [cls, label] = conf(c);
        return `<tr data-ch="${esc(c.id)}"><td><input type="checkbox" data-k="show" ${c.hidden ? '' : 'checked'}></td>
          <td><span class="nav" data-k="fav" style="cursor:pointer;color:${c.favorite ? 'var(--yellow)' : 'var(--dim)'}">★</span></td>
          <td><b>${esc(c.number)}</b></td><td>${esc(c.name)}${c.group ? `<div class="s" style="font-size:.8rem">${esc(c.group)}</div>` : ''}</td><td class="s">${esc(srcName.get(c.sourceId) || '')}</td>
          <td>${g ? `${esc(g.names[0])} <span class="s">${esc(g.number || '')} · ${esc(g.providerName)}</span>` : '<span class="s">—</span>'}${c.matchReason && c.mapMode === 'auto' ? `<div class="s" style="font-size:.8rem">by ${esc(c.matchReason)}</div>` : ''}</td>
          <td style="white-space:nowrap"><span class="conf ${cls}">${label}</span> <span class="btn nav" data-k="change" style="padding:.25rem .7rem;font-size:.85rem">Change</span></td></tr>`;
      }).join('')}</tbody></table>
      ${list.length > 400 ? `<div class="s">Showing 400 of ${list.length}. Use the filter to find others.</div>` : ''}`;
    const fin = $('#chf', pane);
    let t;
    fin.oninput = () => { clearTimeout(t); t = setTimeout(() => { this.chFilter = fin.value; this.channels(pane); const i = $('#chf'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 300); };
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
    });
  },

  matchDialog(c) {
    const all = App.state.guideChannels;
    return Modal.open((m, close) => {
      m.innerHTML = `<div class="title">Guide listing for ${esc(c.number)} ${esc(c.name)}</div>
        <div class="field"><input id="mq" placeholder="Search guide channels (number, call sign, name)..."></div>
        <div class="list" id="ml" style="max-height:45vh"></div>
        <div class="actions"><div class="btn nav" data-v="auto">Match automatically</div><div class="btn nav" data-v="none">No guide for this channel</div><div class="btn nav" data-v="">Cancel</div></div>`;
      const paint = (q) => {
        q = q.toLowerCase();
        const hits = all.filter((g) => !q || `${g.number} ${g.names.join(' ')}`.toLowerCase().includes(q)).slice(0, 80);
        $('#ml', m).innerHTML = hits.map((g) => `<div class="item nav" data-g="${esc(g.id)}"><div class="main"><div class="t">${esc(g.number || '')} ${esc(g.names[0])}</div><div class="s">${esc(g.names.slice(1).join(' · '))} · ${esc(g.providerName)}</div></div></div>`).join('') || '<div class="empty">No guide channels match.</div>';
        $$('[data-g]', m).forEach((el) => { el.onclick = async () => { await api.put(`/api/channels/${encodeURIComponent(c.id)}`, { guideId: el.dataset.g }); close(true); }; });
      };
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

  // ---------- status ----------
  status(pane) {
    const st = App.state.status;
    pane.innerHTML = `
      <div class="box"><h3>Helpers</h3>
        <div>${st.ffmpeg ? `✅ ffmpeg found: <span class="s">${esc(st.ffmpeg)}</span>` : '⚠️ ffmpeg not found. The built-in player and HLS-type IPTV recording need it. Antenna recording works without it.'}</div>
        <div>${st.vlc ? `✅ VLC found: <span class="s">${esc(st.vlc)}</span>` : 'VLC not found (optional, used as a backup player).'}</div>
        <div>💾 ${st.diskFree != null ? `${fmt.size(st.diskFree)} free in the recordings folder` : 'Disk space unknown'}</div>
        <div>⏺ ${st.recordingNow} recording right now</div></div>
      <div class="box"><h3>Activity log</h3><pre class="log">${esc(st.log.join('\n')) || 'Nothing yet.'}</pre></div>`;
  },
};
