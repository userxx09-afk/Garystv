const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// $() gives one element and $$() a list (src/ui/common.js). A list method on $() throws, and
// a screen that throws stops halfway: its buttons and boxes are drawn but do nothing.
test('screens use $$ (not $) for lists of elements', () => {
  const dir = path.join(__dirname, '..', 'src', 'ui');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/(^|[^$\w])\$\([^()]*\)\.(forEach|filter|map|some|find)\(/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
