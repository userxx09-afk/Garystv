// Windows app updates: each GitHub Release carries the newest installer (CI publishes one on
// every change to main). The app checks every few hours, downloads a new version in the
// background (electron-updater checks it against the hash in the Release's latest.yml), and
// installs it, then starts again. When (Settings > Updates):
//   scheduled  at the day and time you picked (Sundays 3:00 AM unless changed), within two hours
//   anytime    as soon as it's downloaded
//   ask        only when you choose Restart and update now
// Either way only while nothing is recording or about to record and nobody is watching live TV.
const CHECK_MS = 6 * 3600000;
const TRY_MS = 10 * 60000;
const QUIET_MS = 15 * 60000; // no recording starting this soon
const WINDOW_MS = 2 * 3600000; // how long after the chosen time an update may still go in
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// The plan in Settings; older settings had just autoUpdate on or off.
function plan(s) {
  const when = s.updatePlan || (s.autoUpdate === false ? 'ask' : 'scheduled');
  const [h, m] = String(s.updateTime || '03:00').split(':').map(Number);
  return { when, day: s.updateDay || 'sun', h: h || 0, m: m || 0 };
}
// The most recent chosen moment (this week's Sunday 3:00, or today's for every day), or null if it's not that day.
function lastSlot(p, now = new Date()) {
  const t = new Date(now); t.setHours(p.h, p.m, 0, 0);
  if (t > now) t.setDate(t.getDate() - 1);
  return p.day === 'daily' || DAYS[t.getDay()] === p.day ? t.getTime() : null;
}

function setupUpdates(app, core) {
  const state = { supported: false, current: app.getVersion(), available: null, ready: false, progress: null, error: null, checkedAt: null };
  core.appUpdater = { status: () => state, check: () => null, install: () => { throw new Error('Updates only work in the installed app.'); } };
  let updater;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (_) { return; }
  if (!app.isPackaged) { state.reason = 'Running from the code, not the installed app.'; return; }
  state.supported = true;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true; // also when GarysTV is exited by hand
  const changed = () => core.changed('update');
  updater.on('update-available', (i) => { state.available = i.version; changed(); });
  updater.on('update-not-available', () => { state.available = null; changed(); });
  updater.on('download-progress', (p) => { state.progress = Math.round(p.percent); });
  updater.on('update-downloaded', (i) => { Object.assign(state, { ready: true, available: i.version, progress: 100 }); core.note(`GarysTV ${i.version} is downloaded and ready to install.`); changed(); tryInstall(); });
  updater.on('error', (e) => { state.error = e.message.split('\n')[0]; changed(); });

  const check = () => updater.checkForUpdates()
    .then(() => { state.checkedAt = Date.now(); state.error = null; changed(); })
    .catch((e) => { state.error = e.message.split('\n')[0]; changed(); });

  // Nothing recording, nothing about to, nobody watching live TV here.
  const quiet = () => !core.active.size && !(core.timeshift && core.timeshift.sessions.size)
    && !core.getSchedule().some((j) => j.status === 'scheduled' && j.start - Date.now() < QUIET_MS);
  const install = () => { core.note(`Installing GarysTV ${state.available}; it starts again by itself.`); updater.quitAndInstall(true, true); };
  function due() {
    const p = plan(core.settings);
    if (p.when === 'anytime') return true;
    if (p.when !== 'scheduled') return false;
    const slot = lastSlot(p);
    return slot != null && Date.now() - slot < WINDOW_MS;
  }
  let lastWindowCheck = 0;
  function tryInstall() {
    if (!due()) return;
    // At the chosen time, look for anything newer first.
    if (!state.ready && Date.now() - lastWindowCheck > WINDOW_MS) { lastWindowCheck = Date.now(); check(); return; }
    if (state.ready && quiet()) install();
  }

  core.appUpdater = {
    status: () => ({ ...state, busy: !quiet(), plan: plan(core.settings) }),
    check,
    install: () => {
      if (!state.ready) throw new Error('No update is ready yet.');
      if (core.active.size) throw new Error('A recording is in progress. The update installs when it ends.');
      install();
      return { installing: true };
    },
  };
  setTimeout(check, 30000); // let the first start settle
  setInterval(check, CHECK_MS);
  setInterval(tryInstall, TRY_MS);
}

module.exports = { setupUpdates, plan, lastSlot };
