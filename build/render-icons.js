// Renders build/*.svg to the PNG icons the app uses. Run: npx electron build/render-icons.js
// (Electron's Chromium does the drawing, so the text uses real Windows fonts.)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ui = path.join(__dirname, '..', 'src', 'ui');
const res = path.join(__dirname, '..', 'firetv', 'app', 'src', 'main', 'res');
// [svg, width, height, output file]
const jobs = [
  ['icon.svg', 256, 256, path.join(ui, 'icon.png')],
  ['tray.svg', 16, 16, path.join(ui, 'tray.png')],
  ['tray.svg', 32, 32, path.join(ui, 'tray@2x.png')],
  // Fire TV: home screen banner and app icon
  ['banner.svg', 320, 180, path.join(res, 'drawable', 'banner.png')],
  ['banner.svg', 640, 360, path.join(res, 'drawable-xhdpi', 'banner.png')],
  ['icon.svg', 192, 192, path.join(res, 'mipmap-xxxhdpi', 'ic_launcher.png')],
];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 700, height: 400, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const page = path.join(os.tmpdir(), 'garystv-icon.html');
  for (const [svg, width, height, out] of jobs) {
    const markup = fs.readFileSync(path.join(__dirname, svg), 'utf8').replace('<svg ', `<svg width="${width}" height="${height}" `);
    fs.writeFileSync(page, `<html><body style="margin:0;background:transparent">${markup}</body></html>`);
    await win.loadFile(page);
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img.resize({ width, height }).toPNG());
    console.log('wrote', path.relative(path.join(__dirname, '..'), out));
  }
  fs.rmSync(page, { force: true });
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
