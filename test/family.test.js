const test = require('node:test');
const assert = require('node:assert');
const { Family } = require('../src/core/family');

// Made-up logins for the tests only.
const env = {
  FAMILY_CODE: '482915',
  IPTV_NAME: 'Home plan', IPTV_SERVERS: 'http://a.example', IPTV_USERNAME: 'u1', IPTV_PASSWORD: 'p1',
  IPTV2_SERVERS: 'http://b.example', IPTV2_USERNAME: 'u2', IPTV2_PASSWORD: 'p2', IPTV2_FAMILY: 'no',
  FAMILY1_NAME: 'Prime', FAMILY1_SERVERS: 'http://c.example http://d.example', FAMILY1_USERNAME: 'u3', FAMILY1_PASSWORD: 'p3',
  FAMILY2_NAME: 'Half', FAMILY2_USERNAME: 'u4', // no server or password: left out
};
const req = (ip) => ({ socket: { remoteAddress: ip } });
const core = (sources = []) => ({ settings: {}, sources, note() {}, addSource: async (s) => { sources.push(s); return s; } });

test('family accounts: offered with the code, only on TapperVPN or at home', () => {
  const f = new Family(core(), { env });
  assert.deepEqual(f.offer(req('100.64.0.7'), { code: '482915' }).accounts.map((a) => a.name), ['Prime', 'Home plan']);
  const one = f.offer(req('::ffff:100.64.0.7'), { code: ' 482915 ', id: 'family1' });
  assert.equal(one.config.username, 'u3');
  assert.throws(() => f.offer(req('203.0.113.9'), { code: '482915' }), /Not available/); // the internet
  assert.throws(() => f.offer(req('100.64.0.7'), { code: '000000' }), /isn't right/);
  assert.throws(() => new Family(core(), { env: { ...env, FAMILY_CODE: '123' } }).offer(req('100.64.0.7'), { code: '123' }), /Not available/); // too short a code: off
});

test('family accounts: wrong codes are limited per address and overall', () => {
  const f = new Family(core(), { env });
  for (let i = 0; i < 5; i++) assert.throws(() => f.offer(req('100.64.0.8'), { code: 'nope' }), /isn't right/);
  assert.throws(() => f.offer(req('100.64.0.8'), { code: '482915' }), /Too many/); // even the right one, for a while
  assert.ok(f.offer(req('100.64.0.9'), { code: '482915' }).accounts.length);
  for (let i = 10; i < 25; i++) try { f.offer(req(`100.64.1.${i}`), { code: 'nope' }); } catch (_) { /* wrong */ }
  assert.throws(() => f.offer(req('100.64.0.9'), { code: '482915' }), /Too many/);
});

test('family accounts: another GarysTV lists and adds one, once', async () => {
  const tapper = new Family(core(), { env });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    try { const data = tapper.offer(req('100.64.0.5'), JSON.parse(opts.body)); return { ok: true, json: async () => data }; } catch (e) { return { ok: false, status: e.status, json: async () => ({ error: e.message }) }; }
  };
  const sources = [];
  const here = new Family(core(sources), { env: {}, fetchImpl });
  assert.deepEqual((await here.list('482915')).map((a) => [a.name, a.added]), [['Prime', false], ['Home plan', false]]);
  assert.deepEqual(await here.add('482915', 'family1'), { name: 'Prime' });
  assert.deepEqual([sources[0].type, sources[0].config.servers, sources[0].config.family], ['xtream', 'http://c.example http://d.example', 'family1']);
  assert.equal((await here.add('482915', 'family1')).already, true);
  assert.equal(sources.length, 1);
  await here.add('482915', 'iptv'); // a second login: numbered from the next thousand
  assert.deepEqual(sources.map((s) => s.config.firstNumber), ['', '2000']);
  sources.pop();
  assert.equal((await here.list('482915'))[0].added, true);
  await assert.rejects(here.list('bad'), /isn't right/);
  assert.ok(calls.every((u) => u === 'http://100.64.0.2:5480/api/family/offer'));
  const off = new Family(core(), { env: {}, fetchImpl: async () => { throw new Error('connect ETIMEDOUT'); } });
  await assert.rejects(off.list('482915'), /Not available/); // not on TapperVPN
});

test('family accounts: tapper\'s secrets file is read on each ask', () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(require('os').tmpdir(), `gtv-family-${process.pid}.env`);
  fs.writeFileSync(file, '# made up\nFAMILY_CODE="482915"\nFAMILY1_NAME="Prime \\"West\\""\nFAMILY1_SERVERS="http://c.example http://d.example"\nFAMILY1_USERNAME=u3\nFAMILY1_PASSWORD="p\\\\3$x"\n');
  const f = new Family(core(), { env: {}, secretsFile: file });
  const one = f.offer(req('100.64.0.7'), { code: '482915', id: 'family1' });
  assert.deepEqual([one.name, one.config.servers, one.config.password], ['Prime "West"', 'http://c.example http://d.example', 'p\\3$x']);
  fs.appendFileSync(file, 'FAMILY2_NAME=Second\nFAMILY2_SERVERS=http://e.example\nFAMILY2_USERNAME=u5\nFAMILY2_PASSWORD=p5\n');
  assert.equal(f.offer(req('100.64.0.7'), { code: '482915' }).accounts.length, 2); // no restart needed
  fs.unlinkSync(file);
});

test('family accounts: the secret menu\'s status says what\'s offered and if a code is set, never the code or a login', async () => {
  const ping = async () => ({ ok: true, json: async () => ({ app: 'GarysTV', name: 'frank' }) });
  const s = await new Family(core(), { env, fetchImpl: ping }).status();
  assert.deepEqual(s, { server: 'http://100.64.0.2:5480', reachable: true, serverName: 'frank', offers: { accounts: ['Prime', 'Home plan'], codeSet: true } });
  assert.ok(!/482915|p1|p3|u1|u3/.test(JSON.stringify(s)));
  const { FAMILY_CODE, ...noCode } = env;
  const off = await new Family(core(), { env: noCode, fetchImpl: async () => { throw new Error('timeout'); } }).status();
  assert.deepEqual([off.reachable, off.offers.codeSet], [false, false]);
  const signIn = async () => ({ ok: false, status: 401, json: async () => ({ error: 'Sign in first.', login: true }) }); // tapper, seen from another location
  assert.equal((await new Family(core(), { env, fetchImpl: signIn }).status()).reachable, true);
});
