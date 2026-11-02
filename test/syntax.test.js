const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// The screens aren't loaded by the other tests, so a typo there would only show up on the TV.
test('Every screen script parses', () => {
  const dirs = [path.join(__dirname, '..', 'src', 'ui'), path.join(__dirname, '..', 'tizen')];
  const files = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.js') && f !== 'build.js').map((f) => path.join(d, f)));
  for (const f of files) assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }), path.basename(f));
});
