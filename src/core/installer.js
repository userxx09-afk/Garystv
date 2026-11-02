// Installs the helper programs on a Windows PC when they're missing: ffmpeg (needed to watch
// in the app and for some IPTV recordings) and VLC (a backup player). Uses winget, which comes
// with Windows 10 and 11 and checks each download against the package's published hash.
// ffmpeg installs for this user only, with no prompt; VLC's installer asks Windows for
// permission (a UAC prompt on the PC). A home server (Linux) gets them from its installer.
const { execFile } = require('child_process');
const { findFfmpeg, findVlc } = require('./tools');

const PACKAGES = {
  ffmpeg: { id: 'Gyan.FFmpeg', label: 'ffmpeg', find: findFfmpeg },
  vlc: { id: 'VideoLAN.VLC', label: 'VLC', find: findVlc },
};

class ToolInstaller {
  constructor(core) {
    this.core = core;
    this.state = {}; // name -> { busy: true } | { error } while or after installing
  }

  // What the Status screen shows next to each helper.
  status() {
    return { canInstall: process.platform === 'win32', ...this.state };
  }

  install(name) {
    const pkg = PACKAGES[name];
    if (!pkg) throw new Error('Unknown helper');
    if (process.platform !== 'win32') {
      throw new Error(`On the home server, install it there: sudo apt install ${name === 'vlc' ? 'vlc' : 'ffmpeg'}`);
    }
    if (pkg.find(this.core.settings)) return { done: true };
    if (this.state[name] && this.state[name].busy) return { busy: true };
    this.state[name] = { busy: true };
    this.core.note(`Installing ${pkg.label}...`);
    this.core.changed('status');
    const args = ['install', '--id', pkg.id, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
    if (name === 'ffmpeg') args.push('--scope', 'user');
    execFile('winget', args, { windowsHide: true, timeout: 15 * 60000 }, (err, stdout) => {
      const found = pkg.find(this.core.settings);
      if (found) {
        delete this.state[name];
        this.core.note(`${pkg.label} installed: ${found}`);
      } else {
        const why = err && err.code === 'ENOENT' ? "winget isn't on this PC (it comes with the App Installer from the Microsoft Store)"
          : /cancel|denied|1602|0x8a150056/i.test(`${stdout}${err && err.message}`) ? 'Windows asked for permission and it was not given'
            : 'the install did not finish';
        this.state[name] = { error: `Couldn't install ${pkg.label}: ${why}.` };
        this.core.note(this.state[name].error);
      }
      this.core.changed('status');
    });
    return { started: true };
  }

  // At start-up on Windows: put in whatever is missing. VLC only gets one automatic try, so
  // saying no to Windows' permission prompt isn't asked again every start (Settings can retry).
  autoInstall() {
    if (process.platform !== 'win32' || this.core.demo) return;
    if (!findFfmpeg(this.core.settings)) this.install('ffmpeg');
    if (!findVlc(this.core.settings) && !this.core.settings.vlcAutoTried) {
      this.core.updateSettings({ vlcAutoTried: true });
      this.install('vlc');
    }
  }
}

module.exports = { ToolInstaller };
