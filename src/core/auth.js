// Who may use this GarysTV. Devices on this home network (and this computer) just can, as
// always. Anything else (another location over Tailscale/headscale, say) must sign in once with
// the password set in Settings > Other locations; the device is then remembered for a year.
// With no password set, other locations are refused. Linked GarysTVs (peers.js) use their own key.
const crypto = require('crypto');

const COOKIE = 'gtv_login';
const YEAR_S = 365 * 86400;
const TRIES = 5; // wrong passwords allowed per address
const TRIES_MS = 10 * 60000; // in this long

// The caller's own address (not anything it claims in a header).
function remoteIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

// This computer or the home network. Tailscale's addresses (100.64.0.0/10, fd7a:115c:a1e0::/48)
// are another location, even though they look private.
function isHome(ip) {
  if (ip === '::1' || /^127\./.test(ip)) return true;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^fd7a:115c:a1e0:/i.test(ip)) return false;
  return /^(fe8|fe9|fea|feb|fc|fd)/i.test(ip);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}

function cookieValue(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

class Auth {
  constructor(core) {
    this.core = core;
    this.fails = new Map(); // ip -> [times]
  }

  get password() { return this.core.store.read('remotepassword', null); } // { salt, hash }
  get logins() { return this.core.store.read('logins', []); } // [{ id, token: sha256, device, created, lastSeen, ip }]

  setPassword(password) {
    const p = String(password || '');
    if (!p) {
      this.core.store.write('remotepassword', null);
      this.core.store.write('logins', []); // no password: nobody from away stays signed in
      return { on: false };
    }
    if (p.length < 6) throw new Error('Use at least 6 characters.');
    this.core.store.write('remotepassword', hashPassword(p));
    return { on: true };
  }

  // -> { home, ok, login? }. A linked GarysTV is checked by peers.js before this.
  check(req) {
    const ip = remoteIp(req);
    if (isHome(ip)) return { home: true, ok: true };
    const token = cookieValue(req, COOKIE);
    const login = token && this.logins.find((l) => l.token === sha(token));
    if (!login) return { home: false, ok: false };
    if (Date.now() - (login.lastSeen || 0) > 3600000) { // note it now and then, not on every video piece
      this.core.store.write('logins', this.logins.map((l) => (l.id === login.id ? { ...l, lastSeen: Date.now(), ip } : l)));
    }
    return { home: false, ok: true, login };
  }

  // Throws unless it's the password for other locations (a few wrong tries per address, then a wait).
  verify(req, password) {
    const ip = remoteIp(req);
    const recent = (this.fails.get(ip) || []).filter((t) => Date.now() - t < TRIES_MS);
    if (recent.length >= TRIES) throw Object.assign(new Error('Too many wrong passwords. Wait ten minutes and try again.'), { status: 429 });
    const p = this.password;
    if (!p) throw Object.assign(new Error('That GarysTV doesn\'t allow other locations yet. There, set a password in Settings > Other locations.'), { status: 403 });
    const given = hashPassword(password || '', p.salt).hash;
    if (!crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(p.hash, 'hex'))) {
      this.fails.set(ip, [...recent, Date.now()]);
      throw Object.assign(new Error('That password is not right.'), { status: 401 });
    }
    this.fails.delete(ip);
  }

  // Sign in from another location. -> the Set-Cookie header to send.
  signIn(req, { password, device }) {
    this.verify(req, password);
    const ip = remoteIp(req);
    const token = crypto.randomBytes(32).toString('hex');
    const login = { id: crypto.randomBytes(5).toString('hex'), token: sha(token), device: String(device || 'A device').slice(0, 60), created: Date.now(), lastSeen: Date.now(), ip };
    this.core.store.write('logins', [...this.logins, login]);
    this.core.note(`signed in from another location: ${login.device} (${ip})`);
    return `${COOKIE}=${token}; Path=/; Max-Age=${YEAR_S}; HttpOnly; SameSite=Lax`;
  }

  signOut(id) {
    this.core.store.write('logins', id ? this.logins.filter((l) => l.id !== id) : []);
  }

  // For Settings: whether a password is set and who is signed in (never the tokens).
  overview() {
    return { passwordSet: !!this.password, logins: this.logins.map(({ token, ...l }) => l) };
  }
}

module.exports = { Auth, isHome, remoteIp, COOKIE };
