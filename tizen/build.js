// Builds the Samsung TV (Tizen) app folder from the same screens the PC app uses.
// Output: tizen/build/  -> sign & package it with Tizen Studio (see tizen/README.md).
// Run: npm run tizen
const fs = require('fs');
const path = require('path');

const here = __dirname;
const ui = path.join(here, '..', 'src', 'ui');
const out = path.join(here, 'build');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'lib'), { recursive: true });

for (const f of fs.readdirSync(ui)) {
  if (f === 'index.html' || f.startsWith('tray')) continue; // tray icons are PC-only
  fs.copyFileSync(path.join(ui, f), path.join(out, f));
}
fs.copyFileSync(require.resolve('mpegts.js/dist/mpegts.js'), path.join(out, 'lib', 'mpegts.js'));
fs.copyFileSync(require.resolve('hls.js/dist/hls.min.js'), path.join(out, 'lib', 'hls.js'));
for (const f of ['config.xml', 'tv.js', 'tv.css']) fs.copyFileSync(path.join(here, f), path.join(out, f));
fs.copyFileSync(path.join(ui, 'icon.png'), path.join(out, 'icon.png'));

// Same page as the PC app, with paths made relative and the TV script/styles added.
let html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
html = html
  .replace('src="/lib/mpegts.js"', 'src="lib/mpegts.js"')
  .replace('src="/lib/hls.js"', 'src="lib/hls.js"')
  .replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="tv.css">')
  .replace('<script src="lib/mpegts.js"></script>', '<script src="tv.js"></script>\n  <script src="lib/mpegts.js"></script>');
if (!html.includes('tv.js') || /(src|href)="\//.test(html)) throw new Error('index.html changed shape; update tizen/build.js');
fs.writeFileSync(path.join(out, 'index.html'), html);

const files = fs.readdirSync(out, { recursive: true }).filter((f) => fs.statSync(path.join(out, f)).isFile());
console.log(`Built tizen/build (${files.length} files). Next: package and install it with Tizen Studio (tizen/README.md).`);
