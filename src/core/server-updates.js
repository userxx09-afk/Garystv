// The home server's own updates (Linux), with the same choices as the Windows app (Settings >
// Updates, core/update-plan.js). Each GitHub Release has the server's files in it; this checks
// every few hours what the newest version is. When an update is due and nothing is recording or
// being watched, it leaves a note in the update folder. A separate helper that runs as root
// (install/update-linux.sh, started by systemd when the note appears) downloads that Release
// itself, checks it, installs it and restarts GarysTV, and puts the old version back if the new
// one doesn't start. The engine never installs anything itself (it runs as a limited user).
const fs = require('fs');
const path = require('path');
const { plan, due, quiet, newer, WINDOW_MS } = require('./update-plan');

const RELEASES = 'https://github.com/userxx09-afk/Garystv/releases/latest/download';
const CHECK_MS = 6 * 3600000;
const TRY_MS = 10 * 60000;

function setupServerUpdates(core, { dir, version }) {
  const state = { supported: true, server: true, current: version, available: null, ready: false, error: null, checkedAt: null, installing: false };
  const note = path.join(dir, 'ready'); // the helper's cue
  const result = path.join(dir, 'status.json'); // what the helper did last time
  const changed = () => core.changed('update');

  // What happened the last time the helper ran (it's written as GarysTV restarts).
  try {
    const last = JSON.parse(fs.readFileSync(result, 'utf8'));
    if (last.at && Date.now() - last.at < 7 * 86400000) {
      if (last.ok && last.version === version) core.note(`Updated to GarysTV ${version}.`);
      else if (!last.ok) { state.lastProblem = `The last update (${last.version || 'new version'}) didn't go in: ${last.error || 'unknown problem'}. The version before it is still running.`; core.note(state.lastProblem); }
    }
  } catch (_) { /* never updated */ }

  let lastWindowCheck = 0;
  let installAt = 0;
  async function check() {
    lastWindowCheck = Date.now();
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 20000);
      const res = await fetch(`${RELEASES}/version.json`, { signal: ac.signal }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const v = await res.json();
      if (!v.linux) throw new Error('The newest release has no home-server files yet.');
      state.available = newer(v.version, version) ? v.version : null;
      state.ready = !!state.available; // nothing to download here: the helper fetches it
      state.checkedAt = Date.now();
      state.error = null;
    } catch (e) {
      state.error = e.name === 'AbortError' ? 'GitHub did not answer.' : e.message;
    }
    changed();
    tryInstall();
  }

  function install() {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(note, `${state.available}\n`);
    state.installing = true;
    installAt = Date.now();
    core.note(`Installing GarysTV ${state.available}; it starts again by itself in a minute or two.`);
    changed();
  }

  function tryInstall() {
    // Still there after a while: the helper isn't set up (a server installed before it existed).
    if (state.installing && Date.now() - installAt > 15 * 60000 && fs.existsSync(note)) {
      state.installing = false;
      state.error = 'The update helper is not set up on this server. Run the installer once more: sudo ./install/install-linux.sh';
      try { fs.unlinkSync(note); } catch (_) {}
      changed();
    }
    if (!state.ready || state.installing) {
      // At the chosen time, look for anything newer first.
      if (!state.installing && due(core.settings) && Date.now() - lastWindowCheck > WINDOW_MS) check();
      return;
    }
    if (due(core.settings) && quiet(core)) install();
  }

  core.appUpdater = {
    status: () => ({ ...state, busy: !quiet(core), plan: plan(core.settings) }),
    check,
    install: () => {
      if (!state.ready) throw new Error('No update is ready yet.');
      if (core.active.size) throw new Error('A recording is in progress. The update installs when it ends.');
      install();
      return { installing: true };
    },
  };
  setTimeout(check, 60000);
  setInterval(check, CHECK_MS);
  setInterval(tryInstall, TRY_MS);
}

module.exports = { setupServerUpdates };
