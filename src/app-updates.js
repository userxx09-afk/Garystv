// Windows app updates: each GitHub Release carries the newest installer (CI publishes one on
// every change to main). The app checks every few hours, downloads a new version in the
// background (electron-updater checks it against the hash in the Release's latest.yml), and
// installs it, then starts again, when Settings > Updates says (core/update-plan.js).
const { plan, lastSlot, due, quiet: isQuiet, WINDOW_MS } = require('./core/update-plan');

const CHECK_MS = 6 * 3600000;
const TRY_MS = 10 * 60000;

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

  const quiet = () => isQuiet(core);
  const install = () => { core.note(`Installing GarysTV ${state.available}; it starts again by itself.`); updater.quitAndInstall(true, true); };
  let lastWindowCheck = 0;
  function tryInstall() {
    if (!due(core.settings)) return;
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
