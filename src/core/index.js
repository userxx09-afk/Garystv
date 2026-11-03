// The DVR engine: owns sources, channels, guide, timers and the recording
// library. Everything the screens do goes through these methods (via server.js),
// so the same engine can serve this Windows app and, later, a TV app.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Store } = require('./store');
const { makeBackup, restoreBackup } = require('./backup');
const sources = require('./sources');
const { reconcile } = require('./guide/reconcile');
const { buildSchedule, episodeKey, normTitle } = require('./scheduler');
const { startRecording, recordingPath } = require('./recorder');
const { findFfmpeg, findVlc } = require('./tools');
const commercials = require('./commercials');
const { Tuners, capacity } = require('./tuners');

const GUIDES = [require('./guide/xmltv'), require('./guide/hdhomerun-guide'), require('./guide/demo-guide')];
const guideType = (t) => GUIDES.find((g) => g.type === t) || (() => { throw new Error(`Unknown guide type ${t}`); })();
const newId = () => crypto.randomBytes(5).toString('hex');

const DEFAULT_SETTINGS = {
  recordingsDir: path.join(os.homedir(), 'Videos', 'GarysTV'),
  prePadMin: 1,
  postPadMin: 2,
  guideHours: 72,
  guideRefreshHours: 12,
  port: 5480,
  allowNetwork: true, // the TV app finds this PC on the home network; outside callers are still refused (server.js)
  ffmpegPath: '',
  vlcPath: '',
  player: 'auto',
  closeAction: 'ask', // closing the window: ask | tray | exit
  timeshiftMinutes: 30, // live TV pause/rewind buffer
  commercialSkip: 'auto', // auto | button | off
};

class DvrCore extends EventEmitter {
  constructor({ dataDir, demo = false }) {
    super();
    this.store = new Store(dataDir);
    this.demo = demo;
    this.active = new Map(); // jobId -> { handle, recId }
    this.log = [];
    this.tuners = new Tuners(this); // which plan each stream is using (tuners.js)
  }

  // ---------- persistence helpers ----------
  get settings() { return { ...DEFAULT_SETTINGS, ...this.store.read('settings', {}) }; }
  get sources() { return this.store.read('sources', []); }
  get guides() { return this.store.read('guides', []); }
  get channels() { return this.store.read('channels', []); }
  get rules() { return this.store.read('rules', []); }
  get recordings() { return this.store.read('recordings', []); }
  get guideData() { return this.store.read('guidedata', { channels: [], programs: {} }); }
  get skipped() { return this.store.read('skipped', []); }
  get favLists() { return this.store.read('favlists', []); } // [{ id, name, channelIds }], e.g. "Gary's Favorites"

  changed(what) {
    this.schedule = null;
    // A new or changed timer takes effect now (Record Now starts within a moment, not at the next 5s tick).
    if (what === 'rules' && this.tickTimer) setImmediate(() => this.tick());
    this.emit('changed', what);
  }

  note(msg) {
    // ffmpeg and download errors quote the stream address, which for IPTV logins holds the username and password.
    const safe = String(msg).replace(/(\/(?:live|movie|series)\/)[^/\s]+\/[^/\s]+\//g, '$1***/***/').replace(/((?:username|password)=)[^&\s]+/gi, '$1***');
    const line = `${new Date().toLocaleString()}  ${safe}`;
    this.log.unshift(line);
    this.log.length = Math.min(this.log.length, 200);
    console.log(line);
  }

  async init() {
    if (this.demo && !this.sources.some((s) => s.type === 'demo')) {
      await this.addSource({ type: 'demo', name: 'Practice channels', config: {} });
      this.addGuide({ type: 'demo', name: 'Practice guide', config: {} });
    }
    // Free channels come on by default, once: if they're removed later they stay removed.
    if (!this.store.read('freeTvAdded', false)) {
      if (!this.sources.some((s) => s.type === 'free')) await this.addSource({ type: 'free', name: 'Free TV', config: {} }).catch((e) => this.note(`free channels: ${e.message}`));
      this.store.write('freeTvAdded', true);
    }
    // Earlier versions had home-network access off by default; switch it on once so the TV can find this PC.
    if (!this.store.read('networkDefaultOn', false)) {
      const saved = this.store.read('settings', {});
      delete saved.allowNetwork;
      this.store.write('settings', saved);
      this.store.write('networkDefaultOn', true);
    }
    this.store.write('initialized', true);
    // Anything that was "recording" when the app last closed did not finish cleanly.
    const recs = this.recordings.map((r) => (r.status === 'recording' ? { ...r, status: 'partial', error: 'App was closed during recording' } : r));
    this.store.write('recordings', recs);
    // Recordings not yet checked for commercials (older ones, or the app closed mid-check).
    for (const r of recs) if (r.commercials == null && !r.simulated && ['complete', 'partial'].includes(r.status)) this.queueCommercials(r.id);
    this.refreshGuides().catch((e) => this.note(`guide refresh failed: ${e.message}`));
    this.tickTimer = setInterval(() => this.tick(), 5000);
    this.guideTimer = setInterval(() => this.refreshGuides().catch(() => {}), this.settings.guideRefreshHours * 3600000);
    // Re-check the free channels at startup (picks up a new lineup after an app update) and
    // daily, so ones that went off the air drop out of the guide and ones that came back return.
    const recheckFree = () => this.sources.filter((s) => s.type === 'free' && s.enabled && Date.now() - (s.scannedAt || 0) > 60000).forEach((s) => this.scanSource(s.id).catch(() => {}));
    recheckFree();
    this.freeTimer = setInterval(recheckFree, 24 * 3600000);
    this.tick();
  }

  // Stops everything; resolves once recordings have finished writing (or after 5s).
  async shutdown() {
    clearInterval(this.tickTimer);
    this.tickTimer = null;
    clearInterval(this.guideTimer);
    clearTimeout(this.soonTimer);
    clearInterval(this.freeTimer);
    const writing = [...this.active.values()].map((a) => a.handle.done);
    for (const a of this.active.values()) a.handle.stop();
    if (this.timeshift) this.timeshift.stopAll();
    this.comQueue = [];
    if (this.comProc) this.comProc.kill();
    await Promise.race([Promise.all(writing), new Promise((r) => setTimeout(r, 5000))]);
  }

  updateSettings(patch) {
    this.store.write('settings', { ...this.store.read('settings', {}), ...patch });
    this.changed('settings');
  }

  // ---------- sources & channels ----------
  async addSource({ type, name, config }) {
    const def = sources.get(type);
    const src = { id: newId(), type, name: name || def.label, enabled: true, config: config || {}, tunerCount: 1, info: '' };
    this.store.write('sources', [...this.sources, src]);
    await this.scanSource(src.id);
    return src;
  }

  async updateSource(id, patch) {
    this.store.write('sources', this.sources.map((s) => (s.id === id ? { ...s, ...patch, config: { ...s.config, ...(patch.config || {}) } } : s)));
    if (patch.config) await this.scanSource(id);
    this.changed('sources');
  }

  removeSource(id) {
    this.store.write('sources', this.sources.filter((s) => s.id !== id));
    this.store.write('channels', this.channels.filter((c) => c.sourceId !== id));
    this.store.write('guides', this.guides.filter((g) => g.sourceId !== id));
    this.changed('sources');
  }

  async scanSource(id) {
    const src = this.sources.find((s) => s.id === id);
    if (!src) throw new Error('Source not found');
    let result;
    try {
      result = await sources.get(src.type).scan(src.config);
    } catch (e) {
      this.store.write('sources', this.sources.map((s) => (s.id === id ? { ...s, info: `Problem: ${e.message}` } : s)));
      this.changed('sources');
      throw e;
    }
    this.store.write('sources', this.sources.map((s) => (s.id === id ? { ...s, config: result.config, tunerCount: result.tunerCount, info: result.info, scannedAt: Date.now() } : s)));
    // Keep the user's choices (hidden, favorite, manual guide match, their own number) across rescans.
    const old = new Map(this.channels.filter((c) => c.sourceId === id).map((c) => [c.id, c]));
    const restored = this.store.read('channelchoices', {}); // from a backup, until each channel is here
    const fresh = result.channels.map((c) => {
      const cid = `${id}:${c.key}`;
      const prev = old.get(cid) || restored[cid] || {};
      return {
        id: cid, sourceId: id, number: prev.alias || c.number || '', sourceNumber: c.number || '', alias: prev.alias || '', name: c.name, callsign: c.callsign || '', tvgId: c.tvgId || '',
        logo: c.logo || prev.logo || '', group: c.group || '', city: c.city || '', hd: !!c.hd, streamUrl: c.streamUrl,
        hidden: prev.hidden || false, favorite: prev.favorite || false,
        mapMode: prev.mapMode || 'auto', guideId: prev.guideId || null, matchScore: prev.matchScore || 0, matchReason: prev.matchReason || '',
      };
    });
    this.store.write('channels', [...this.channels.filter((c) => c.sourceId !== id), ...fresh]);
    // IPTV playlists often name their own guide; and HDHomeRun has a built-in one.
    if (result.epgUrl && !this.guides.some((g) => g.config.url === result.epgUrl)) {
      this.addGuide({ type: 'xmltv', name: `${src.name} guide`, config: { url: result.epgUrl }, sourceId: id });
    }
    if (src.type === 'hdhomerun' && !this.guides.some((g) => g.type === 'hdhomerun' && g.sourceId === id)) {
      this.addGuide({ type: 'hdhomerun', name: `${src.name} guide`, config: {}, sourceId: id });
    }
    this.note(`scanned ${src.name}: ${result.info}`);
    this.reconcileChannels();
    return result;
  }

  updateChannel(id, patch) {
    const allowed = ['hidden', 'favorite', 'guideId', 'mapMode', 'name'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    if ('guideId' in clean && !('mapMode' in clean)) clean.mapMode = clean.guideId ? 'manual' : 'none';
    const alias = 'alias' in patch ? channelAlias(patch.alias) : null;
    this.store.write('channels', this.channels.map((c) => (c.id === id ? (alias == null ? { ...c, ...clean } : withAlias({ ...c, ...clean }, alias)) : c)));
    if (clean.mapMode === 'auto') this.reconcileChannels();
    this.changed('channels');
  }

  // Your own numbers for many channels at once: ids in the order wanted, numbered from start
  // (1 apart). clear: back to the numbers the provider gave them.
  renumberChannels({ ids, start, clear }) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('Pick some channels to number.');
    const first = clear ? 0 : +channelAlias(start);
    if (!clear && !(first > 0)) throw new Error('Give the first channel number.');
    const at = new Map(ids.map((id, i) => [String(id), i]));
    this.store.write('channels', this.channels.map((c) => (at.has(c.id) ? withAlias(c, clear ? '' : String(first + at.get(c.id))) : c)));
    this.changed('channels');
    return { count: at.size };
  }

  // ---------- backup & restore (backup.js) ----------
  backup(opts) { return makeBackup(this, opts); }
  restore(b) {
    const result = restoreBackup(this, b);
    for (const what of ['settings', 'sources', 'guides', 'channels', 'rules']) this.changed(what);
    // Channels and the guide come from the providers again, here; your choices are put back as they arrive.
    (async () => {
      for (const s of this.sources.filter((x) => x.enabled)) {
        try { await this.scanSource(s.id); } catch (e) { this.note(`restore: ${s.name}: ${e.message}`); }
      }
      this.changed('channels');
      await this.refreshGuides().catch((e) => this.note(`restore: guide: ${e.message}`));
    })();
    this.note(`restored a backup: ${result.sources} sources, ${result.rules} timers, ${result.favlists} favorites lists`);
    return result;
  }

  // ---------- favorites lists ----------
  // Named lists of channels (one per person, say); the Guide can show just one list.
  addFavList({ name }) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new Error('Give the list a name.');
    const list = { id: newId(), name: clean, channelIds: [] };
    this.store.write('favlists', [...this.favLists, list]);
    this.changed('favlists');
    return list;
  }

  updateFavList(id, { name, channelIds }) {
    if (!this.favLists.some((l) => l.id === id)) throw new Error('List not found');
    this.store.write('favlists', this.favLists.map((l) => (l.id !== id ? l : {
      ...l,
      ...(name != null && String(name).trim() ? { name: String(name).trim().slice(0, 40) } : {}),
      ...(Array.isArray(channelIds) ? { channelIds: [...new Set(channelIds.map(String))] } : {}),
    })));
    this.changed('favlists');
  }

  // Add or take one channel off a list; returns whether it's on the list now.
  toggleFavChannel(id, channelId, on) {
    const list = this.favLists.find((l) => l.id === id);
    if (!list) throw new Error('List not found');
    const has = list.channelIds.includes(channelId);
    const want = on == null ? !has : !!on;
    if (want !== has) this.updateFavList(id, { channelIds: want ? [...list.channelIds, channelId] : list.channelIds.filter((c) => c !== channelId) });
    return { on: want };
  }

  removeFavList(id) {
    this.store.write('favlists', this.favLists.filter((l) => l.id !== id));
    this.changed('favlists');
  }

  // ---------- guide ----------
  addGuide({ type, name, config, sourceId = null }) {
    const g = { id: newId(), type, name: name || guideType(type).label, config: config || {}, sourceId, lastRefresh: null, info: '' };
    this.store.write('guides', [...this.guides, g]);
    this.changed('guides');
    this.refreshSoon(); // its listings now, not at the next start
    return g;
  }

  // Download the listings again shortly (a guide was added or changed). Waits for a refresh
  // already under way, which wouldn't include it; several changes together make one refresh.
  refreshSoon() {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => {
      Promise.resolve(this.refreshing).catch(() => {}).then(() => this.refreshGuides())
        .catch((e) => this.note(`guide refresh failed: ${e.message}`));
    }, 500);
  }

  updateGuide(id, patch) {
    this.store.write('guides', this.guides.map((g) => (g.id === id ? { ...g, ...patch, config: { ...g.config, ...(patch.config || {}) } } : g)));
    this.changed('guides');
  }

  removeGuide(id) {
    this.store.write('guides', this.guides.filter((g) => g.id !== id));
    const data = this.guideData;
    this.store.write('guidedata', {
      channels: data.channels.filter((c) => c.providerId !== id),
      programs: Object.fromEntries(Object.entries(data.programs).filter(([k]) => !k.startsWith(`${id}|`))),
    });
    this.reconcileChannels();
  }

  async refreshGuides() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const allChannels = [];
      const allPrograms = {};
      const keepBefore = Date.now() - 6 * 3600000;
      const previous = this.guideData;
      for (const g of this.guides) {
        const source = g.sourceId ? this.sources.find((s) => s.id === g.sourceId) : null;
        try {
          const data = await guideType(g.type).fetch(g.config, { source, hours: this.settings.guideHours });
          for (const c of data.channels) allChannels.push({ ...c, id: `${g.id}|${c.id}`, rawId: c.id, providerId: g.id, providerName: g.name });
          for (const [cid, list] of Object.entries(data.programs)) allPrograms[`${g.id}|${cid}`] = list.filter((p) => p.end > keepBefore);
          this.updateGuide(g.id, { lastRefresh: Date.now(), info: `${data.channels.length} channels` });
        } catch (e) {
          // Keep the last good listings for this provider rather than blanking the guide.
          for (const c of previous.channels.filter((c) => c.providerId === g.id)) allChannels.push(c);
          for (const [k, v] of Object.entries(previous.programs)) if (k.startsWith(`${g.id}|`)) allPrograms[k] = v;
          this.updateGuide(g.id, { info: `Problem: ${e.message}` });
          this.note(`guide ${g.name} failed: ${e.message}`);
        }
      }
      this.store.write('guidedata', { channels: allChannels, programs: allPrograms });
      this.reconcileChannels();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  reconcileChannels() {
    const auto = this.channels.filter((c) => c.mapMode === 'auto');
    const matches = reconcile(auto, this.guideData.channels);
    this.store.write('channels', this.channels.map((c) => {
      const m = matches.get(c.id);
      return m ? { ...c, guideId: m.guideId, matchScore: m.score, matchReason: m.reason } : c;
    }));
    this.changed('channels');
  }

  programsFor(channel) {
    return (channel.guideId && this.guideData.programs[channel.guideId]) || [];
  }

  visibleChannels() {
    const enabled = new Set(this.sources.filter((s) => s.enabled).map((s) => s.id));
    const num = (c) => (c.number ? parseFloat(c.number) : 1e9);
    return this.channels
      .filter((c) => !c.hidden && enabled.has(c.sourceId))
      .sort((a, b) => (b.favorite - a.favorite) || num(a) - num(b) || a.name.localeCompare(b.name));
  }

  getGuide(from, to) {
    const jobs = new Map(this.getSchedule().map((j) => [j.id, j]));
    const seriesTitles = new Set(this.rules.filter((r) => r.type === 'series').map((r) => normTitle(r.title)));
    return this.visibleChannels().map((c) => {
      const logo = c.logo || (this.guideData.channels.find((g) => g.id === c.guideId) || {}).logo || '';
      let programs = this.programsFor(c).filter((p) => p.end > from && p.start < to);
      if (!programs.length) {
        programs = [c.guideId ? { start: from, end: to, title: 'No information', filler: true }
          : { start: from, end: to, title: c.city ? `${c.name} - ${c.city}` : c.name, subtitle: c.group ? `${c.group} · Live` : 'No guide data', desc: c.group ? 'Live channel. No schedule listing is available for it.' : '', filler: true }];
      }
      return {
        id: c.id, number: c.number, name: c.name, logo, favorite: c.favorite, sourceId: c.sourceId, group: c.group || '',
        programs: programs.map((p) => {
          const job = jobs.get(`${c.id}@${p.start}`);
          return { ...p, timer: job ? (job.ruleType === 'series' ? 'series' : 'once') : null, timerStatus: job ? job.status : null, seriesTimer: seriesTitles.has(normTitle(p.title)) };
        }),
      };
    });
  }

  // Search everything at once: upcoming shows, channels and recordings (movies and shows are core/vod.js).
  search(q) {
    const want = String(q || '').toLowerCase().trim();
    if (want.length < 2) return { programs: [], channels: [], recordings: [] };
    const has = (...t) => t.some((x) => String(x || '').toLowerCase().includes(want));
    const now = Date.now();
    const programs = [];
    const channels = [];
    for (const c of this.visibleChannels()) {
      if (has(c.name, c.group, c.city) || String(c.number) === want) channels.push({ id: c.id, number: c.number, name: c.name, group: c.group || '', logo: c.logo || '' });
      for (const p of this.programsFor(c)) {
        if (p.end > now && has(p.title, p.subtitle)) programs.push({ channelId: c.id, number: c.number, channelName: c.name, ...p });
      }
    }
    const recordings = this.getRecordings().filter((r) => has(r.title, r.subtitle)).slice(0, 100);
    return { programs: programs.sort((x, y) => x.start - y.start).slice(0, 200), channels: channels.slice(0, 60), recordings };
  }

  // ---------- timers ----------
  addRule(rule) {
    const r = { id: newId(), enabled: true, created: Date.now(), ...rule };
    if (r.type === 'series' && this.rules.some((x) => x.type === 'series' && normTitle(x.title) === normTitle(r.title) && (x.channelId || null) === (r.channelId || null))) {
      throw new Error(`There is already a series timer for "${r.title}".`);
    }
    // Single-show timers go to the top; they're usually the one you care about most right now.
    this.store.write('rules', r.type === 'once' ? [r, ...this.rules] : [...this.rules, r]);
    this.note(`timer added: ${r.title}`);
    this.changed('rules');
    return r;
  }

  updateRule(id, patch) {
    this.store.write('rules', this.rules.map((r) => (r.id === id ? { ...r, ...patch, id } : r)));
    this.changed('rules');
  }

  removeRule(id) {
    this.store.write('rules', this.rules.filter((r) => r.id !== id));
    for (const [jobId, a] of this.active) if (a.ruleId === id) this.stopJob(jobId);
    this.changed('rules');
  }

  moveRule(id, delta) {
    const list = [...this.rules];
    const i = list.findIndex((r) => r.id === id);
    const j = Math.max(0, Math.min(list.length - 1, i + delta));
    if (i < 0 || i === j) return;
    const [r] = list.splice(i, 1);
    list.splice(j, 0, r);
    this.store.write('rules', list);
    this.changed('rules');
  }

  skipJob(jobId, skip = true) {
    const set = new Set(this.skipped);
    skip ? set.add(jobId) : set.delete(jobId);
    this.store.write('skipped', [...set]);
    if (skip && this.active.has(jobId)) this.stopJob(jobId);
    this.changed('rules');
  }

  getSchedule() {
    if (this.schedule && Date.now() - this.scheduleAt < 30000) return this.schedule;
    const tuners = new Map(this.sources.map((s) => [s.id, capacity(s)]));
    this.schedule = buildSchedule({
      rules: this.rules,
      channels: this.visibleChannels(),
      programsFor: (c) => this.programsFor(c),
      tunerCount: (sid) => tuners.get(sid) || 1,
      choices: (job) => { try { return this.tuners.choices(job.channelId); } catch (_) { return null; } },
      recordedKeys: new Set(this.recordings.filter((r) => r.status !== 'failed' && r.episodeKey).map((r) => r.episodeKey)),
      skipped: new Set(this.skipped),
      active: new Set(this.active.keys()),
      settings: this.settings,
      now: Date.now(),
    });
    for (const j of this.schedule) if (this.active.has(j.id)) j.status = 'recording';
    this.scheduleAt = Date.now();
    return this.schedule;
  }

  // ---------- recording ----------
  tick() {
    const now = Date.now();
    const jobs = this.getSchedule();
    for (const job of jobs) {
      if (job.status === 'scheduled' && !this.active.has(job.id) && job.recStart <= now && now < job.recEnd) this.startJob(job);
    }
    // Stop recordings whose timer was removed or that lost their tuner to a higher-priority timer.
    const wanted = new Set(jobs.filter((j) => j.status === 'scheduled' || j.status === 'recording').map((j) => j.id));
    for (const jobId of this.active.keys()) if (!wanted.has(jobId)) this.stopJob(jobId);
    // One-time timers are done once their show is over.
    const activeRules = new Set([...this.active.values()].map((a) => a.ruleId));
    const expired = this.rules.filter((r) => r.type === 'once' && r.end + 30 * 60000 < now && !activeRules.has(r.id));
    if (expired.length) this.store.write('rules', this.rules.filter((r) => !expired.includes(r)));
  }

  startJob(job) {
    const src = this.sources.find((s) => s.id === job.sourceId);
    if (!this.channels.some((c) => c.id === job.channelId) || !src) return;
    // A plan for the stream: the one the schedule picked if it can, else any with this channel free.
    let lease;
    try {
      lease = this.tuners.acquire(job.viaChannelId || job.channelId, 'rec', job.title);
    } catch (e) {
      if (!(this.busyNoted ||= new Set()).has(job.id)) { this.busyNoted.add(job.id); this.note(`${job.title}: waiting for a free plan: ${e.message}`); }
      return; // tried again at the next tick
    }
    const channel = lease.channel;
    const file = recordingPath(this.settings.recordingsDir, job);
    const rec = {
      id: newId(), jobId: job.id, ruleId: job.ruleId, channelId: job.channelId, channelNumber: job.channelNumber, channelName: job.channelName,
      title: job.title, subtitle: job.subtitle, desc: job.desc, season: job.season, episode: job.episode, categories: job.categories,
      episodeKey: job.episodeKey, start: job.start, end: job.end, recordedAt: Date.now(), file, size: 0, status: 'recording', error: null,
      position: 0, watched: false, simulated: (this.sources.find((x) => x.id === channel.sourceId) || src).type === 'demo',
    };
    this.store.write('recordings', [rec, ...this.recordings]);
    const handle = startRecording({
      url: channel.streamUrl, file, until: job.recEnd, simulated: rec.simulated, ffmpeg: findFfmpeg(this.settings),
      log: (m) => this.note(`${job.title}: ${m}`),
    });
    this.active.set(job.id, { handle, recId: rec.id, ruleId: job.ruleId });
    this.note(`recording started: ${job.title} on ${channel.number} ${channel.name}${channel.id !== job.channelId ? ` (${(this.sources.find((x) => x.id === channel.sourceId) || {}).name}, the usual plan was busy)` : ''}`);
    this.changed('recordings');
    handle.done.then((result) => {
      this.active.delete(job.id);
      this.tuners.release(lease.id);
      let size = 0;
      try { size = fs.statSync(file).size; } catch (_) {}
      this.patchRecording(rec.id, { status: result.status, error: result.error, size, finishedAt: Date.now() });
      this.note(`recording ${result.status}: ${job.title}${result.error ? ` (${result.error})` : ''}`);
      this.applyKeepLimit(job.ruleId);
      this.changed('recordings');
      if (size && !rec.simulated) this.queueCommercials(rec.id);
    });
  }

  // ---------- commercials ----------
  // Recordings are checked one at a time, at low priority, after they finish.
  queueCommercials(recId) {
    if (this.settings.commercialSkip === 'off') return;
    (this.comQueue ||= []).push(recId);
    if (!this.comBusy) this.nextCommercials();
  }

  async nextCommercials() {
    const id = (this.comQueue || []).shift();
    this.comBusy = !!id;
    if (!id) return;
    const rec = this.recordings.find((r) => r.id === id);
    const ffmpeg = findFfmpeg(this.settings);
    if (rec && ffmpeg && fs.existsSync(rec.file)) {
      try {
        const breaks = await commercials.analyze(rec.file, ffmpeg, (proc) => { this.comProc = proc; });
        if (this.recordings.some((r) => r.id === id)) this.patchRecording(id, { commercials: breaks });
        this.note(`commercials: ${breaks.length} break(s) found in ${rec.title}`);
      } catch (e) {
        this.note(`commercials: couldn't check ${rec.title}: ${e.message}`);
        if (this.recordings.some((r) => r.id === id)) this.patchRecording(id, { commercials: [] });
      }
    }
    this.nextCommercials();
  }

  stopJob(jobId) {
    const a = this.active.get(jobId);
    if (a) a.handle.stop();
  }

  // A rule with keep: N deletes the oldest recordings of that series beyond N.
  applyKeepLimit(ruleId) {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule || !rule.keep) return;
    const mine = this.recordings.filter((r) => r.ruleId === ruleId && r.status !== 'recording').sort((a, b) => b.start - a.start);
    for (const old of mine.slice(rule.keep)) this.deleteRecording(old.id);
  }

  patchRecording(id, patch) {
    this.store.write('recordings', this.recordings.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    this.changed('recordings');
  }

  async deleteRecording(id) {
    const rec = this.recordings.find((r) => r.id === id);
    if (!rec) return;
    // Deleting a show that is still recording stops it (and keeps it from restarting).
    for (const [jobId, a] of this.active) {
      if (a.recId === id) { this.skipJob(jobId); await a.handle.done; }
    }
    try { fs.unlinkSync(rec.file); } catch (_) {}
    try { fs.rmdirSync(path.dirname(rec.file)); } catch (_) { /* folder not empty */ }
    this.store.write('recordings', this.recordings.filter((r) => r.id !== id));
    this.changed('recordings');
  }

  getRecordings() {
    const live = new Map([...this.active.values()].map((a) => [a.recId, a.handle.bytes]));
    return this.recordings.map((r) => (live.has(r.id) ? { ...r, size: live.get(r.id) } : r));
  }

  status() {
    const ff = findFfmpeg(this.settings);
    const vlc = findVlc(this.settings);
    return {
      recordingNow: [...this.active.keys()].length,
      plans: this.tuners.overview(),
      ffmpeg: ff, vlc,
      diskFree: (() => { try { const s = fs.statfsSync(fs.existsSync(this.settings.recordingsDir) ? this.settings.recordingsDir : os.homedir()); return s.bavail * s.bsize; } catch (_) { return null; } })(),
      log: this.log.slice(0, 50),
    };
  }

  describeTypes() {
    return { sources: sources.describe(), guides: GUIDES.map(({ type, label, fields, needsSource }) => ({ type, label, fields, needsSource })) };
  }
}

// A channel number you give a channel ("" puts the provider's back): digits, maybe one dot (5.1).
function channelAlias(v) {
  const n = String(v ?? '').trim();
  if (n && !/^\d{1,5}(\.\d{1,3})?$/.test(n)) throw new Error('A channel number is digits, like 205 or 5.1.');
  return n.replace(/^0+(?=\d)/, '');
}
// Channels saved before numbers could be changed have only "number": that's the provider's.
function withAlias(c, alias) {
  const sourceNumber = c.sourceNumber ?? c.number;
  return { ...c, sourceNumber, alias, number: alias || sourceNumber };
}

module.exports = { DvrCore, episodeKey };
