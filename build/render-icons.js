// Renders build/*.svg to the PNG icons the app uses. Run: npx electron build/render-icons.js
// (Electron's Chromium does the drawing, so the text uses real Windows fonts.)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ui = path.join(__dirname, '..', 'src', 'ui');
const jobs = [
  ['icon.svg', 256, 'icon.png'],
  ['tray.svg', 16, 'tray.png'],
  ['tray.svg', 32, 'tray@2x.png'],
];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 300, height: 300, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const page = path.join(os.tmpdir(), 'garystv-icon.html');
  for (const [svg, size, out] of jobs) {
    const markup = fs.readFileSync(path.join(__dirname, svg), 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `);
    fs.writeFileSync(page, `<html><body style="margin:0;background:transparent">${markup}</body></html>`);
    await win.loadFile(page);
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    fs.writeFileSync(path.join(ui, out), img.resize({ width: size, height: size }).toPNG());
    console.log('wrote', out);
  }
  fs.rmSync(page, { force: true });
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
