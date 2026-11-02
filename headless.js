// The DVR engine without the Windows window or tray, for an always-on home server
// (Linux, run by systemd). TVs, tablets and the Windows app use its screens over
// the home network.
//   node headless.js --data=/var/lib/garystv [--recordings=DIR] [--port=5480] [--demo]
const path = require('path');
const { DvrCore } = require('./src/core');
const { createServer } = require('./src/core/server');

const args = process.argv.slice(2);
const flag = (name) => { const a = args.find((x) => x.startsWith(`--${name}`)); return a ? (a.split('=')[1] ?? true) : null; };

// IPTV logins from the server's secrets file (/etc/garystv/secrets.env, loaded by systemd as
// environment variables), so they never have to be typed into a TV or kept in the code:
//   IPTV_NAME=Prime   IPTV_SERVERS="http://a.com http://b.com"   IPTV_USERNAME=...   IPTV_PASSWORD=...
// More accounts: IPTV2_..., IPTV3_... Each becomes an "IPTV provider" source, added on first
// start and updated when the file changes; groups, numbering and stream limit come along if set.
async function applySecrets(core) {
  const prefixes = Object.keys(process.env).map((k) => (/^(IPTV\d*)_USERNAME$/.exec(k) || [])[1]).filter(Boolean).sort();
  for (const pre of prefixes) {
    const env = (k) => (process.env[`${pre}_${k}`] || '').trim();
    if (!env('USERNAME') || !env('PASSWORD') || !env('SERVERS')) { core.note(`secrets: ${pre} needs SERVERS, USERNAME and PASSWORD`); continue; }
    const config = { servers: env('SERVERS'), username: env('USERNAME'), password: env('PASSWORD'), groups: env('GROUPS'), firstNumber: env('FIRST_NUMBER'), maxStreams: env('MAX_STREAMS'), fromSecrets: pre };
    const name = env('NAME') || (pre === 'IPTV' ? 'IPTV' : `IPTV ${pre.slice(4)}`);
    const existing = core.sources.find((s) => s.type === 'xtream' && s.config.fromSecrets === pre);
    try {
      if (!existing) {
        await core.addSource({ type: 'xtream', name, config });
        core.note(`secrets: added ${name}`);
      } else if (Object.keys(config).some((k) => (existing.config[k] || '') !== config[k]) || existing.name !== name) {
        await core.updateSource(existing.id, { name, config });
        core.note(`secrets: updated ${name}`);
      } else if (/^Problem/.test(existing.info || '')) {
        await core.scanSource(existing.id); // the provider was down last time; try again
      }
    } catch (e) {
      core.note(`secrets: ${name}: ${e.message}`);
    }
  }
}

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
  await applySecrets(core);

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
