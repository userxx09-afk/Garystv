// The DVR engine without the Windows window or tray, for an always-on home server
// (Linux, run by systemd). TVs, tablets and the Windows app use its screens over
// the home network.
//   node headless.js --data=/var/lib/garystv [--recordings=DIR] [--port=5480] [--demo]
const path = require('path');
const { DvrCore } = require('./src/core');
const { createServer } = require('./src/core/server');

const args = process.argv.slice(2);
const flag = (name) => { const a = args.find((x) => x.startsWith(`--${name}`)); return a ? (a.split('=')[1] ?? true) : null; };

async function main() {
  const dataDir = flag('data') || path.join(require('os').homedir(), '.garystv');
  const core = new DvrCore({ dataDir, demo: !!flag('demo') });
  // --recordings sets the folder on first start; after that Settings > Recording can change it.
  if (flag('recordings') && !core.store.read('settings', {}).recordingsDir) core.updateSettings({ recordingsDir: flag('recordings') });
  await core.init();
  // A server is there to be reached from the TVs, so it always listens on the home network
  // (server.js still refuses callers from outside it).
  const port = +(flag('port') || core.settings.port);
  const server = createServer(core);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  core.note(`GarysTV engine listening on port ${port} (data: ${dataDir}, recordings: ${core.settings.recordingsDir})`);

  // systemd stop / Ctrl-C: let recordings finish writing, then exit.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await core.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
