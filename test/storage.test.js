const test = require('node:test');
const assert = require('node:assert');
const { clean, explain } = require('../src/core/storage');

// Network storage: what's typed in Settings goes to Windows' commands or (on the home server) to
// a helper running as root, so anything odd is turned away before that.
test('Network storage settings are checked', () => {
  assert.deepEqual(clean({ type: 'smb', server: ' 192.168.1.50 ', share: '\\Recordings\\', folder: 'GarysTV/TV', username: 'gary', password: 'p@ss word' }),
    { type: 'smb', server: '192.168.1.50', share: 'Recordings', folder: 'GarysTV/TV', username: 'gary', password: 'p@ss word' });
  assert.equal(clean({ server: '\\\\mynas\\share', share: 'tv' }).server, 'mynas'); // pasted \\mynas\share
  assert.equal(clean({ type: 'nfs', server: 'nas.local', share: '/volume1/recordings' }).share, '/volume1/recordings');
  for (const bad of [
    { server: 'nas;rm -rf /', share: 'tv' },
    { server: 'nas', share: 'tv/../../etc' },
    { server: 'nas', share: 'a b' },
    { type: 'nfs', server: 'nas', share: '/x/../etc' },
    { type: 'nfs', server: 'nas', share: 'relative' },
    { server: 'nas', share: 'tv', folder: '../up' },
    { server: 'nas', share: 'tv', username: 'a\nb' },
    { server: 'nas', share: 'tv', password: 'line1\nusername=root' },
    { server: '', share: 'tv' },
  ]) assert.throws(() => clean(bad), JSON.stringify(bad));
});

test('What the NAS said is put in plain words', () => {
  assert.match(explain('mount error(13): Permission denied'), /username and password/);
  assert.match(explain('System error 53 has occurred.'), /Couldn't reach/);
  assert.match(explain('mount error(2): No such file or directory'), /no share by that name/);
  assert.doesNotMatch(explain('Couldn\'t connect to //192.168.1.53/tv.'), /reach the NAS/); // a number in an address isn't an error code
});
