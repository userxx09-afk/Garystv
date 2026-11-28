// Builds the Vega Fire TV app (the newer Linux Fire TV sticks, which can't run the APK).
// Vega apps are made with Amazon's Vega SDK (Ubuntu or Mac only), so CI does this
// (.github/workflows/vega.yml):
//   1. vega project generate --template vegaWebview ...   -> a fresh Vega WebView app
//   2. node vega/build.js <that app's folder>              -> our screens, App.tsx and manifest into it
//   3. npm install && npm run build:app                    -> build/armv7-release/*.vpkg
// The screens are the same ones the PC app, Fire TV and Samsung apps use, with tizen/tv.js
// (finds the GarysTV server, maps the remote).
const fs = require('fs');
const path = require('path');

const app = process.argv[2];
if (!app || !fs.existsSync(path.join(app, 'manifest.toml'))) throw new Error('usage: node vega/build.js <generated Vega app folder> (with its manifest.toml)');
const root = path.join(__dirname, '..');
const ui = path.join(root, 'src', 'ui');
const tv = path.join(root, 'tizen');
const www = path.join(app, 'assets', 'www');

// ---------- the screens -> assets/www (on the TV: file:///pkg/assets/www/index.html) ----------
fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, 'lib'), { recursive: true });
for (const f of fs.readdirSync(ui)) {
  if (f === 'index.html' || f.startsWith('tray')) continue; // tray icons are PC-only
  fs.copyFileSync(path.join(ui, f), path.join(www, f));
}
fs.copyFileSync(require.resolve('mpegts.js/dist/mpegts.js', { paths: [root] }), path.join(www, 'lib', 'mpegts.js'));
fs.copyFileSync(require.resolve('hls.js/dist/hls.min.js', { paths: [root] }), path.join(www, 'lib', 'hls.js'));
for (const f of ['tv.js', 'tv.css']) fs.copyFileSync(path.join(tv, f), path.join(www, f));

let html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
html = html
  .replace('src="/lib/mpegts.js"', 'src="lib/mpegts.js"')
  .replace('src="/lib/hls.js"', 'src="lib/hls.js"')
  // Lay the screens out 1920 wide, like the other TV apps.
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="width=1920">')
  .replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="tv.css">')
  .replace('<script src="lib/mpegts.js"></script>', '<script src="tv.js"></script>\n  <script src="lib/mpegts.js"></script>');
if (!html.includes('tv.js') || !html.includes('width=1920') || /(src|href)="\//.test(html)) throw new Error('index.html changed shape; update vega/build.js');
fs.writeFileSync(path.join(www, 'index.html'), html);

// ---------- the app itself: a full-screen WebView showing the screens ----------
const srcDir = path.join(app, 'src');
const existing = fs.existsSync(srcDir) ? fs.readdirSync(srcDir).find((f) => /^App\.(tsx|jsx|ts|js)$/.test(f)) : null;
if (existing) fs.rmSync(path.join(srcDir, existing));
fs.mkdirSync(srcDir, { recursive: true });
// App.tsx keeps the last server and reads the stick's IP (two Amazon packages). If those won't
// build, CI runs this again with GTV_VEGA_PLAIN=1 for the plain app (page storage only).
const plain = process.env.GTV_VEGA_PLAIN === '1';
fs.copyFileSync(path.join(__dirname, plain ? 'App.plain.tsx' : 'App.tsx'), path.join(srcDir, 'App.tsx'));
{
  const pj = path.join(app, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
  if (plain) { // take back what an earlier run added
    for (const k of ['@react-native-async-storage/async-storage', '@amazon-devices/expo-network']) {
      if (pkg.dependencies) delete pkg.dependencies[k];
      if (pkg.overrides) delete pkg.overrides[k];
    }
  } else {
    const rn = String((pkg.dependencies || {})['react-native'] || (pkg.devDependencies || {})['react-native'] || '');
    const old = /0\.72/.test(rn); // Vega's React Native 0.72 apps take the older versions
    const storage = `npm:@amazon-devices/react-native-async-storage__async-storage@${old ? '~2.0.0' : '~2.1.0'}`;
    pkg.dependencies = { ...pkg.dependencies, '@react-native-async-storage/async-storage': storage, '@amazon-devices/expo-network': old ? '~2.0.0' : '~3.0.0' };
    pkg.overrides = { ...pkg.overrides, '@react-native-async-storage/async-storage': storage };
    console.log(`React Native ${rn || '?'}: added AsyncStorage + expo-network`);
  }
  fs.writeFileSync(pj, `${JSON.stringify(pkg, null, 2)}\n`);
}

// App icon: assets/image/ is what the manifest's "@image/..." names.
fs.mkdirSync(path.join(app, 'assets', 'image'), { recursive: true });
fs.copyFileSync(path.join(ui, 'icon.png'), path.join(app, 'assets', 'image', 'garystv_icon.png'));

// ---------- manifest: name, version, plain-http to the home server, video/audio/keyboard ----------
const version = process.env.GTV_VERSION || '0.2.0';
let m = fs.readFileSync(path.join(app, 'manifest.toml'), 'utf8');
m = m.replace(/^(\s*title\s*=\s*)".*"/m, '$1"GarysTV"');
if (/^\s*version\s*=/m.test(m)) m = m.replace(/^(\s*version\s*=\s*)".*"/m, `$1"${version}"`);
// Goes up every build, so a new one installs over the old.
if (process.env.GTV_BUILD && /^\s*build-number\s*=/m.test(m)) m = m.replace(/^(\s*build-number\s*=\s*)\d+/m, `$1${+process.env.GTV_BUILD}`);
if (!/^\s*icon\s*=/m.test(m)) m = m.replace(/^(\s*title\s*=.*)$/m, '$1\nicon = "@image/garystv_icon.png"');
// GarysTV servers are on the home network or VPN and talk plain http.
if (!m.includes('[network-traffic-policy.cleartext]')) m += '\n[network-traffic-policy.cleartext]\nallowed-domains = ["*"]\n';
const wants = ['com.amazon.network.service', 'com.amazon.inputmethod.service', 'com.amazon.media.server', 'com.amazon.mediametrics.service',
  'com.amazon.mediabuffer.service', 'com.amazon.mediatransform.service', 'com.amazon.audio.stream', 'com.amazon.audio.control'];
const missing = wants.filter((id) => !m.includes(`"${id}"`));
if (missing.length) {
  // TOML: [[wants.service]] tables can go anywhere after a [wants] header (or create one).
  const block = missing.map((id) => `[[wants.service]]\nid = "${id}"\n`).join('\n');
  m += /^\[wants\]/m.test(m) || /^\[\[wants\./m.test(m) ? `\n${block}` : `\n[wants]\n\n${block}`;
}
fs.writeFileSync(path.join(app, 'manifest.toml'), m);

const files = fs.readdirSync(www, { recursive: true }).filter((f) => fs.statSync(path.join(www, f)).isFile());
console.log(`Vega app ready in ${app} (${files.length} screen files, version ${version}). Next: npm install && npm run build:app`);
