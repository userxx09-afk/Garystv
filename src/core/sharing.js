// Home and work: two GarysTVs linked with sharing on (peers.js), using the same IPTV plans.
//   - Plans: every 30 seconds (and as soon as something starts or stops) each tells the other
//     which plans it's using and what it's about to record, so they never both use a
//     one-stream plan (tuners.js counts the other's streams; the scheduler its timers).
//     A recording that needs a plan someone is watching at the other place asks it to let go.
//   - Lists and channel choices (favorites lists; your numbers, hidden, pinned, guide listing):
//     whichever place changed them last, the other copies.
//   - Recordings: each lists the other's too, played through this GarysTV.
// Timers stay with the place that set them (each records its own).
const crypto = require('crypto');
const { planKey } = require('./tuners');

const BEAT_MS = 30000;
const RECS_MS = 30000; // how long the other place's recordings list is kept before asking again
const CHOICES = ['alias', 'hidden', 'favorite', 'mapMode', 'guideId'];

// A channel or guide listing as both places know it: by plan (provider + login), not by this
// GarysTV's own ids for them.
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

class Sharing {
  constructor(core, peers) {
    this.core = core;
    this.peers = peers;
    this.recs = new Map(); // peer id -> { at, list }
    this.applying = false;
    core.on('tuners', () => this.soon());
    core.on('changed', (what) => {
      if (what === 'favlists' && !this.applying) { this.stamp('favlistsAt'); this.soon(); }
      if (what === 'rules') this.soon(); // what's about to record changed
    });
    core.on('choices', () => { if (!this.applying) { this.stamp('choicesAt'); this.soon(); } });
    this.timer = setInterval(() => this.beat(), BEAT_MS);
    this.timer.unref();
    setTimeout(() => this.beat(), 5000).unref();
  }

  get partners() { return this.peers.list.filter((p) => p.share); }
  get stamps() { return this.core.store.read('syncstamps', { favlistsAt: 0, choicesAt: 0 }); }
  stamp(k, at = Date.now()) { this.core.store.write('syncstamps', { ...this.stamps, [k]: at }); }

  // Just linked with sharing: this place's lists and choices go over to the other.
  linked() { this.stamp('favlistsAt'); this.stamp('choicesAt'); this.soon(); }

  soon() {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.beat(), 500);
    this.soonTimer.unref();
  }

  stop() { clearInterval(this.timer); clearTimeout(this.soonTimer); }

  // ---------- plans ----------
  // Timers here for the next week, by plan, for the other place's scheduler.
  reservations() {
    const src = new Map(this.core.sources.map((s) => [s.id, s]));
    return this.core.getSchedule().filter((j) => j.status === 'scheduled' || j.status === 'recording').map((j) => {
      const s = src.get(j.viaSourceId || j.sourceId);
      return s ? { plan: planKey(s), recStart: j.recStart, recEnd: j.recEnd, active: j.status === 'recording', title: j.title } : null;
    }).filter(Boolean);
  }

  // The other place's timers that this one makes way for: ones recording now, and (so that two
  // places don't both give way, or both not) all of them from the place with the lower id.
  reserved(sourceId) {
    const s = this.core.sources.find((x) => x.id === sourceId);
    if (!s) return [];
    const key = planKey(s);
    const me = this.peers.me.id;
    const out = [];
    for (const [id, r] of this.core.tuners.remote) {
      for (const j of r.jobs || []) if (j.plan === key && (j.active || id < me)) out.push({ recStart: j.recStart, recEnd: j.recEnd, remote: true });
    }
    return out;
  }

  async beat() {
    const body = { name: this.peers.me.name, uses: this.core.tuners.report(), jobs: this.reservations(), stamps: this.stamps };
    await Promise.all(this.partners.map(async (p) => {
      try {
        const them = await this.peers.call(p, 'POST', '/api/peer/beat', body);
        this.heard(p, them);
      } catch (_) { /* it's off or out of reach: its streams are forgotten after a minute and a half */ }
    }));
  }

  // From a beat (theirs, or the answer to ours): their streams, timers and what's newer there.
  heard(p, b) {
    const before = JSON.stringify((this.core.tuners.remote.get(p.id) || {}).jobs || []);
    this.core.tuners.remote.set(p.id, { at: Date.now(), name: b.name || p.name, uses: b.uses || [], jobs: b.jobs || [] });
    if (JSON.stringify(b.jobs || []) !== before) this.core.schedule = null; // re-plan with their timers
    const mine = this.stamps, theirs = b.stamps || {};
    if ((theirs.favlistsAt || 0) > (mine.favlistsAt || 0) || (theirs.choicesAt || 0) > (mine.choicesAt || 0)) {
      this.pull(p).catch((e) => this.core.note(`sharing with ${p.name}: ${e.message}`));
    }
  }

  // A beat from the other place. -> ours, in answer.
  receive(p, b) {
    if (b.name && b.name !== p.name) this.peers.save(this.peers.list.map((x) => (x.id === p.id ? { ...x, name: String(b.name).slice(0, 40) } : x)));
    this.heard(p, b);
    return { name: this.peers.me.name, uses: this.core.tuners.report(), jobs: this.reservations(), stamps: this.stamps };
  }

  // A recording here needs a plan someone is watching at the other place: ask them to stop.
  askToYield(ask, what) {
    for (const { peerId, plan } of ask) {
      const p = this.partners.find((x) => x.id === peerId);
      if (p) this.peers.call(p, 'POST', '/api/peer/yield', { plan, what }).catch(() => {});
    }
  }

  // The other place asks: stop watching on that plan here (a recording there needs it).
  yieldPlan(p, { plan, what }) {
    for (const u of [...this.core.tuners.uses.values()]) {
      const s = this.core.sources.find((x) => x.id === u.sourceId);
      if (u.kind !== 'rec' && s && planKey(s) === plan) this.core.tuners.bump(u, `Stopped so "${what}" could record at ${p.name}`);
    }
  }

  // ---------- lists and channel choices ----------
  maps() {
    const keyOf = new Map(this.core.sources.map((s) => [s.id, planKey(s)]));
    const srcOf = new Map(this.core.sources.map((s) => [planKey(s), s.id]));
    const guideKey = (g) => sha(`${g.type}|${(g.config && g.config.url) || ''}|${g.sourceId ? keyOf.get(g.sourceId) || '' : ''}`);
    const gKeyOf = new Map(this.core.guides.map((g) => [g.id, guideKey(g)]));
    const gIdOf = new Map(this.core.guides.map((g) => [guideKey(g), g.id]));
    const split = (id, sep) => { const i = String(id).indexOf(sep); return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)]; };
    return {
      out: (cid) => { const [s, k] = split(cid, ':'); return keyOf.has(s) ? `${keyOf.get(s)}:${k}` : null; },
      in: (pid) => { const [s, k] = split(pid, ':'); return srcOf.has(s) ? `${srcOf.get(s)}:${k}` : null; },
      guideOut: (gid) => { const [g, k] = split(gid, '|'); return gKeyOf.has(g) ? `${gKeyOf.get(g)}|${k}` : null; },
      guideIn: (pid) => { const [g, k] = split(pid, '|'); return gIdOf.has(g) ? `${gIdOf.get(g)}|${k}` : null; },
    };
  }

  // What the other place copies: lists and every channel's choices, by plan.
  shared() {
    const m = this.maps();
    const choices = {};
    for (const c of this.core.channels) {
      const pid = m.out(c.id);
      if (!pid) continue;
      const manual = c.mapMode === 'manual' || c.mapMode === 'none';
      choices[pid] = [c.alias || '', c.hidden ? 1 : 0, c.favorite ? 1 : 0, manual ? c.mapMode : 'auto', manual && c.guideId ? m.guideOut(c.guideId) : null];
    }
    const favlists = this.core.favLists.map((l) => ({ ...l, channelIds: l.channelIds.map(m.out).filter(Boolean) }));
    return { stamps: this.stamps, favlists, choices };
  }

  async pull(p) {
    const d = await this.peers.call(p, 'GET', '/api/peer/shared', null, 30000);
    const m = this.maps();
    const mine = this.stamps;
    this.applying = true;
    try {
      if ((d.stamps.favlistsAt || 0) > (mine.favlistsAt || 0)) {
        this.core.store.write('favlists', d.favlists.map((l) => ({ ...l, channelIds: l.channelIds.map(m.in).filter(Boolean) })));
        this.stamp('favlistsAt', d.stamps.favlistsAt);
        this.core.changed('favlists');
      }
      if ((d.stamps.choicesAt || 0) > (mine.choicesAt || 0)) {
        const byId = new Map();
        for (const [pid, v] of Object.entries(d.choices || {})) { const id = m.in(pid); if (id) byId.set(id, v); }
        let n = 0;
        this.core.store.write('channels', this.core.channels.map((c) => {
          const v = byId.get(c.id);
          if (!v) return c;
          const [alias, hidden, favorite, mapMode, guide] = v;
          const next = { ...c, alias, number: alias || (c.sourceNumber ?? c.number), sourceNumber: c.sourceNumber ?? c.number, hidden: !!hidden, favorite: !!favorite };
          if (mapMode !== 'auto') Object.assign(next, { mapMode, guideId: mapMode === 'none' ? null : (guide && m.guideIn(guide)) || c.guideId });
          if (CHOICES.some((k) => next[k] !== c[k])) n++;
          return next;
        }));
        this.stamp('choicesAt', d.stamps.choicesAt);
        if (n) { this.core.note(`copied ${n} channel change${n === 1 ? '' : 's'} from ${p.name}`); this.core.changed('channels'); }
      }
    } finally {
      this.applying = false;
    }
  }

  // ---------- recordings ----------
  // This place's recordings and the other's (ids "~<their id>~<recording id>", at: where).
  async withShared(local) {
    const lists = await Promise.all(this.partners.map(async (p) => {
      const cached = this.recs.get(p.id);
      if (cached && Date.now() - cached.at < RECS_MS) return cached.list;
      try {
        const list = (await this.peers.call(p, 'GET', '/api/recordings', null, 4000))
          .map(({ file, ...r }) => ({ ...r, id: `~${p.id}~${r.id}`, at: p.name }));
        this.recs.set(p.id, { at: Date.now(), list });
        return list;
      } catch (_) {
        return cached ? cached.list : [];
      }
    }));
    const theirs = lists.flat();
    return theirs.length ? [...local, ...theirs].sort((a, b) => (b.start || 0) - (a.start || 0)) : local;
  }

  forget(peerId) { this.recs.delete(peerId); }
}

// "~<peer id>~<recording id>": a recording at the other place.
function remoteRecording(id) {
  const m = /^~([a-f0-9]+)~(.+)$/.exec(String(id));
  return m ? { peerId: m[1], recId: m[2] } : null;
}

module.exports = { Sharing, remoteRecording };
