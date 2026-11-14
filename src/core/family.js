// Family IPTV accounts: one GarysTV (tapper) keeps IPTV logins in its secrets file, and another
// GarysTV (a parent's, a sister's) adds one with a short family code, from a hidden page (tap
// Settings > Status 12 times). The login goes engine to engine over TapperVPN and is saved in the
// new GarysTV like one typed in; after that tapper and the VPN aren't needed. Passwords never
// reach the screens, the code or the repo.
//
// On the GarysTV that offers them (/etc/garystv/secrets.env, loaded as environment variables):
//   FAMILY_CODE=482915                       the code family members type (6+ characters)
//   IPTV_..., IPTV2_...                      the server's own accounts (headless.js) are offered too;
//   IPTV2_FAMILY=no                          ...except one marked like this
//   FAMILY1_NAME=Prime FAMILY1_SERVERS=... FAMILY1_USERNAME=... FAMILY1_PASSWORD=...
//                                            offered only; this GarysTV doesn't use them itself
// Only callers on this network or TapperVPN may ask, and wrong codes are limited.
const crypto = require('crypto');
const { remoteIp } = require('./auth');

const DEFAULT_SERVER = 'http://100.64.0.2:5480'; // tapper over TapperVPN
const TRIES = 5; // wrong codes per address
const TRIES_MS = 15 * 60000;
const ALL_TRIES = 20; // wrong codes from anywhere, per hour: then nobody for a while
const NOT_HERE = 'Not available here.';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const vpnOrHome = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /^fd7a:115c:a1e0:/i.test(ip)
  || ip === '::1' || /^(127\.|10\.|192\.168\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
const fail = (status, message) => Object.assign(new Error(message), { status });

// The secrets file as KEY=value pairs (systemd's format: optional double quotes, \" and \\ inside).
function readSecrets(file) {
  let text = '';
  try { text = require('fs').readFileSync(file, 'utf8'); } catch (_) { return {}; }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

class Family {
  // secretsFile: read on every ask, so accounts added there work without restarting GarysTV.
  constructor(core, { env = process.env, secretsFile = null, fetchImpl = (...a) => fetch(...a) } = {}) {
    Object.assign(this, { core, baseEnv: env, secretsFile, fetchImpl });
    this.fails = new Map(); // ip -> [times]
    this.allFails = [];
  }

  get env() { return this.secretsFile ? { ...this.baseEnv, ...readSecrets(this.secretsFile) } : this.baseEnv; }

  // ---------- offering (tapper) ----------
  accounts(env = this.env) {
    const pres = Object.keys(env).map((k) => (/^((?:IPTV|FAMILY)\d*)_USERNAME$/.exec(k) || [])[1]).filter(Boolean).sort();
    return pres.map((pre) => {
      const v = (k) => String(env[`${pre}_${k}`] || '').trim();
      if (/^IPTV/.test(pre) && /^(no|false|0)$/i.test(v('FAMILY'))) return null;
      if (!v('SERVERS') || !v('USERNAME') || !v('PASSWORD')) return null;
      const name = v('NAME') || (pre.replace(/^(IPTV|FAMILY)/, (m) => (m === 'IPTV' ? 'IPTV ' : 'Account ')).trim());
      return { id: pre.toLowerCase(), name, config: { servers: v('SERVERS'), username: v('USERNAME'), password: v('PASSWORD'), groups: v('GROUPS'), firstNumber: v('FIRST_NUMBER'), maxStreams: v('MAX_STREAMS') } };
    }).filter(Boolean);
  }

  // POST /api/family/offer { code, id? } from another GarysTV -> { accounts: [{ id, name }] }, or with
  // id, { name, config } for that one.
  offer(req, body) {
    const ip = remoteIp(req);
    const env = this.env;
    const code = String(env.FAMILY_CODE || '').trim();
    if (!vpnOrHome(ip) || code.length < 6) throw fail(404, NOT_HERE);
    const now = Date.now();
    this.allFails = this.allFails.filter((t) => now - t < 3600e3);
    const recent = (this.fails.get(ip) || []).filter((t) => now - t < TRIES_MS);
    if (recent.length >= TRIES || this.allFails.length >= ALL_TRIES) throw fail(429, 'Too many wrong codes. Try again later.');
    if (!crypto.timingSafeEqual(sha(code), sha(String((body && body.code) || '').trim()))) {
      this.fails.set(ip, [...recent, now]);
      this.allFails.push(now);
      this.core.note(`family: wrong code from ${ip}`);
      throw fail(403, 'That code isn\'t right.');
    }
    const list = this.accounts(env);
    if (!body.id) return { accounts: list.map(({ id, name }) => ({ id, name })) };
    const a = list.find((x) => x.id === String(body.id));
    if (!a) throw fail(404, 'That account is gone.');
    this.core.note(`family: gave ${a.name} to ${ip}`);
    return { name: a.name, config: a.config };
  }

  // ---------- importing (everyone else) ----------
  get server() { return String(this.core.settings.familyServer || DEFAULT_SERVER).replace(/\/+$/, ''); }

  async ask(body) {
    let res;
    try {
      res = await this.fetchImpl(`${this.server}/api/family/offer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    } catch (_) { throw fail(503, NOT_HERE); } // not on TapperVPN, or tapper is off
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(res.status === 404 ? 503 : res.status, res.status === 404 ? NOT_HERE : data.error || NOT_HERE);
    return data;
  }

  // The accounts offered, and which are already here.
  async list(code) {
    const { accounts = [] } = await this.ask({ code });
    const have = new Set(this.core.sources.map((s) => s.config && s.config.family).filter(Boolean));
    return accounts.map((a) => ({ id: a.id, name: a.name, added: have.has(a.id) }));
  }

  // Adds it as an IPTV provider, like one typed into Settings. -> { name }
  async add(code, id) {
    const existing = this.core.sources.find((s) => s.config && s.config.family === id);
    if (existing) return { name: existing.name, already: true };
    const { name, config } = await this.ask({ code, id });
    if (!config || !config.servers || !config.username || !config.password) throw fail(502, NOT_HERE);
    // A second login to the same service would number its channels from 1000 too: the next thousand.
    const used = this.core.sources.filter((s) => s.type === 'xtream').map((s) => parseInt(s.config && s.config.firstNumber, 10) || 1000);
    const firstNumber = config.firstNumber || (used.length ? String(Math.max(...used) + 1000) : '');
    const src = await this.core.addSource({ type: 'xtream', name, config: { ...config, firstNumber, family: id } });
    return { name: src.name };
  }
}

module.exports = { Family, vpnOrHome, readSecrets, DEFAULT_SERVER };
