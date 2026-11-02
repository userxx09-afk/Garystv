// Windows app shell. The DVR engine runs here; the window just shows the
// screens. Closing the window asks whether to exit or keep GarysTV in the tray
// so timers still record (Settings can remember the answer).
const { app, BrowserWindow, Tray, Menu, nativeImage, powerSaveBlocker, globalShortcut, dialog } = require('electron');
const path = require('path');
const { DvrCore } = require('./src/core');
const { createServer } = require('./src/core/server');

const args = process.argv.slice(1);
const flag = (name) => { const a = args.find((x) => x.startsWith(`--${name}`)); return a ? (a.split('=')[1] ?? true) : null; };

let core, win, tray, port, sleepBlock = null, quitting = false, shutDown = false;

if (!flag('shot') && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function listen(server, start) {
  const host = core.settings.allowNetwork ? '0.0.0.0' : '127.0.0.1';
  return new Promise((resolve, reject) => {
    let p = start;
    server.on('error', (e) => (e.code === 'EADDRINUSE' && p < start + 20 ? server.listen(++p, host) : reject(e)));
    server.listen(p, host, () => resolve(p));
  });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: +(flag('w') || 1600), height: +(flag('h') || 900), minWidth: 1100, minHeight: 640, useContentSize: true, backgroundColor: '#05070c', show: false,
    title: 'GarysTV', icon: path.join(__dirname, 'src', 'ui', 'icon.png'), autoHideMenuBar: true,
    // No background throttling: a minimized or covered window still gets the time it needs, so TV keeps playing smoothly.
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: !!flag('shot'), backgroundThrottling: false },
  });
  win.setMenu(null);
  const view = flag('view');
  win.loadURL(`http://127.0.0.1:${port}/${view ? `#${view}` : ''}`);
  win.once('ready-to-show', () => { if (!flag('shot') && !flag('hidden')) { win.maximize(); win.show(); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
  win.on('close', (e) => {
    if (quitting || flag('shot')) return;
    e.preventDefault();
    askOnClose();
  });
  win.on('closed', () => { win = null; });
}

// Closing the window: exit, or keep running in the tray so timers record. Either way,
// whatever was playing stops (a hidden window used to keep playing, with nothing to stop it).
async function askOnClose() {
  let action = core.settings.closeAction; // 'tray' | 'exit' | 'ask'
  if (action !== 'tray' && action !== 'exit') {
    const rec = core.active.size;
    const timers = core.getSchedule().some((j) => j.status === 'scheduled' && j.recStart > Date.now());
    const detail = rec ? `${rec} recording${rec > 1 ? 's are' : ' is'} in progress. Exiting stops ${rec > 1 ? 'them' : 'it'}.`
      : timers ? 'You have timers set. They only record while GarysTV is running.'
        : 'GarysTV can keep running in the tray (by the clock) so timers record.';
    const r = await dialog.showMessageBox(win, {
      type: 'question', title: 'Close GarysTV', message: 'Close GarysTV?', detail, noLink: true,
      buttons: ['Keep running in the tray', 'Exit GarysTV', 'Cancel'], defaultId: rec || timers ? 0 : 1, cancelId: 2,
      checkboxLabel: 'Remember my choice (change it in Settings > Recording)',
    });
    if (r.response === 2) return;
    action = r.response === 0 ? 'tray' : 'exit';
    if (r.checkboxChecked) core.updateSettings({ closeAction: action });
  }
  if (win) win.webContents.executeJavaScript('window.Player && Player.stop(); window.App && App.render && App.render();').catch(() => {});
  if (action === 'exit') app.quit();
  else win.hide();
}

// Test hook: render a screen and save it as a PNG, then exit.
async function screenshot(file) {
  await new Promise((r) => setTimeout(r, +(flag('wait') || 2500)));
  const keys = flag('keys'); // e.g. --keys=Down,Down,Right,Enter
  for (const k of keys ? String(keys).split(',') : []) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k });
    await new Promise((r) => setTimeout(r, 400));
  }
  if (keys) await new Promise((r) => setTimeout(r, 1500));
  try {
    const img = await win.webContents.capturePage();
    require('fs').writeFileSync(file, img.toPNG());
  } catch (e) {
    console.error('screenshot failed:', e.message);
  }
  quitting = true;
  app.exit(0);
}

app.whenReady().then(async () => {
  core = new DvrCore({ dataDir: flag('data') || path.join(app.getPath('userData'), 'data'), demo: !!flag('demo') });
  await core.init();
  port = await listen(createServer(core), core.settings.port);
  core.tools.autoInstall(); // ffmpeg and VLC, if this PC doesn't have them yet

  app.setLoginItemSettings({ openAtLogin: !!core.settings.startWithWindows, args: ['--hidden'] });
  core.on('changed', () => {
    app.setLoginItemSettings({ openAtLogin: !!core.settings.startWithWindows, args: ['--hidden'] });
    const busy = core.active.size > 0;
    if (busy && sleepBlock === null) sleepBlock = powerSaveBlocker.start('prevent-app-suspension');
    if (!busy && sleepBlock !== null) { powerSaveBlocker.stop(sleepBlock); sleepBlock = null; }
    if (tray) tray.setToolTip(busy ? `GarysTV - recording ${core.active.size}` : 'GarysTV');
  });

  // tray.png is drawn at 16px; Electron picks tray@2x.png on scaled displays.
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'src', 'ui', 'tray.png')));
  tray.setToolTip('GarysTV');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open GarysTV', click: showWindow },
    { type: 'separator' },
    { label: 'Exit GarysTV (stops recordings)', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);

  createWindow();
  if (flag('shot')) screenshot(flag('shot'));
});

// Stay running (in the tray) with no windows open, so timers keep recording.
app.on('window-all-closed', () => {});
// Exit cleanly: stop recordings and the live buffer (and their ffmpeg processes), let files
// finish writing, then go. Without this, ffmpeg could be left running after GarysTV closed.
app.on('before-quit', (e) => {
  quitting = true;
  if (shutDown) return;
  e.preventDefault();
  shutDown = true;
  globalShortcut.unregisterAll();
  if (tray) tray.destroy();
  if (win) win.hide();
  Promise.resolve(core && core.shutdown()).catch(() => {}).finally(() => app.exit(0));
});
