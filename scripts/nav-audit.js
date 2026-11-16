// Remote-control check: opens every screen of a practice GarysTV in a hidden window at TV size
// (and PC size), and from every highlightable item presses ← → ↑ ↓. It reports a press that
// goes nowhere when there's something that way, and one that lands the wrong way.
// Run: npm run nav-audit   (uses Electron; nothing is shown on screen)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DvrCore } = require('../src/core');
const { createServer } = require('../src/core/server');

const SIZES = [{ name: 'TV 1920x1080', w: 1920, h: 1080, tv: true }, { name: 'PC 1280x720', w: 1280, h: 720, tv: false }];
const TV_CSS = fs.readFileSync(path.join(__dirname, '..', 'tizen', 'tv.css'), 'utf8');

// Runs in the page. For one screen: every item x every arrow, from a fresh copy of the screen.
const AUDIT = async (screen, opts) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { for (let i = 0; i < 20; i++) { await sleep(25); if (!document.querySelector('#view .empty') || i > 6) break; } await sleep(60); };
  const open = async () => {
    while (Modal.closeTop());
    if (screen.startsWith('settings:')) { SettingsView.section = screen.split(':')[1]; App.viewName = 'settings'; } else App.viewName = screen;
    DvrView.folder = null;
    await App.render();
    await settle();
    if (opts.modal) { await opts.modal(); await settle(); }
  };
  const label = (el) => (el ? `${el.dataset.key || el.id || el.className.split(' ')[0]}: "${(el.textContent || el.value || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"` : 'nothing');
  const key = (el) => el.dataset.key || null;
  const press = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const visible = (b) => b.width > 0 && b.height > 0;
  await open();
  const start = Nav.items().filter((el) => !el.closest('#topnav') || screen === 'home');
  const keys = start.map(key);
  const problems = [];
  const max = Math.min(start.length, opts.max || 80);
  let stale = false;
  for (let i = 0; i < max; i++) {
    for (const [dir, k] of [['left', 'ArrowLeft'], ['right', 'ArrowRight'], ['up', 'ArrowUp'], ['down', 'ArrowDown']]) {
      if (stale) { await open(); stale = false; }
      const items = Nav.items();
      const el = (keys[i] && items.find((x) => key(x) === keys[i])) || items.filter((x) => !x.closest('#topnav') || screen === 'home')[i];
      if (!el) continue;
      // Option rows: ←→ change the choice, on purpose.
      if (el._cycle && (dir === 'left' || dir === 'right')) continue;
      Nav.focus(el);
      await sleep(30);
      // A text box: ←→ move along the text first, so start from that end of it.
      if (el.tagName === 'INPUT' && el.selectionStart != null) { const at = dir === 'left' ? 0 : el.value.length; el.setSelectionRange(at, at); }
      if (el.tagName === 'INPUT' && el.selectionStart == null && el.type !== 'checkbox' && (dir === 'left' || dir === 'right')) continue; // dates, times, numbers: ←→ change them
      const a = el.getBoundingClientRect();
      if (!visible(a)) continue;
      // What's that way, as someone looking at the screen would see it.
      const others = Nav.items().filter((x) => x !== el).map((x) => ({ x, b: x.getBoundingClientRect() })).filter(({ b }) => visible(b));
      const overlapV = (b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4;
      const overlapH = (b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4;
      const that = {
        left: others.filter(({ b }) => b.right <= a.left + 4 && overlapV(b)),
        right: others.filter(({ b }) => b.left >= a.right - 4 && overlapV(b)),
        up: others.filter(({ b }) => b.bottom <= a.top + 4),
        down: others.filter(({ b }) => b.top >= a.bottom - 4),
      }[dir];
      const before = { view: App.viewName, modal: Modal.stack.length, cur: Nav.current };
      const html = document.querySelector('#view').innerHTML.length;
      press(k);
      await sleep(60);
      const now = Nav.current;
      // Anything but the highlight changed (a list redrawn, a tab switched): start the next press from a fresh copy.
      stale = !document.body.contains(el) || App.viewName !== before.view || Modal.stack.length !== before.modal || document.querySelector('#view').innerHTML.length !== html;
      if (App.viewName !== before.view || Modal.stack.length !== before.modal) continue; // the screen changed on purpose (rare for arrows)
      if (now === el || !now || !document.body.contains(now)) {
        if (that.length) problems.push({ dir, from: label(el), there: label(that.sort((p, q) => Math.abs(p.b.top - a.top) - Math.abs(q.b.top - a.top))[0].x), kind: 'stuck' });
        continue;
      }
      const b = now.getBoundingClientRect();
      const cy = (r) => (r.top + r.bottom) / 2, cx = (r) => (r.left + r.right) / 2;
      // Landed the wrong way: ↓ going up, ↑ going down, ← going right on the same row (and the reverse).
      const wrong = (dir === 'down' && cy(b) < cy(a) - 4) || (dir === 'up' && cy(b) > cy(a) + 4)
        || (dir === 'left' && cx(b) > cx(a) + 4 && overlapV(b) && that.length) || (dir === 'right' && cx(b) < cx(a) - 4 && overlapV(b) && that.length);
      // ←/→ with something level that way, but went to another row instead.
      // (← into a side menu lands on the page you're on, on purpose.)
      const skipped = (dir === 'left' || dir === 'right') && that.length && !overlapV(b) && !(now.closest('.menu') && now.classList.contains('on'));
      if (wrong || skipped) problems.push({ dir, from: label(el), to: label(now), there: that.length ? label(that[0].x) : '', kind: wrong ? 'wrong way' : 'left the row' });
    }
  }
  return { screen: opts.title || screen, items: start.length, checked: max, problems };
};

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-nav-'));
  const core = new DvrCore({ dataDir: path.join(dir, 'data'), demo: true });
  core.updateSettings({ recordingsDir: path.join(dir, 'rec') });
  await core.init();
  // Something in each list: a couple of recordings and a timer.
  const now = Date.now();
  core.store.write('recordings', ['Evening News', 'Evening News', 'Cooking Show', 'Old Movie'].map((t, i) => ({
    id: `r${i}`, title: t, subtitle: i === 1 ? 'Tuesday' : '', channelNumber: '2.1', channelName: 'Practice', start: now - (i + 1) * 864e5, end: now - (i + 1) * 864e5 + 18e5,
    recordedAt: now - (i + 1) * 864e5, finishedAt: now - (i + 1) * 864e5 + 18e5, file: path.join(dir, `${i}.ts`), size: 1e9, status: 'complete', position: 0, watched: false, simulated: true, commercials: [],
  })));
  core.store.write('favlists', [{ id: 'fav1', name: "Gary's Favorites", channelIds: [] }]);
  const server = createServer(core);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const settings = ['sources', 'guide', 'channels', 'startup', 'recording', 'media', 'teams', 'xfinity', 'arlo', 'cta', 'remote', 'updates', 'backup', 'status'];
  const screens = [
    ['home'], ['guide', { max: 40 }], ['dvr'], ['timers'], ['movies'], ['shows'], ['arlo'], ['search'],
    ...settings.map((s) => [`settings:${s}`]),
    ['home', { title: 'Home > menu (M)', modal: 'App.menu()' }],
    ['dvr', { title: 'My Recordings > a recording', modal: "DvrView.recordingMenu(App.recordings.find((r) => r.title === 'Cooking Show'))" }],
    ['dvr', { title: 'My Recordings > Add a video or DVD', modal: 'DvrView.addVideo()' }],
  ];
  let total = 0;
  for (const size of SIZES) {
    const win = new BrowserWindow({ show: false, width: size.w, height: size.h, useContentSize: true, webPreferences: { backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    win.webContents.on('render-process-gone', (e, d) => console.log('page crashed:', d.reason));
    win.webContents.on('did-navigate', (e, u) => console.log('page loaded', u));
    await win.loadURL(base);
    if (size.tv) {
      await win.webContents.insertCSS(TV_CSS);
      await win.webContents.executeJavaScript("document.documentElement.classList.add('tv','firetv')");
    }
    await win.webContents.executeJavaScript('new Promise((r) => { const t = setInterval(() => { if (typeof App !== "undefined" && App.state) { clearInterval(t); r(); } }, 50); })');
    console.log(`\n=== ${size.name} ===`);
    for (const [screen, o = {}] of screens) {
      const opts = { max: o.max, title: o.title };
      const modal = o.modal ? `async () => { ${o.modal}; }` : 'null';
      const r = await win.webContents.executeJavaScript(`(${AUDIT.toString()})(${JSON.stringify(screen)}, { ...${JSON.stringify(opts)}, modal: ${modal} })`).catch((e) => ({ screen, error: e.message }));
      if (r.error) { console.log(`${screen}: couldn't check (${r.error})`); continue; }
      total += r.problems.length;
      console.log(`${r.screen}: ${r.checked}/${r.items} items, ${r.problems.length ? `${r.problems.length} problem(s)` : 'ok'}`);
      for (const p of r.problems) console.log(`   ${p.kind.padEnd(12)} ${p.dir.padEnd(5)} from ${p.from}${p.to ? ` -> ${p.to}` : ''}${p.there ? `   (that way: ${p.there})` : ''}`);
    }
    win.destroy();
  }
  console.log(`\n${total} problem(s) in all.`);
  server.close();
  await core.shutdown();
  app.exit(total ? 1 : 0);
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => { /* keep going between sizes */ });
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(2); });
