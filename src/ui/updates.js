// Updates for this device. New versions come from the GitHub Release that CI publishes on
// every change: the Fire TV / Android app checks it itself (GTVAndroid) and hands the new APK
// to Android's installer; the Windows app's engine downloads and installs its own
// (src/app-updates.js). Browsers and the Samsung app show the screens of the GarysTV they're
// connected to, so they change when that is updated.
/* global GTVAndroid */
const Updates = {
  android: typeof GTVAndroid !== 'undefined' && !!GTVAndroid.checkUpdate,
  info: null, state: null, detail: null, error: null, listeners: new Set(),

  get windowsApp() { return !window.GTV_SERVER && App.state && App.state.status.platform === 'win32'; },

  // On this TV or phone: offer updates when GarysTV starts (Settings > Updates can turn it off).
  get autoOffer() { try { return localStorage.getItem('gtv.autoUpdate') !== 'off'; } catch (_) { return true; } },
  set autoOffer(on) { try { localStorage.setItem('gtv.autoUpdate', on ? 'on' : 'off'); } catch (_) { /* private mode */ } },

  changed() { for (const f of this.listeners) f(); },

  check() {
    if (!this.android) return;
    this.error = null;
    this.state = 'checking';
    this.changed();
    GTVAndroid.checkUpdate();
  },

  install() {
    if (!this.android) return;
    this.error = null;
    this.state = 'downloading';
    this.detail = 0;
    this.changed();
    GTVAndroid.installUpdate();
  },

  // At start-up: if a newer version is out, ask once a day.
  startCheck() {
    if (!this.android || !this.autoOffer) return;
    this.offering = true;
    setTimeout(() => this.check(), 8000);
  },

  async offer() {
    this.offering = false;
    const i = this.info;
    let asked = null;
    try { asked = localStorage.getItem('gtv.updateAsked'); } catch (_) { /* private mode */ }
    const today = `${i.version}|${new Date().toDateString()}`;
    if (asked === today || Modal.top() || Player.mode === 'full') return;
    try { localStorage.setItem('gtv.updateAsked', today); } catch (_) { /* private mode */ }
    const v = await Modal.menu('Update available', `<div class="s">GarysTV <b>${esc(i.version)}</b> is ready (you have ${esc(GTVAndroid.appVersion())}). It takes about a minute; Android asks you to confirm.</div>`,
      [{ label: 'Install now', value: true, cls: 'primary' }, { label: 'Later', value: false }]);
    if (v) { this.install(); toast('Downloading the update...'); }
  },
};

// Answers from the Android side.
window.GTV_UPDATE_INFO = (info, error) => {
  Updates.info = info;
  Updates.error = error || null;
  Updates.state = null;
  Updates.changed();
  if (info && info.newer && Updates.offering) Updates.offer();
};
window.GTV_UPDATE_STATE = (state, detail) => {
  Updates.state = state;
  Updates.detail = detail;
  if (state === 'error') { Updates.error = detail; Updates.state = null; toast(`Update: ${detail}`, 6000); }
  if (state === 'permission') toast('Turn on "Allow from this source" for GarysTV, come back, and choose Install again.', 9000);
  Updates.changed();
};
