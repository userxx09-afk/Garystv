// Other GarysTVs this one is linked with (Settings > Other locations), each at another location
// and reached over Tailscale/headscale. Linking is done once, with the other one's password; after
// that the two share a key and trust each other's requests.
//   - Manage: open the other one's screens from here. Everything goes through this GarysTV
//     (/peer/<id>/...), which passes it on, so it works the same from a TV, the PC or a browser.
//   - share (home and work, using the same IPTV plans): each tells the other which plans it is
//     using (so they never both use a one-stream plan), and lists recordings from both.
// Your parents' GarysTV would be linked without sharing: you can manage it, nothing else changes.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const { remoteIp } = require('./auth');

const HEADER = 'x-garystv-peer'; // "<sender id> <key>"

function normalizeUrl(v) {
  let s = String(v || '').trim();
  if (!s) throw new Error('Type the other GarysTV\'s address, like 100.64.0.5.');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (!u.port && u.protocol === 'http:') u.port = '5480';
  return u.origin;
}

class Peers {
  constructor(core, auth) {
    this.core = core;
    this.auth = auth;
  }

  get list() { return this.core.store.read('peers', []); } // [{ id, name, url, key, share, added, seen }]
  save(list) { this.core.store.write('peers', list); this.core.changed('peers'); }

  // This GarysTV, as the others know it.
  get me() {
    let id = this.core.store.read('serverid', '');
    if (!id) { id = crypto.randomBytes(6).toString('hex'); this.core.store.write('serverid', id); }
    return { id, name: this.core.settings.serverName || os.hostname() };
  }

  find(id) {
    const p = this.list.find((x) => x.id === id);
    if (!p) throw Object.assign(new Error('That GarysTV isn\'t linked any more.'), { status: 404 });
    return p;
  }

  // A request from a linked GarysTV -> { ok, home: false, peer }, else null.
  check(req) {
    const [id, key] = String(req.headers[HEADER] || '').split(' ');
    if (!id || !key) return null;
    const p = this.list.find((x) => x.id === id);
    const ok = p && key.length === p.key.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(p.key));
    if (!ok) return { ok: false, home: false };
    if (Date.now() - (p.seen || 0) > 600000) this.save(this.list.map((x) => (x.id === id ? { ...x, seen: Date.now() } : x)));
    return { ok: true, home: false, peer: p };
  }

  // Link with another GarysTV: its address and its Other locations password.
  async link(req, { url, password, share }) {
    const base = normalizeUrl(url);
    if (this.list.some((p) => p.url === base)) throw new Error('That GarysTV is already linked.');
    const key = crypto.randomBytes(24).toString('hex');
    const me = this.me;
    const res = await this.fetch(`${base}/api/peer/link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, id: me.id, name: me.name, key, share: !!share, port: req.socket.localPort }),
    }, 15000).catch((e) => { throw new Error(`Couldn't reach a GarysTV at ${base.replace(/^https?:\/\//, '')}: ${e.message}`); });
    const them = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(them.error || `It answered ${res.status}`);
    if (them.id === me.id) throw new Error('That address is this GarysTV.');
    const peer = { id: them.id, name: them.name, url: base, key, share: !!share, added: Date.now(), seen: Date.now() };
    this.save([...this.list.filter((p) => p.id !== them.id), peer]);
    this.core.note(`linked with ${them.name} at ${base}${share ? ' (sharing plans and recordings)' : ''}`);
    return { id: peer.id, name: peer.name };
  }

  // The other side of link(): checked with this GarysTV's own Other locations password.
  accept(req, { password, id, name, key, share, port }) {
    this.auth.verify(req, password);
    if (!/^[a-f0-9]{6,32}$/.test(String(id)) || !/^[a-f0-9]{32,64}$/.test(String(key))) throw new Error('Bad link request.');
    const ip = remoteIp(req);
    const url = `http://${ip.includes(':') ? `[${ip}]` : ip}:${+port || 5480}`;
    const peer = { id, name: String(name || 'GarysTV').slice(0, 40), url, key, share: !!share, added: Date.now(), seen: Date.now() };
    this.save([...this.list.filter((p) => p.id !== id), peer]);
    this.core.note(`${peer.name} at ${url} linked with this GarysTV${share ? ' (sharing plans and recordings)' : ''}`);
    return this.me;
  }

  // Unlink here, and tell the other one (it may be off; then it finds out when it next calls).
  async unlink(id) {
    const p = this.find(id);
    this.save(this.list.filter((x) => x.id !== id));
    await this.call(p, 'DELETE', '/api/peer/self').catch(() => {});
  }

  // The other one unlinked this one.
  dropped(peer) { this.save(this.list.filter((x) => x.id !== peer.id)); }

  fetch(url, opts = {}, ms = 10000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
  }

  // A request to a linked GarysTV. -> its JSON answer.
  async call(p, method, path, body, ms = 10000) {
    const res = await this.fetch(`${p.url}${path}`, {
      method, headers: { [HEADER]: `${this.me.id} ${p.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, ms);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `${p.name} answered ${res.status}`);
    return data;
  }

  // /peer/<id>/<anything>: passed on to that GarysTV as it is (screens, API, video), with this one's key.
  proxy(req, res, id, rest) {
    const p = this.find(id);
    const target = new URL(rest, p.url);
    const headers = { [HEADER]: `${this.me.id} ${p.key}` };
    for (const h of ['content-type', 'content-length', 'range', 'accept']) if (req.headers[h]) headers[h] = req.headers[h];
    const up = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, (r) => {
      const out = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'location']) if (r.headers[h]) out[h] = r.headers[h];
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    });
    up.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Couldn't reach ${p.name}: ${e.message}` }));
    });
    req.pipe(up);
    res.on('close', () => up.destroy());
  }

  // For Settings (never the keys).
  overview() {
    return { me: this.me, peers: this.list.map(({ key, ...p }) => p) };
  }
}

module.exports = { Peers, normalizeUrl };
