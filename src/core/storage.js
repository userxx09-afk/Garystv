// Where recordings are saved: a folder on this computer, or network storage (a NAS, or a shared
// folder on another computer). Settings > Recording.
//
// Windows: recordings go straight to the share (\\server\share\folder). The username and
// password go to Windows' own Credential Manager (cmdkey), not GarysTV's settings.
// Home server (Linux): GarysTV runs as a limited user and can't mount a share, so it asks a
// root helper (install/nas-linux.sh, started by systemd when request.json appears in the nas
// folder), the same way updates work. The helper checks every value, keeps the password where
// only root can read it, mounts the share at /mnt/garystvnas and says what happened in
// status.json.
//
// Live TV's rewind buffer always stays on this computer (it's written and thrown away
// constantly). If the network storage can't be reached when a recording starts, that recording
// goes to this computer instead, so the show isn't lost.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const LINUX_MOUNT = '/mnt/garystvnas';
const DEFAULT_LOCAL = path.join(os.homedir(), 'Videos', 'GarysTV');

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// The values typed in Settings, checked (the Linux helper checks them again as root).
function clean(b) {
  const type = b.type === 'nfs' ? 'nfs' : 'smb';
  const server = String(b.server || '').trim().replace(/^\\\\|^\/\//, '').replace(/[\\/].*$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(server)) throw bad('Type the NAS\'s name or address, like 192.168.1.50 or mynas.');
  let share = String(b.share || '').trim();
  if (type === 'smb') {
    share = share.replace(/^[\\/]+|[\\/]+$/g, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._$-]{0,79}$/.test(share)) throw bad('Type the share\'s name (letters, numbers, . _ - only), like Recordings.');
  } else if (!/^\/[A-Za-z0-9._/-]{0,200}$/.test(share) || share.includes('..')) {
    throw bad('Type the NFS export\'s path, like /volume1/recordings.');
  }
  const folder = String(b.folder || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (folder && (!/^[A-Za-z0-9 ._-]+(\/[A-Za-z0-9 ._-]+)*$/.test(folder) || folder.split('/').includes('..'))) throw bad('The folder inside the share can only have letters, numbers, spaces and . _ -');
  const username = String(b.username || '').trim();
  if (!/^[A-Za-z0-9._@\\-]{0,64}$/.test(username)) throw bad('That username has characters GarysTV can\'t pass on.');
  const password = String(b.password || '');
  if (/[\r\n]/.test(password) || password.length > 256) throw bad('That password can\'t be used.');
  return { type, server, share, folder, username, password };
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => (err ? reject(new Error(`${stdout || ''} ${stderr || ''} ${err.message}`)) : resolve(stdout)));
});

// What the NAS (or Windows) said, in plain words.
function explain(text) {
  const t = String(text);
  if (/error\(13\)|Permission denied|System error (1326|86)\b|password is not correct|logon failure/i.test(t)) return 'The NAS said no to that username and password (or that user can\'t use this share).';
  if (/error\(2\)|No such file|System error 67\b|network name cannot be found|access denied by server/i.test(t)) return 'The NAS is there, but it has no share by that name.';
  if (/error\(112\)|error\(115\)|Host is down|No route|could not resolve|System error 53\b|network path was not found|timed out|Connection refused/i.test(t)) return 'Couldn\'t reach the NAS at that address. Check it\'s on and the name or address is right.';
  return t.replace(/\s+/g, ' ').trim().slice(0, 300) || 'It didn\'t connect.';
}

async function writable(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
  const test = path.join(dir, `.garystv-test-${process.pid}`);
  await fs.promises.writeFile(test, 'ok');
  await fs.promises.unlink(test);
}

class Storage {
  constructor(core) {
    this.core = core;
    this.nasDir = null; // home server: where the root helper is asked (headless.js --nas-dir)
    this.reachable = null; // network storage answered at the last check (every minute)
    this.timer = setInterval(() => this.check(), 60000);
    if (this.timer.unref) this.timer.unref();
    setTimeout(() => this.check(), 2000).unref?.();
  }

  get network() { const st = this.core.settings.storage; return !!(st && st.mode === 'network'); }

  // This computer's own recordings folder (also where live TV's rewind buffer goes).
  get localDir() { const s = this.core.settings; return this.network ? (s.localRecordingsDir || DEFAULT_LOCAL) : s.recordingsDir; }

  async check() {
    if (!this.network) { this.reachable = null; return; }
    const before = this.reachable;
    this.reachable = await Promise.race([writable(this.core.settings.recordingsDir).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 15000))]);
    if (before !== null && before !== this.reachable) {
      this.core.note(this.reachable ? 'Network storage is back; recordings are saved there again.' : 'Network storage isn\'t answering; new recordings go to this computer until it\'s back.');
      this.core.changed('settings');
    }
  }

  // The folder a recording starting now goes in.
  recordDir() {
    const s = this.core.settings;
    if (!this.network) return s.recordingsDir;
    try {
      fs.mkdirSync(s.recordingsDir, { recursive: true });
      fs.accessSync(s.recordingsDir, fs.constants.W_OK);
      return s.recordingsDir;
    } catch (_) {
      this.reachable = false;
      this.core.note(`Network storage (${this.describe()}) can't be reached, so this recording goes to ${this.localDir} instead.`);
      return this.localDir;
    }
  }

  describe(st = this.core.settings.storage || {}) {
    if (st.type === 'nfs') return `${st.server}:${st.share}${st.folder ? `/${st.folder}` : ''}`;
    return `\\\\${st.server}\\${st.share}${st.folder ? `\\${st.folder.replace(/\//g, '\\')}` : ''}`;
  }

  status() {
    const st = this.core.settings.storage || { mode: 'local' };
    const { password, ...shown } = st; // never stored, but never shown either
    return { ...shown, mode: st.mode || 'local', where: this.network ? this.describe(st) : this.core.settings.recordingsDir, reachable: this.reachable,
      local: this.localDir, canNetwork: process.platform === 'win32' || (process.platform === 'linux' && !!this.nasDir), nfs: process.platform === 'linux' };
  }

  // Settings > Recording > Network storage > Connect. Answers status() once it's in use.
  async connect(body) {
    const c = clean(body || {});
    let dir;
    if (process.platform === 'win32') {
      if (c.type !== 'smb') throw bad('On Windows, use a shared folder (SMB). NFS works on the home server.');
      const unc = `\\\\${c.server}\\${c.share}`;
      try {
        if (c.username) await run('cmdkey', [`/add:${c.server}`, `/user:${c.username}`, `/pass:${c.password}`]);
        await run('net', ['use', unc, '/persistent:yes']).catch((e) => { if (!/\b1219\b|already/i.test(e.message)) throw e; });
      } catch (e) {
        throw bad(explain(e.message));
      }
      dir = path.win32.join(unc, ...(c.folder ? c.folder.split('/') : []));
    } else if (process.platform === 'linux') {
      if (!this.nasDir) throw bad('This server needs its installer run once more for network storage: sudo ./install/install-linux.sh');
      await this.askHelper(c);
      dir = path.posix.join(LINUX_MOUNT, c.folder || '');
    } else {
      throw bad('Network storage works on Windows and on the home server.');
    }
    try { await writable(dir); } catch (e) { throw bad(`Connected, but GarysTV can't save files in ${dir}: ${e.code === 'EACCES' || e.code === 'EPERM' ? 'that user has no permission to write there' : e.message}`); }
    const { password, ...keep } = c;
    this.core.updateSettings({ storage: { mode: 'network', ...keep }, localRecordingsDir: this.localDir, recordingsDir: dir });
    this.reachable = true;
    this.core.note(`Recordings are now saved on network storage: ${this.describe()}`);
    return this.status();
  }

  // Back to a folder on this computer.
  async useLocal(dir) {
    const to = String(dir || '').trim() || this.localDir;
    try { await writable(to); } catch (e) { throw bad(`GarysTV can't save files in ${to}: ${e.message}`); }
    const wasNetwork = this.network;
    this.core.updateSettings({ storage: { mode: 'local' }, recordingsDir: to, localRecordingsDir: to });
    this.reachable = null;
    if (wasNetwork && process.platform === 'linux' && this.nasDir) this.askHelper({ type: 'none' }).catch((e) => this.core.note(`network storage: ${e.message}`));
    this.core.note(`Recordings are now saved on this computer: ${to}`);
    return this.status();
  }

  // Home server: leave the request for the root helper and wait for its answer.
  async askHelper(req) {
    await fs.promises.mkdir(this.nasDir, { recursive: true });
    const at = Date.now();
    const file = path.join(this.nasDir, 'request.json');
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify({ ...req, at }), { mode: 0o600 });
    await fs.promises.rename(`${file}.tmp`, file);
    const until = Date.now() + 75000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      let st = null;
      try { st = JSON.parse(await fs.promises.readFile(path.join(this.nasDir, 'status.json'), 'utf8')); } catch (_) { continue; }
      if (st.at !== at) continue;
      if (!st.ok) throw bad(explain(st.error));
      return st;
    }
    try { await fs.promises.unlink(file); } catch (_) { /* the helper took it after all */ }
    throw bad('The server\'s network-storage helper didn\'t answer. Run the installer once more: sudo ./install/install-linux.sh');
  }
}

module.exports = { Storage, clean, explain, LINUX_MOUNT };
