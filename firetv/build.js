// Copies the same screens the PC app uses into the Fire TV app (firetv/app/src/main/assets/www),
// with the TV script from tizen/ that finds the server and maps the remote.
// Run: npm run firetv   then build the APK: cd firetv && ./gradlew assembleRelease
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ui = path.join(root, 'src', 'ui');
const tv = path.join(root, 'tizen');
const out = path.join(__dirname, 'app', 'src', 'main', 'assets', 'www');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'lib'), { recursive: true });

for (const f of fs.readdirSync(ui)) {
  if (f === 'index.html' || f.startsWith('tray')) continue; // tray icons are PC-only
  fs.copyFileSync(path.join(ui, f), path.join(out, f));
}
fs.copyFileSync(require.resolve('mpegts.js/dist/mpegts.js'), path.join(out, 'lib', 'mpegts.js'));
fs.copyFileSync(require.resolve('hls.js/dist/hls.min.js'), path.join(out, 'lib', 'hls.js'));
for (const f of ['tv.js', 'tv.css']) fs.copyFileSync(path.join(tv, f), path.join(out, f));

// Same page as the PC app, with paths made relative and the TV script/styles added.
let html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
html = html
  .replace('src="/lib/mpegts.js"', 'src="lib/mpegts.js"')
  .replace('src="/lib/hls.js"', 'src="lib/hls.js"')
  // Fire TV reports a 1080p TV as 960x540 (it doubles everything), which is too narrow for the
  // screens: lay them out at 1920 wide like a Samsung TV and let the app scale that to fit.
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="width=1920">')
  .replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="tv.css">')
  .replace('<script src="lib/mpegts.js"></script>', '<script src="tv.js"></script>\n  <script src="lib/mpegts.js"></script>');
if (!html.includes('tv.js') || !html.includes('width=1920') || /(src|href)="\//.test(html)) throw new Error('index.html changed shape; update firetv/build.js');
fs.writeFileSync(path.join(out, 'index.html'), html);

const files = fs.readdirSync(out, { recursive: true }).filter((f) => fs.statSync(path.join(out, f)).isFile());
console.log(`Built firetv/app/src/main/assets/www (${files.length} files). Next: cd firetv && ./gradlew assembleRelease`);
