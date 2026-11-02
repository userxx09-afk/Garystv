// HDHomeRun network antenna tuners (SiliconDust). These are the simplest
// reliable way to get over-the-air TV onto a Windows PC: the tuner sits on the
// network and serves each channel as a plain MPEG-TS stream over HTTP.
const dgram = require('dgram');
const zlib = require('zlib');

function crc32(buf) {
  // zlib.crc32 exists on Node >= 22; fall back to a table implementation.
  if (zlib.crc32) return zlib.crc32(buf) >>> 0;
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// UDP broadcast discovery (libhdhomerun protocol, port 65001).
function discoverUdp(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    const payload = Buffer.from([0x01, 0x04, 0x00, 0x00, 0x00, 0x01, 0x02, 0x04, 0xff, 0xff, 0xff, 0xff]);
    const pkt = Buffer.alloc(4 + payload.length + 4);
    pkt.writeUInt16BE(0x0002, 0);
    pkt.writeUInt16BE(payload.length, 2);
    payload.copy(pkt, 4);
    pkt.writeUInt32LE(crc32(pkt.subarray(0, 4 + payload.length)), 4 + payload.length);
    sock.on('message', (msg, rinfo) => {
      if (msg.length < 8 || msg.readUInt16BE(0) !== 0x0003) return;
      found.set(rinfo.address, { host: rinfo.address });
    });
    sock.on('error', () => { try { sock.close(); } catch (_) {} resolve([...found.values()]); });
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(pkt, 65001, '255.255.255.255');
    });
    setTimeout(() => { try { sock.close(); } catch (_) {} resolve([...found.values()]); }, timeoutMs);
  });
}

async function discoverCloud() {
  try {
    const res = await fetch('https://ipv4-api.hdhomerun.com/discover', { signal: AbortSignal.timeout(4000) });
    const list = await res.json();
    return list.filter((d) => d.LocalIP).map((d) => ({ host: d.LocalIP }));
  } catch (_) {
    return [];
  }
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

const base = (host) => (/^https?:\/\//.test(host) ? host : `http://${host}`).replace(/\/$/, '');

module.exports = {
  type: 'hdhomerun',
  label: 'Antenna tuner (HDHomeRun)',
  fields: [{ key: 'host', label: 'Tuner IP address (leave blank to auto-find)', placeholder: '192.168.1.50' }],

  async discover() {
    const udp = await discoverUdp();
    return udp.length ? udp : discoverCloud();
  },

  async resolveHost(config) {
    if (config.host) return config.host;
    const found = await this.discover();
    if (!found.length) throw new Error('No HDHomeRun tuner found on the network. Enter its IP address in Settings.');
    return found[0].host;
  },

  async scan(config) {
    const host = await this.resolveHost(config);
    const info = await getJson(`${base(host)}/discover.json`);
    const lineup = await getJson(info.LineupURL || `${base(host)}/lineup.json`);
    return {
      config: { ...config, host, deviceAuth: info.DeviceAuth, deviceId: info.DeviceID },
      tunerCount: info.TunerCount || 2,
      info: `${info.FriendlyName || 'HDHomeRun'} ${info.ModelNumber || ''} (${info.TunerCount || '?'} tuners)`.trim(),
      channels: lineup
        .filter((c) => !c.DRM)
        .map((c) => ({
          key: c.GuideNumber,
          number: c.GuideNumber,
          name: c.GuideName,
          callsign: c.GuideName,
          hd: !!c.HD,
          streamUrl: c.URL,
        })),
    };
  },

  // Re-scan the antenna for channels (as you adjust the antenna, run this again).
  async startAntennaScan(config) {
    const host = await this.resolveHost(config);
    const res = await fetch(`${base(host)}/lineup.post?scan=start&source=Antenna`, { method: 'POST' });
    if (!res.ok) throw new Error(`Tuner refused scan (${res.status})`);
  },

  async antennaScanStatus(config) {
    const host = await this.resolveHost(config);
    return getJson(`${base(host)}/lineup_status.json`);
  },
};
