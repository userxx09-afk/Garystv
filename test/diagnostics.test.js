const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Diagnostics, verdict, serverEvidence, classifyError } = require('../src/core/diagnostics');

const srv = (o = {}) => ({ ...serverEvidence(null, 0, 0), ...o });
const cli = (o = {}) => ({ stalls: 0, stallMs: 0, stallsWithBuffer: 0, fragLoads: 100, slowFrags: 0, fragErrors: 0, mediaErrors: 0, dropped: 0, frames: 10000, appErrors: 0, ...o });

test('smooth playback', () => {
  assert.equal(verdict(srv(), cli()).level, 'ok');
});

test('a stream that keeps dropping is the source, not GarysTV', () => {
  const v = verdict(srv({ drops: 3, sourceDrops: 3, reasons: ['Connection reset by peer'] }), cli({ stalls: 3, stallMs: 9000 }));
  assert.equal(v.cause, 'source');
  assert.equal(v.level, 'problem');
  assert.match(v.evidence.join(' '), /Connection reset/);
});

test('falling behind while converting on a busy processor is the computer', () => {
  assert.equal(verdict(srv({ behindServer: 4, cpuMax: 97, transcoding: true }), cli({ stalls: 2, stallMs: 4000 }), 'WORKSTATION').cause, 'server');
});

test('slow downloads to the TV are the network', () => {
  assert.equal(verdict(srv(), cli({ stalls: 2, stallMs: 3000, slowFrags: 12, fragErrors: 1 })).cause, 'network');
});

test('stutters with video waiting on the TV are the player', () => {
  const v = verdict(srv(), cli({ stalls: 3, stallMs: 5000, stallsWithBuffer: 3 }));
  assert.equal(v.cause, 'player');
  assert.equal(v.level, 'problem');
});

test('ffmpeg errors: network trouble is the source, anything else is internal', () => {
  assert.equal(classifyError('Connection timed out'), 'source');
  assert.equal(classifyError('Server returned 404 Not Found'), 'source');
  assert.equal(classifyError(''), 'source');
  assert.equal(classifyError('Error initializing output stream 0:0 -- Error while opening encoder'), 'internal');
});

test('keeping up with real time, from ffmpeg progress', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-diag-'));
  const notes = [];
  const store = { read: (k, f) => f, writeSoon: () => Promise.resolve(), dir };
  const d = new Diagnostics({ store, note: (m) => notes.push(m), channels: [] });
  const realNow = Date.now;
  let now = 1e12;
  Date.now = () => now;
  try {
    d.cpu = 20;
    d.bufferStarted('ch1', ['-i', 'x', '-c:v', 'copy']);
    d.progress('ch1', 0);
    now += 10000; d.progress('ch1', 10e6); // 10s of video in 10s
    now += 10000; d.progress('ch1', 14e6); // only 4s in the next 10s
    d.bufferExited('ch1', 'Connection reset by peer');
    const ev = serverEvidence(d.channels.get('ch1'), 0, now);
    assert.deepEqual([ev.windows, ev.behindSource, ev.behindServer, ev.sourceDrops], [2, 1, 0, 1]);

    const r = d.report({ sid: 'abcd1234', device: 'Fort Madison bed fire', kind: 'live', channelId: 'ch1', name: '101 Test', started: 1e12, stalls: 2, stallMs: 4000, fragLoads: 10, frames: 600 }, '::ffff:192.168.1.50');
    assert.equal(r.cause, 'source');
    now += 60000;
    d.report({ sid: 'abcd1234', final: true, stalls: 2, stallMs: 4000, fragLoads: 10, frames: 600 });
    assert.equal(d.sessions.size, 0);
    assert.match(notes[0], /Fort Madison bed fire: 101 Test for 1 min: Poor stream/);
    assert.throws(() => d.report({ sid: '../bad' }), /Bad report/);
  } finally {
    Date.now = realNow;
    d.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
