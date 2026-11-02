const test = require('node:test');
const assert = require('node:assert');
const { parseDetect, breakpoints, findBreaks } = require('../src/core/commercials');

test('parses ffmpeg black and silence lines', () => {
  const log = `[blackdetect @ 0] black_start:90.0 black_end:90.5 black_duration:0.5
[silencedetect @ 0] silence_start: 89.9
[silencedetect @ 0] silence_end: 90.6 | silence_duration: 0.7
[blackdetect @ 0] black_start:300 black_end:300.4 black_duration:0.4`;
  const d = parseDetect(log);
  assert.deepStrictEqual(d.black, [[90, 90.5], [300, 300.4]]);
  assert.deepStrictEqual(d.silence, [[89.9, 90.6]]);
  assert.deepStrictEqual(breakpoints(d), [90.25]); // the black at 300 had sound: a scene change, not a break
});

test('a run of ad-length gaps is a break', () => {
  // show, then ads of 30, 15, 15, 30, 60 seconds, then show again
  assert.deepStrictEqual(findBreaks([10, 600, 630, 645, 660, 690, 750, 1400]), [{ start: 600, end: 750 }]);
});

test('show fades are not breaks', () => {
  assert.deepStrictEqual(findBreaks([100, 230, 410, 600]), []); // too far apart
  assert.deepStrictEqual(findBreaks([100, 130]), []); // one "ad" is not a break
  assert.deepStrictEqual(findBreaks([100, 137, 171, 208]), []); // close together, but not ad lengths
});

test('a fade just before the break is trimmed off', () => {
  assert.deepStrictEqual(findBreaks([500, 507, 537, 552, 582]), [{ start: 507, end: 582 }]);
});
